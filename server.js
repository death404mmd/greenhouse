/**
 * server.js
 *
 * سرور مرکزی گلخونه هوشمند.
 * - از طریق WebSocket به ماژول ESP32 وصل می‌شه (داده سنسور می‌گیره، فرمان رله می‌فرسته)
 * - از طریق WebSocket به پنل React هم وصل می‌شه (برای نمایش زنده)
 * - از طریق REST API پروفایل‌ها و تاریخچه رو مدیریت می‌کنه
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
const MAX_HISTORY = 500; // حداکثر تعداد رکورد سنسوری که در حافظه نگه می‌داریم

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- وضعیت درون‌حافظه‌ای سرور ----------------
let latestSensorData = { temp: null, humidity: null, soilMoisture: null, lightLux: null, waterLevel: null, updatedAt: null };
let relayState = { fan: false, heater: false, pump: false };
let manualOverrides = { fan: null, heater: null, pump: null }; // null یعنی حالت خودکار
let sensorHistory = [];
let esp32Socket = null; // فقط یک دستگاه ESP32 فرض شده؛ برای چند دستگاه باید Map بشه

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

// ---------------- اجرای موتور تصمیم‌گیری و ارسال فرمان به ESP32 ----------------
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

// ---------------- مدیریت اتصالات WebSocket ----------------
wss.on("connection", (ws) => {
  ws.isFrontend = false;
  ws.isESP32 = false;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // پیام نامعتبر، نادیده گرفته می‌شه
    }

    // شناسایی نوع کلاینت
    if (msg.type === "identify") {
      if (msg.role === "esp32") {
        ws.isESP32 = true;
        esp32Socket = ws;
        console.log("✅ ESP32 متصل شد");
      } else if (msg.role === "frontend") {
        ws.isFrontend = true;
        // بلافاصله آخرین وضعیت رو برای کلاینت جدید بفرست
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

    // دریافت داده سنسور از ESP32
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
      console.log("❌ ESP32 قطع شد");
    }
  });
});

// ---------------- REST API ----------------

// وضعیت لحظه‌ای کل سیستم
app.get("/api/status", (req, res) => {
  res.json({
    sensorData: latestSensorData,
    relayState,
    manualOverrides,
    activeProfile: getActiveProfile(),
    esp32Connected: !!esp32Socket,
  });
});

// تاریخچه سنسورها (برای نمودار)
app.get("/api/history", (req, res) => {
  res.json(sensorHistory);
});

// لیست همه پروفایل‌ها
app.get("/api/profiles", (req, res) => {
  res.json(loadProfiles());
});

// افزودن یا ویرایش یک پروفایل
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

// حذف پروفایل
app.delete("/api/profiles/:id", (req, res) => {
  const data = loadProfiles();
  data.profiles = data.profiles.filter((p) => p.id !== req.params.id);
  saveProfiles(data);
  res.json({ success: true });
});

// تنظیم محصول فعال - این همون جاییه که "فقط اسم محصول رو می‌گی و خودش کنترل می‌کنه"
app.post("/api/profiles/active", (req, res) => {
  const { profileId } = req.body;
  const data = loadProfiles();
  if (!data.profiles.find((p) => p.id === profileId)) {
    return res.status(404).json({ error: "پروفایل پیدا نشد" });
  }
  data.activeProfileId = profileId;
  saveProfiles(data);
  runControlCycle(); // بلافاصله با پروفایل جدید یک چرخه کنترل اجرا کن
  res.json({ success: true, activeProfileId: profileId });
});

// کنترل دستی / بازگشت به حالت خودکار
// body: { relay: "fan" | "heater" | "pump", mode: "on" | "off" | "auto" }
app.post("/api/control", (req, res) => {
  const { relay, mode } = req.body;
  if (!["fan", "heater", "pump"].includes(relay)) {
    return res.status(400).json({ error: "نام رله نامعتبره" });
  }
  if (mode === "auto") {
    manualOverrides[relay] = null;
  } else if (mode === "on") {
    manualOverrides[relay] = true;
  } else if (mode === "off") {
    manualOverrides[relay] = false;
  } else {
    return res.status(400).json({ error: "mode باید on / off / auto باشه" });
  }
  runControlCycle();
  res.json({ success: true, manualOverrides });
});

server.listen(PORT, () => {
  console.log(`🌱 Greenhouse backend روی پورت ${PORT} در حال اجراست`);
});
