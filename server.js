/**
 * server.js
 *
 * Central server for the smart greenhouse.
 * - Connects to the ESP32 module over WebSocket (receives sensor data, sends relay commands)
 * - Connects to the React panel over WebSocket as well (for live display)
 * - Manages crop profiles and history via a REST API
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const controlEngine = require("./controlEngine");

const PROFILES_PATH = path.join(__dirname, "profiles.json");
const PORT = process.env.PORT || 3001;
const MAX_HISTORY = 500; // maximum number of sensor records kept in memory

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- In-memory server state ----------------
let latestSensorData = { temp: null, humidity: null, soilMoisture: null, lightLux: null, waterLevel: null, updatedAt: null };
let relayState = { fan: false, heater: false, pump: false };
let manualOverrides = { fan: null, heater: null, pump: null }; // null means automatic mode
let sensorHistory = [];
let esp32Socket = null; // assumes a single ESP32 device; would need a Map for multiple devices

function loadProfiles() {
  return JSON.parse(fs.readFileSync(PROFILES_PATH, "utf-8"));
}
function saveProfiles(data) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2));
}

function getActiveProfile() {
  const data = loadProfiles();
  return data.profiles.find((p) => p.id === data.activeProfileId) || data.profiles[0];
}

// ---------------- Run the decision engine and send a command to the ESP32 ----------------
function runControlCycle() {
  const profile = getActiveProfile();
  const { relayState: newRelayState, reasons } = controlEngine.evaluate(
    latestSensorData,
    profile,
    relayState,
    manualOverrides
  );
  relayState = newRelayState;

  broadcastToESP32({ type: "command", relays: relayState });
  broadcastToFrontend({
    type: "status_update",
    sensorData: latestSensorData,
    relayState,
    reasons,
    activeProfile: profile,
  });
}

function broadcastToESP32(payload) {
  if (esp32Socket && esp32Socket.readyState === 1) {
    esp32Socket.send(JSON.stringify(payload));
  }
}

function broadcastToFrontend(payload) {
  wss.clients.forEach((client) => {
    if (client.isFrontend && client.readyState === 1) {
      client.send(JSON.stringify(payload));
    }
  });
}

// ---------------- WebSocket connection handling ----------------
wss.on("connection", (ws) => {
  ws.isFrontend = false;
  ws.isESP32 = false;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // invalid message, ignore it
    }

    // Identify the client type
    if (msg.type === "identify") {
      if (msg.role === "esp32") {
        ws.isESP32 = true;
        esp32Socket = ws;
        console.log("✅ ESP32 connected");
      } else if (msg.role === "frontend") {
        ws.isFrontend = true;
        // immediately send the latest state to the new client
        ws.send(
          JSON.stringify({
            type: "status_update",
            sensorData: latestSensorData,
            relayState,
            activeProfile: getActiveProfile(),
          })
        );
      }
      return;
    }

    // Receive sensor data from the ESP32
    if (msg.type === "sensor_data") {
      latestSensorData = { ...msg.data, updatedAt: new Date().toISOString() };
      sensorHistory.push(latestSensorData);
      if (sensorHistory.length > MAX_HISTORY) sensorHistory.shift();

      runControlCycle();
    }
  });

  ws.on("close", () => {
    if (ws === esp32Socket) {
      esp32Socket = null;
      console.log("❌ ESP32 disconnected");
    }
  });
});

// ---------------- REST API ----------------

// Live status of the whole system
app.get("/api/status", (req, res) => {
  res.json({
    sensorData: latestSensorData,
    relayState,
    manualOverrides,
    activeProfile: getActiveProfile(),
    esp32Connected: !!esp32Socket,
  });
});

// Sensor history (for the chart)
app.get("/api/history", (req, res) => {
  res.json(sensorHistory);
});

// List all profiles
app.get("/api/profiles", (req, res) => {
  res.json(loadProfiles());
});

// Add or edit a profile
app.post("/api/profiles", (req, res) => {
  const data = loadProfiles();
  const incoming = req.body;
  const idx = data.profiles.findIndex((p) => p.id === incoming.id);
  if (idx >= 0) {
    data.profiles[idx] = incoming;
  } else {
    data.profiles.push(incoming);
  }
  saveProfiles(data);
  res.json({ success: true, profiles: data.profiles });
});

// Delete a profile
app.delete("/api/profiles/:id", (req, res) => {
  const data = loadProfiles();
  data.profiles = data.profiles.filter((p) => p.id !== req.params.id);
  saveProfiles(data);
  res.json({ success: true });
});

// Set the active crop - this is exactly the "just tell it the crop name and it handles the rest" feature
app.post("/api/profiles/active", (req, res) => {
  const { profileId } = req.body;
  const data = loadProfiles();
  if (!data.profiles.find((p) => p.id === profileId)) {
    return res.status(404).json({ error: "Profile not found" });
  }
  data.activeProfileId = profileId;
  saveProfiles(data);
  runControlCycle(); // immediately run a control cycle with the new profile
  res.json({ success: true, activeProfileId: profileId });
});

// Manual control / return to automatic mode
// body: { relay: "fan" | "heater" | "pump", mode: "on" | "off" | "auto" }
app.post("/api/control", (req, res) => {
  const { relay, mode } = req.body;
  if (!["fan", "heater", "pump"].includes(relay)) {
    return res.status(400).json({ error: "Invalid relay name" });
  }
  if (mode === "auto") {
    manualOverrides[relay] = null;
  } else if (mode === "on") {
    manualOverrides[relay] = true;
  } else if (mode === "off") {
    manualOverrides[relay] = false;
  } else {
    return res.status(400).json({ error: "mode must be on / off / auto" });
  }
  runControlCycle();
  res.json({ success: true, manualOverrides });
});

server.listen(PORT, () => {
  console.log(`🌱 Greenhouse backend running on port ${PORT}`);
});
