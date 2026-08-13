/**
 * server.js
 *
 * Central server for the smart greenhouse - multi-user, multi-greenhouse version.
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

// Small helper used instead of the `?.` / `??` operators, since those have
// caused copy-paste corruption issues in this environment.
function orDefault(obj, key, fallback) {
  if (!obj) return fallback;
  const v = obj[key];
  return v === undefined || v === null ? fallback : v;
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

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !(data && data.user)) {
    console.error("Auth check failed:", (error && error.message) || "no user returned", error);
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  req.userId = data.user.id;
  next();
}

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

async function requireAdmin(req, res, next) {
  const { data, error } = await supabase.from("admins").select("user_id").eq("user_id", req.userId).maybeSingle();
  if (error || !data) return res.status(403).json({ error: "Admin access required" });
  next();
}

async function loadGreenhouseState(greenhouseId) {
  if (liveState.has(greenhouseId)) return liveState.get(greenhouseId);

  const { data: state } = await supabase.from("greenhouse_state").select("*").eq("greenhouse_id", greenhouseId).maybeSingle();
  const { data: profiles } = await supabase.from("crop_profiles").select("*").eq("greenhouse_id", greenhouseId);

  const entry = {
    sensorData: {
      temp: orDefault(state, "latest_temp", null),
      humidity: orDefault(state, "latest_humidity", null),
      soilMoisture: orDefault(state, "latest_soil_moisture", null),
      lightLux: orDefault(state, "latest_light_lux", null),
      waterLevel: orDefault(state, "latest_water_level", null),
      waterFlow: orDefault(state, "latest_water_flow", null),
      waterUsedTotal: orDefault(state, "latest_water_used_total", null),
      waterTankPct: orDefault(state, "latest_water_tank_pct", null),
      windSpeed: orDefault(state, "latest_wind_speed", null),
      co2Ppm: orDefault(state, "latest_co2_ppm", null),
      outsideTemp: orDefault(state, "latest_outside_temp", null),
      updatedAt: orDefault(state, "updated_at", null),
    },
    relayState: {
      fan: orDefault(state, "relay_fan", false),
      heater: orDefault(state, "relay_heater", false),
      pump: orDefault(state, "relay_pump", false),
    },
    manualOverrides: {
      fan: orDefault(state, "manual_fan", null),
      heater: orDefault(state, "manual_heater", null),
      pump: orDefault(state, "manual_pump", null),
    },
    activeProfileId: orDefault(
      state,
      "active_profile_id",
      profiles && profiles[0] ? profiles[0].id : null
    ),
    profiles: profiles || [],
    recentTemps: [],
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
      latest_water_flow: entry.sensorData.waterFlow,
      latest_water_used_total: entry.sensorData.waterUsedTotal,
      latest_water_tank_pct: entry.sensorData.waterTankPct,
      latest_wind_speed: entry.sensorData.windSpeed,
      latest_co2_ppm: entry.sensorData.co2Ppm,
      latest_outside_temp: entry.sensorData.outsideTemp,
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
  if (entry && entry.esp32Socket && entry.esp32Socket.readyState === 1) {
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

wss.on("connection", (ws) => {
  ws.isFrontend = false;
  ws.isESP32 = false;
  ws.greenhouseId = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
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
        if (userError || !(userData && userData.user)) {
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
      entry.sensorData = {
        temp: orDefault(msg.data, "temp", null),
        humidity: orDefault(msg.data, "humidity", null),
        soilMoisture: orDefault(msg.data, "soilMoisture", null),
        lightLux: orDefault(msg.data, "lightLux", null),
        waterLevel: orDefault(msg.data, "waterLevel", null),
        waterFlow: orDefault(msg.data, "waterFlow", null),
        waterUsedTotal: orDefault(msg.data, "waterUsedTotal", null),
        waterTankPct: orDefault(msg.data, "waterTankPct", null),
        windSpeed: orDefault(msg.data, "windSpeed", null),
        co2Ppm: orDefault(msg.data, "co2Ppm", null),
        outsideTemp: orDefault(msg.data, "outsideTemp", null),
        updatedAt: new Date().toISOString(),
      };

      if (typeof msg.data.temp === "number") {
        entry.recentTemps.push({ temp: msg.data.temp, at: Date.now() });
        entry.recentTemps = entry.recentTemps.filter((r) => r.at >= Date.now() - TREND_WINDOW_MS);
      }

      supabase
        .from("sensor_history")
        .insert({
          greenhouse_id: ws.greenhouseId,
          temp: entry.sensorData.temp,
          humidity: entry.sensorData.humidity,
          soil_moisture: entry.sensorData.soilMoisture,
          light_lux: entry.sensorData.lightLux,
          water_level: entry.sensorData.waterLevel,
          water_flow: entry.sensorData.waterFlow,
          water_used_total: entry.sensorData.waterUsedTotal,
          water_tank_pct: entry.sensorData.waterTankPct,
          wind_speed: entry.sensorData.windSpeed,
          co2_ppm: entry.sensorData.co2Ppm,
          outside_temp: entry.sensorData.outsideTemp,
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

app.post("/api/contact", async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: "name, email and message are all required" });
  }
  const { error } = await supabase.from("contact_messages").insert({ name, email, message });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get("/api/greenhouses", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("greenhouses")
    .select("id, name, api_key, created_at")
    .eq("owner_id", req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/greenhouses", requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const { data: gh, error } = await supabase
    .from("greenhouses")
    .insert({ owner_id: req.userId, name, api_key: randomApiKey() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  const seedRows = DEFAULT_PROFILES.map((p) => ({ ...p, greenhouse_id: gh.id }));
  const { data: profiles, error: profileError } = await supabase.from("crop_profiles").insert(seedRows).select();
  if (profileError) return res.status(500).json({ error: profileError.message });

  await supabase.from("greenhouse_state").insert({ greenhouse_id: gh.id, active_profile_id: profiles[0].id });

  res.json({ ...gh, profiles: profiles.map(profileToClientShape) });
});

app.patch("/api/greenhouses/:id", requireAuth, requireOwnedGreenhouse, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const { data, error } = await supabase
    .from("greenhouses")
    .update({ name: name.trim() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id, name: data.name });
});

app.get("/api/greenhouses/:id/status", requireAuth, requireOwnedGreenhouse, async (req, res) => {
  const entry = await loadGreenhouseState(req.params.id);
  res.json({
    name: req.greenhouse.name,
    sensorData: entry.sensorData,
    relayState: entry.relayState,
    manualOverrides: entry.manualOverrides,
    activeProfile: profileToClientShape(getActiveProfile(entry)),
    esp32Connected: !!entry.esp32Socket,
  });
});

app.get("/api/greenhouses/:id/history", requireAuth, requireOwnedGreenhouse, async (req, res) => {
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
      waterFlow: h.water_flow,
      waterUsedTotal: h.water_used_total,
      waterTankPct: h.water_tank_pct,
      windSpeed: h.wind_speed,
      co2Ppm: h.co2_ppm,
      outsideTemp: h.outside_temp,
      updatedAt: h.recorded_at,
    }))
  );
});

app.get("/api/greenhouses/:id/profiles", requireAuth, requireOwnedGreenhouse, async (req, res) => {
  const { data, error } = await supabase.from("crop_profiles").select("*").eq("greenhouse_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(profileToClientShape));
});

app.post("/api/greenhouses/:id/profiles", requireAuth, requireOwnedGreenhouse, async (req, res) => {
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

  const query = b.id
    ? supabase.from("crop_profiles").update(row).eq("id", b.id).eq("greenhouse_id", req.params.id).select().single()
    : supabase.from("crop_profiles").insert(row).select().single();

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const entry = await loadGreenhouseState(req.params.id);
  const idx = entry.profiles.findIndex((p) => p.id === data.id);
  if (idx >= 0) entry.profiles[idx] = data;
  else entry.profiles.push(data);

  res.json(profileToClientShape(data));
});

app.delete("/api/greenhouses/:id/profiles/:profileId", requireAuth, requireOwnedGreenhouse, async (req, res) => {
  const { error } = await supabase
    .from("crop_profiles")
    .delete()
    .eq("id", req.params.profileId)
    .eq("greenhouse_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  const entry = await loadGreenhouseState(req.params.id);
  entry.profiles = entry.profiles.filter((p) => p.id !== req.params.profileId);
  res.json({ success: true });
});

app.post("/api/greenhouses/:id/profiles/active", requireAuth, requireOwnedGreenhouse, async (req, res) => {
  const { profileId } = req.body;
  const entry = await loadGreenhouseState(req.params.id);
  if (!entry.profiles.find((p) => p.id === profileId)) return res.status(404).json({ error: "Profile not found" });
  entry.activeProfileId = profileId;
  await runControlCycle(req.params.id);
  res.json({ success: true, activeProfileId: profileId });
});

app.post("/api/greenhouses/:id/control", requireAuth, requireOwnedGreenhouse, async (req, res) => {
  const { relay, mode } = req.body;
  if (!["fan", "heater", "pump"].includes(relay)) return res.status(400).json({ error: "Invalid relay name" });

  const entry = await loadGreenhouseState(req.params.id);
  if (mode === "auto") {
    entry.manualOverrides[relay] = null;
    entry.relayState[relay] = false;
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

app.get("/api/admin/check", requireAuth, async (req, res) => {
  const { data } = await supabase.from("admins").select("user_id").eq("user_id", req.userId).maybeSingle();
  res.json({ isAdmin: !!data });
});

app.get("/api/admin/overview", requireAuth, requireAdmin, async (req, res) => {
  const { data: authUsers, error: userError } = await supabase.auth.admin.listUsers();
  if (userError) return res.status(500).json({ error: userError.message });

  const { data: allGreenhouses, error: ghError } = await supabase
    .from("greenhouses")
    .select("id, name, api_key, owner_id, created_at");
  if (ghError) return res.status(500).json({ error: ghError.message });

  const result = authUsers.users.map((u) => ({
    userId: u.id,
    email: u.email,
    createdAt: u.created_at,
    greenhouses: allGreenhouses
      .filter((gh) => gh.owner_id === u.id)
      .map((gh) => ({ id: gh.id, name: gh.name, apiKey: gh.api_key, createdAt: gh.created_at })),
  }));

  res.json(result);
});

app.post("/api/admin/greenhouses/:id/regenerate-key", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("greenhouses")
    .update({ api_key: randomApiKey() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id, apiKey: data.api_key });
});

app.patch("/api/admin/greenhouses/:id", requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const { data, error } = await supabase
    .from("greenhouses")
    .update({ name: name.trim() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id, name: data.name });
});

app.delete("/api/admin/greenhouses/:id", requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabase.from("greenhouses").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  liveState.delete(req.params.id);
  res.json({ success: true });
});

app.get("/api/admin/messages", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("contact_messages")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/admin/messages/:id", requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from("contact_messages")
    .update({ is_read: true })
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete("/api/admin/messages/:id", requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabase.from("contact_messages").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post("/api/ask-ai", async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: "question is required" });
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "AI assistant is not configured yet" });
  }

  const systemPrompt = `You are a focused assistant embedded on the landing page of "Smart Greenhouse", a personal IoT portfolio project. Answer ONLY questions about this specific project. If asked anything unrelated (general knowledge, other topics, personal advice, etc.), politely reply that you can only answer questions about this greenhouse project and cannot help with that.

Project facts you can use to answer:
- Built by Mohammadmahdi Heibatian Ghalehsalimi, who is applying to a German Ausbildung (vocational apprenticeship) program.
- An ESP32 microcontroller reads sensors (temperature, humidity, soil moisture, and optionally light, wind, CO2, water flow/tank level, outside temperature) and controls relays for a fan, heater, and irrigation pump.
- A Node.js backend (hosted on Render) is the "brain" - it holds crop profiles (e.g. tomato, cucumber, lettuce, bell pepper) with target temperature/humidity ranges, and automatically decides when to switch each relay on or off, using hysteresis and adaptive logic based on recent temperature trends and daytime detection.
- The ESP32 and the backend communicate over a secure WebSocket connection; the backend also exposes a REST API.
- Data is stored in Supabase (Postgres), including per-user accounts, greenhouses, crop profiles, sensor history, and contact messages.
- The frontend is a React (Vite) single-page app with a live dashboard: analog-style gauges, relay controls with manual/auto modes, a sensor history chart, and a picker for multiple greenhouses per account.
- Each greenhouse has a unique API key that the ESP32 uses to authenticate itself to the backend.
- Keep answers concise (a few sentences), friendly, and technically accurate.
- Always answer in English, even if the question is asked in another language.`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 400,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question.trim().slice(0, 1000) },
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Groq API error:", data);
      return res.status(502).json({ error: "AI assistant is temporarily unavailable" });
    }
    const answer = data.choices && data.choices[0] ? data.choices[0].message.content : "";
    res.json({ answer });
  } catch (err) {
    console.error("Groq API call failed:", err.message);
    res.status(502).json({ error: "AI assistant is temporarily unavailable" });
  }
});

server.listen(PORT, () => {
  console.log(`🌱 Greenhouse backend running on port ${PORT}`);
});
