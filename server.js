/**
 * server.js
 *
 * 14 Central server for the smart greenhouse - multi-user, multi-greenhouse version.
 * - Data lives in Supabase (Postgres) instead of a local JSON file, so nothing is
 *   lost when Render restarts the service.
 * - Each greenhouse belongs to one user (owner_id) and has its own API key that
 *   its ESP32 device uses to identify itself.
 * - Frontend clients authenticate with a Supabase session token (JWT) and can
 *   only see/control greenhouses they own.
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");
const controlEngine = require("./controlEngine");

const PORT = process.env.PORT || 3001;
const TREND_WINDOW_MS = 10 * 60 * 1000; // look at the last 10 minutes for adaptive hysteresis

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- In-memory live state, one entry per greenhouse (cache backed by the DB) ----------------
// Map<greenhouseId, { sensorData, relayState, manualOverrides, activeProfileId, profiles, recentTemps, esp32Socket }>
const liveState = new Map();

const DEFAULT_PROFILES = [
    { name: "Tomato", temp_min: 18, temp_max: 27, humidity_min: 60, humidity_max: 70, soil_moisture_min: 60, soil_moisture_max: 80, light_hours_per_day: 14 },
    { name: "Cucumber", temp_min: 20, temp_max: 28, humidity_min: 70, humidity_max: 90, soil_moisture_min: 70, soil_moisture_max: 85, light_hours_per_day: 12 },
    { name: "Lettuce", temp_min: 15, temp_max: 22, humidity_min: 50, humidity_max: 70, soil_moisture_min: 60, soil_moisture_max: 75, light_hours_per_day: 10 },
    { name: "Bell Pepper", temp_min: 20, temp_max: 30, humidity_min: 50, humidity_max: 70, soil_moisture_min: 55, soil_moisture_max: 75, light_hours_per_day: 13 },
];

function randomApiKey() {
    return crypto.randomBytes(16).toString("hex");
}

function profileToClientShape(p) {
    if (!p) return null;
    return {
        id: p.id,
        name: p.name,
        tempMin: p.temp_min,
        tempMax: p.temp_max,
        humidityMin: p.humidity_min,
        humidityMax: p.humidity_max,
        soilMoistureMin: p.soil_moisture_min,
        soilMoistureMax: p.soil_moisture_max,
        lightHoursPerDay: p.light_hours_per_day,
    };
}

// ---------------- Auth middleware (verifies the Supabase session token) ----------------
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing authorization token" });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data ? .user) {
        console.error("Auth check failed:", error ? .message || "no user returned", error);
        return res.status(401).json({ error: "Invalid or expired session" });
    }

    req.userId = data.user.id;
    next();
}

// Confirms the greenhouse in the URL actually belongs to the logged-in user
async function requireOwnedGreenhouse(req, res, next) {
    const { data: gh, error } = await supabase
        .from("greenhouses")
        .select("*")
        .eq("id", req.params.id)
        .eq("owner_id", req.userId)
        .maybeSingle();
    if (error || !gh) return res.status(404).json({ error: "Greenhouse not found" });
    req.greenhouse = gh;
    next();
}

// ---------------- Load (and cache) a greenhouse's live state ----------------
async function loadGreenhouseState(greenhouseId) {
    if (liveState.has(greenhouseId)) return liveState.get(greenhouseId);

    const { data: state } = await supabase.from("greenhouse_state").select("*").eq("greenhouse_id", greenhouseId).maybeSingle();
    const { data: profiles } = await supabase.from("profiles").select("*").eq("greenhouse_id", greenhouseId);

    const entry = {
        sensorData: {
            temp: state ? .latest_temp ? ? null,
            humidity: state ? .latest_humidity ? ? null,
            soilMoisture: state ? .latest_soil_moisture ? ? null,
            lightLux: state ? .latest_light_lux ? ? null,
            waterLevel: state ? .latest_water_level ? ? null,
            updatedAt: state ? .updated_at ? ? null,
        },
        relayState: {
            fan: state ? .relay_fan ? ? false,
            heater: state ? .relay_heater ? ? false,
            pump: state ? .relay_pump ? ? false,
        },
        manualOverrides: {
            fan: state ? .manual_fan ? ? null,
            heater: state ? .manual_heater ? ? null,
            pump: state ? .manual_pump ? ? null,
        },
        activeProfileId: state ? .active_profile_id ? ? profiles ? .[0] ? .id ? ? null,
        profiles: profiles || [],
        recentTemps: [], // short in-memory buffer for the adaptive-hysteresis trend calculation
        esp32Socket: null,
    };
    liveState.set(greenhouseId, entry);
    return entry;
}

function getActiveProfile(entry) {
    return entry.profiles.find((p) => p.id === entry.activeProfileId) || entry.profiles[0] || null;
}

function getRecentAvgTemp(entry) {
    const cutoff = Date.now() - TREND_WINDOW_MS;
    const recent = entry.recentTemps.filter((r) => r.at >= cutoff);
    if (recent.length === 0) return null;
    return recent.reduce((sum, r) => sum + r.temp, 0) / recent.length;
}

function isDaytimeNow(sensorData) {
    if (typeof sensorData.lightLux === "number") return sensorData.lightLux > 200;
    const hour = new Date().getHours();
    return hour >= 7 && hour < 19;
}

// ---------------- Run the decision engine for one greenhouse ----------------
async function runControlCycle(greenhouseId) {
    const entry = await loadGreenhouseState(greenhouseId);
    const profile = getActiveProfile(entry);
    if (!profile) return;

    const context = { recentAvgTemp: getRecentAvgTemp(entry), isDaytime: isDaytimeNow(entry.sensorData) };
    const profileForEngine = {
        tempMin: profile.temp_min,
        tempMax: profile.temp_max,
        humidityMin: profile.humidity_min,
        humidityMax: profile.humidity_max,
        soilMoistureMin: profile.soil_moisture_min,
        soilMoistureMax: profile.soil_moisture_max,
    };

    const { relayState, reasons } = controlEngine.evaluate(
        entry.sensorData,
        profileForEngine,
        entry.relayState,
        entry.manualOverrides,
        context
    );
    entry.relayState = relayState;

    // Write-through to the database (fire and forget - doesn't block the control loop)
    supabase
        .from("greenhouse_state")
        .upsert({
            greenhouse_id: greenhouseId,
            active_profile_id: entry.activeProfileId,
            relay_fan: relayState.fan,
            relay_heater: relayState.heater,
            relay_pump: relayState.pump,
            manual_fan: entry.manualOverrides.fan,
            manual_heater: entry.manualOverrides.heater,
            manual_pump: entry.manualOverrides.pump,
            latest_temp: entry.sensorData.temp,
            latest_humidity: entry.sensorData.humidity,
            latest_soil_moisture: entry.sensorData.soilMoisture,
            latest_light_lux: entry.sensorData.lightLux,
            latest_water_level: entry.sensorData.waterLevel,
            updated_at: entry.sensorData.updatedAt,
        })
        .then(({ error }) => {
            if (error) console.error("Failed to persist greenhouse_state:", error.message);
        });

    broadcastToESP32(greenhouseId, { type: "command", relays: relayState });
    broadcastToFrontend(greenhouseId, {
        type: "status_update",
        sensorData: entry.sensorData,
        relayState,
        reasons,
        activeProfile: profileToClientShape(profile),
    });
}

function broadcastToESP32(greenhouseId, payload) {
    const entry = liveState.get(greenhouseId);
    if (entry ? .esp32Socket ? .readyState === 1) {
        entry.esp32Socket.send(JSON.stringify(payload));
    }
}

function broadcastToFrontend(greenhouseId, payload) {
    wss.clients.forEach((client) => {
        if (client.isFrontend && client.greenhouseId === greenhouseId && client.readyState === 1) {
            client.send(JSON.stringify(payload));
        }
    });
}

// ---------------- WebSocket connection handling ----------------
wss.on("connection", (ws) => {
    ws.isFrontend = false;
    ws.isESP32 = false;
    ws.greenhouseId = null;

    ws.on("message", async(raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return; // invalid message, ignore it
        }

        if (msg.type === "identify") {
            if (msg.role === "esp32") {
                const { data: gh } = await supabase.from("greenhouses").select("id").eq("api_key", msg.apiKey).maybeSingle();
                if (!gh) {
                    ws.send(JSON.stringify({ type: "error", message: "Invalid API key" }));
                    ws.close();
                    return;
                }
                ws.isESP32 = true;
                ws.greenhouseId = gh.id;
                const entry = await loadGreenhouseState(gh.id);
                entry.esp32Socket = ws;
                console.log(`✅ ESP32 connected for greenhouse ${gh.id}`);
            } else if (msg.role === "frontend") {
                const { data: userData, error: userError } = await supabase.auth.getUser(msg.token);
                if (userError || !userData ? .user) {
                    ws.send(JSON.stringify({ type: "error", message: "Invalid session" }));
                    ws.close();
                    return;
                }
                const { data: gh } = await supabase
                    .from("greenhouses")
                    .select("id")
                    .eq("id", msg.greenhouseId)
                    .eq("owner_id", userData.user.id)
                    .maybeSingle();
                if (!gh) {
                    ws.send(JSON.stringify({ type: "error", message: "Greenhouse not found" }));
                    ws.close();
                    return;
                }
                ws.isFrontend = true;
                ws.greenhouseId = gh.id;
                const entry = await loadGreenhouseState(gh.id);
                ws.send(
                    JSON.stringify({
                        type: "status_update",
                        sensorData: entry.sensorData,
                        relayState: entry.relayState,
                        activeProfile: profileToClientShape(getActiveProfile(entry)),
                    })
                );
            }
            return;
        }

        if (msg.type === "sensor_data" && ws.isESP32 && ws.greenhouseId) {
            const entry = await loadGreenhouseState(ws.greenhouseId);
            entry.sensorData = {...msg.data, updatedAt: new Date().toISOString() };

            if (typeof msg.data.temp === "number") {
                entry.recentTemps.push({ temp: msg.data.temp, at: Date.now() });
                entry.recentTemps = entry.recentTemps.filter((r) => r.at >= Date.now() - TREND_WINDOW_MS);
            }

            supabase
                .from("sensor_history")
                .insert({
                    greenhouse_id: ws.greenhouseId,
                    temp: msg.data.temp,
                    humidity: msg.data.humidity,
                    soil_moisture: msg.data.soilMoisture,
                    light_lux: msg.data.lightLux,
                    water_level: msg.data.waterLevel,
                })
                .then(({ error }) => {
                    if (error) console.error("Failed to log sensor_history:", error.message);
                });

            await runControlCycle(ws.greenhouseId);
        }
    });

    ws.on("close", () => {
        if (ws.isESP32 && ws.greenhouseId) {
            const entry = liveState.get(ws.greenhouseId);
            if (entry && entry.esp32Socket === ws) entry.esp32Socket = null;
            console.log(`❌ ESP32 disconnected for greenhouse ${ws.greenhouseId}`);
        }
    });
});

// ---------------- REST API ----------------

// List greenhouses owned by the logged-in user
app.get("/api/greenhouses", requireAuth, async(req, res) => {
    const { data, error } = await supabase
        .from("greenhouses")
        .select("id, name, api_key, created_at")
        .eq("owner_id", req.userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Create a new greenhouse, auto-seeded with the default crop profiles
app.post("/api/greenhouses", requireAuth, async(req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const { data: gh, error } = await supabase
        .from("greenhouses")
        .insert({ owner_id: req.userId, name, api_key: randomApiKey() })
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    const seedRows = DEFAULT_PROFILES.map((p) => ({...p, greenhouse_id: gh.id }));
    const { data: profiles, error: profileError } = await supabase.from("profiles").insert(seedRows).select();
    if (profileError) return res.status(500).json({ error: profileError.message });

    await supabase.from("greenhouse_state").insert({ greenhouse_id: gh.id, active_profile_id: profiles[0].id });

    res.json({...gh, profiles: profiles.map(profileToClientShape) });
});

// Live status for one greenhouse
app.get("/api/greenhouses/:id/status", requireAuth, requireOwnedGreenhouse, async(req, res) => {
    const entry = await loadGreenhouseState(req.params.id);
    res.json({
        sensorData: entry.sensorData,
        relayState: entry.relayState,
        manualOverrides: entry.manualOverrides,
        activeProfile: profileToClientShape(getActiveProfile(entry)),
        esp32Connected: !!entry.esp32Socket,
    });
});

// Sensor history for the chart
app.get("/api/greenhouses/:id/history", requireAuth, requireOwnedGreenhouse, async(req, res) => {
    const { data, error } = await supabase
        .from("sensor_history")
        .select("*")
        .eq("greenhouse_id", req.params.id)
        .order("recorded_at", { ascending: false })
        .limit(500);
    if (error) return res.status(500).json({ error: error.message });
    res.json(
        data.reverse().map((h) => ({
            temp: h.temp,
            humidity: h.humidity,
            soilMoisture: h.soil_moisture,
            lightLux: h.light_lux,
            waterLevel: h.water_level,
            updatedAt: h.recorded_at,
        }))
    );
});

// List crop profiles for one greenhouse
app.get("/api/greenhouses/:id/profiles", requireAuth, requireOwnedGreenhouse, async(req, res) => {
    const { data, error } = await supabase.from("profiles").select("*").eq("greenhouse_id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map(profileToClientShape));
});

// Add or edit a crop profile (send an "id" field to edit an existing one)
app.post("/api/greenhouses/:id/profiles", requireAuth, requireOwnedGreenhouse, async(req, res) => {
    const b = req.body;
    const row = {
        greenhouse_id: req.params.id,
        name: b.name,
        temp_min: b.tempMin,
        temp_max: b.tempMax,
        humidity_min: b.humidityMin,
        humidity_max: b.humidityMax,
        soil_moisture_min: b.soilMoistureMin,
        soil_moisture_max: b.soilMoistureMax,
        light_hours_per_day: b.lightHoursPerDay,
    };

    const query = b.id ?
        supabase.from("profiles").update(row).eq("id", b.id).eq("greenhouse_id", req.params.id).select().single() :
        supabase.from("profiles").insert(row).select().single();

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const entry = await loadGreenhouseState(req.params.id);
    const idx = entry.profiles.findIndex((p) => p.id === data.id);
    if (idx >= 0) entry.profiles[idx] = data;
    else entry.profiles.push(data);

    res.json(profileToClientShape(data));
});

// Delete a crop profile
app.delete("/api/greenhouses/:id/profiles/:profileId", requireAuth, requireOwnedGreenhouse, async(req, res) => {
    const { error } = await supabase
        .from("profiles")
        .delete()
        .eq("id", req.params.profileId)
        .eq("greenhouse_id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    const entry = await loadGreenhouseState(req.params.id);
    entry.profiles = entry.profiles.filter((p) => p.id !== req.params.profileId);
    res.json({ success: true });
});

// Set the active crop for one greenhouse
app.post("/api/greenhouses/:id/profiles/active", requireAuth, requireOwnedGreenhouse, async(req, res) => {
    const { profileId } = req.body;
    const entry = await loadGreenhouseState(req.params.id);
    if (!entry.profiles.find((p) => p.id === profileId)) return res.status(404).json({ error: "Profile not found" });
    entry.activeProfileId = profileId;
    await runControlCycle(req.params.id);
    res.json({ success: true, activeProfileId: profileId });
});

// Manual control / return to automatic mode for one greenhouse
// body: { relay: "fan" | "heater" | "pump", mode: "on" | "off" | "auto" }
app.post("/api/greenhouses/:id/control", requireAuth, requireOwnedGreenhouse, async(req, res) => {
    const { relay, mode } = req.body;
    if (!["fan", "heater", "pump"].includes(relay)) return res.status(400).json({ error: "Invalid relay name" });

    const entry = await loadGreenhouseState(req.params.id);
    if (mode === "auto") {
        entry.manualOverrides[relay] = null;
        entry.relayState[relay] = false; // re-evaluate fresh instead of inheriting the manual state
    } else if (mode === "on") {
        entry.manualOverrides[relay] = true;
    } else if (mode === "off") {
        entry.manualOverrides[relay] = false;
    } else {
        return res.status(400).json({ error: "mode must be on / off / auto" });
    }
    await runControlCycle(req.params.id);
    res.json({ success: true, manualOverrides: entry.manualOverrides });
});

server.listen(PORT, () => {
    console.log(`🌱 Greenhouse backend running on port ${PORT}`);
});