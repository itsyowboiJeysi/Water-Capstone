// server.js — AquaMonitor Express Server
require("dotenv").config();

const express        = require("express");
const cors           = require("cors");
const session        = require("express-session");
const passport       = require("./config/passport");
const { initDB, pool } = require("./config/db");
const authRoutes     = require("./routes/authRoutes");
const googleRoutes   = require("./routes/google");
const { generalLimiter } = require("./middleware/rateLimiter");
const dataRoutes     = require("./routes/dataRoutes");
const mqtt           = require("mqtt");

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Trust proxy (needed for accurate IPs behind a proxy/load balancer) ───────
app.set("trust proxy", 1);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ["http://127.0.0.1:5500", "http://localhost:5500"],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));
app.use(express.json({ limit: "10kb" }));
app.use(generalLimiter);

// Session required by Passport (even though we issue JWTs)
app.use(session({
  secret:            process.env.JWT_SECRET || "aquamonitor_secret",
  resave:            false,
  saveUninitialized: false,
}));

app.use(passport.initialize());
app.use(passport.session());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth",  authRoutes);
app.use("/api/auth",  googleRoutes);   // GET /api/auth/google  &  /api/auth/google/callback
app.use("/api",       dataRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", app: "AquaMonitor", time: new Date().toISOString() });
});

// ── MQTT Subscriber ───────────────────────────────────────────────────────────
// Connects to the public HiveMQ broker — no auth, no TLS required.
// Device lookup uses mqtt_topic (VARCHAR), NOT esp32_uid (column does not exist).
function initMqtt() {
  const mqttClient = mqtt.connect("mqtt://broker.hivemq.com:1883");

  mqttClient.on("connect", () => {
    // Subscribe to all AquaSense device topics
    mqttClient.subscribe("esp32/aquasense/#", (err) => {
      if (err) {
        console.error("[MQTT] Subscribe error:", err.message);
      } else {
        console.log("[MQTT] Subscriber ready — listening on esp32/aquasense/#");
      }
    });
  });

  mqttClient.on("error", (err) => {
    console.error("[MQTT] Connection error:", err.message);
  });

  mqttClient.on("offline", () => {
    console.warn("[MQTT] Client went offline — will reconnect automatically.");
  });

  mqttClient.on("message", async (topic, message) => {
    // Wrap everything in try/catch — a bad payload or DB error must NEVER
    // crash the process; it just logs a warning and moves on.
    try {
      // ── 1. Parse payload ──────────────────────────────────────────────────
      let d;
      try {
        d = JSON.parse(message.toString());
      } catch (parseErr) {
        console.warn(`[MQTT] Malformed JSON on topic "${topic}":`, message.toString().slice(0, 120));
        return;
      }

      // ── 2. Look up device by mqtt_topic ───────────────────────────────────
      // The devices table uses device_id (auto-increment INT) as PK.
      // mqtt_topic (VARCHAR) is the correct column to match against — there
      // is NO esp32_uid column.
      const [[dev]] = await pool.query(
        "SELECT device_id FROM devices WHERE mqtt_topic = ?",
        [topic]
      );

      if (!dev) {
        // Topic not registered — ignore silently (avoids log spam from
        // unrelated traffic on the public broker)
        return;
      }

      // ── 3. Insert sensor reading ──────────────────────────────────────────
      // water_status is NOT a column in sensor_readings — status is computed
      // by the backend from threshold_settings, not sent by the firmware.
      await pool.query(
        `INSERT INTO sensor_readings
           (device_id, ph_level, turbidity, tds, temperature, ammonia, flow_rate, water_consumed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dev.device_id,
          d.ph_level      ?? null,
          d.turbidity     ?? null,
          d.tds           ?? null,
          d.temperature   ?? null,
          d.ammonia       ?? null,
          d.flow_rate     ?? null,
          d.water_consumed ?? null,
        ]
      );

      // ── 4. Mark device as online ──────────────────────────────────────────
      await pool.query(
        "UPDATE devices SET status = 'online', last_online = NOW() WHERE device_id = ?",
        [dev.device_id]
      );

      // ── 5. Evaluate thresholds & auto-create alerts ───────────────────────
      await evaluateThresholds(dev.device_id, d);

    } catch (err) {
      // Catch-all — DB errors, unexpected payloads, etc.
      // Log the message but do NOT rethrow (that would crash the server).
      console.error("[MQTT] Error handling message on topic", topic, ":", err.message);
    }
  });

  return mqttClient;
}

// ── Threshold evaluator ───────────────────────────────────────────────────────
// Reads threshold_settings and inserts an alert row if any param is out of range.
async function evaluateThresholds(deviceId, reading) {
  try {
    const [thresholds] = await pool.query("SELECT * FROM threshold_settings");

    const paramMap = {
      ph:          reading.ph_level,
      turbidity:   reading.turbidity,
      tds:         reading.tds,
      temperature: reading.temperature,
      ammonia:     reading.ammonia,
      flow_rate:   reading.flow_rate,
    };

    for (const t of thresholds) {
      const value = paramMap[t.parameter_name];
      if (value === undefined || value === null) continue;

      const v   = Number(value);
      const min = Number(t.min_value);
      const max = Number(t.max_value);

      if (v < min || v > max) {
        // Determine level
        const deviation = Math.max(
          min > 0 ? Math.abs(v - min) / min : 0,
          max > 0 ? Math.abs(v - max) / max : 0
        );
        const level = deviation > 0.3 ? "critical"
                    : deviation > 0.15 ? "high"
                    : "medium";

        const message = `${t.parameter_name.toUpperCase()} reading of ${v} is outside safe range (${min}–${max})`;

        await pool.query(
          `INSERT INTO alerts (device_id, parameter, value, level, status, message)
           VALUES (?, ?, ?, ?, 'unresolved', ?)`,
          [deviceId, t.parameter_name, v, level, message]
        );
      }
    }
  } catch (err) {
    console.error("[MQTT] Threshold evaluation error:", err.message);
  }
}

// ── Start server after DB is ready ────────────────────────────────────────────
(async () => {
  try {
    await initDB();

    app.listen(PORT, () => {
      console.log(`[AquaMonitor] Server running at http://localhost:${PORT}`);
      console.log(`[AquaMonitor] Google OAuth → http://localhost:${PORT}/api/auth/google`);
    });

    // Start MQTT after DB is confirmed ready
    initMqtt();
    console.log("[AquaMonitor] MQTT subscriber initializing…");

  } catch (err) {
    console.error("[AquaMonitor] Failed to initialize:", err.message);
    process.exit(1);
  }
})();