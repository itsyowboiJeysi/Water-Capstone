// server.js — AquaMonitor Express Server
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

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
const crypto         = require("crypto");
const { classifyWaterQuality } = require("./utils/waterQualityClassifier");

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Device offline detection ──────────────────────────────────────────────
// If a device hasn't sent an MQTT reading within this window, we consider
// it offline. Tune via env var if your devices report less frequently.
const OFFLINE_THRESHOLD_MINUTES = parseInt(process.env.OFFLINE_THRESHOLD_MINUTES) || 3;
const HEALTH_CHECK_INTERVAL_MS  = 60 * 1000; // check every 60s

// ── Trust proxy (needed for accurate IPs behind a proxy/load balancer) ───────
app.set("trust proxy", 1);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ["http://127.0.0.1:5500", "http://localhost:5500"],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ limit: "5mb", extended: true }));
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

// ── Settings & SMS Helpers ───────────────────────────────────────────────────
async function getSettingsMap() {
  try {
    const [rows] = await pool.query("SELECT * FROM system_settings");
    const settings = {};
    rows.forEach(r => {
      settings[r.setting_key] = r.setting_value;
    });
    return settings;
  } catch (err) {
    console.error("Error loading system settings:", err.message);
    return {
      sms_alerts: "1",
      critical_alerts_only: "0",
      device_offline_alerts: "1",
      daily_summary_report: "1",
      auto_refresh_dashboard: "1",
      data_logging: "1",
      maintenance_mode: "0",
      google_oauth_login: "1"
    };
  }
}

async function triggerSmsAlert(deviceId, alertMsg, alertLevel) {
  try {
    const systemSettings = await getSettingsMap();

    // Get phone numbers of admin, gsu, or hsu users
    const [users] = await pool.query(
      "SELECT user_id, fullname, phone_number FROM users WHERE role IN ('admin', 'gsu', 'hsu') AND phone_number IS NOT NULL AND phone_number != ''"
    );

    if (users.length === 0) {
      if (systemSettings.sms_alerts === "1" && (systemSettings.critical_alerts_only !== "1" || alertLevel === "critical")) {
        await pool.query(
          "INSERT INTO sms_logs (device_id, message, recipient, provider, status) VALUES (?, ?, ?, 'Semaphore', 'sent')",
          [deviceId, alertMsg.slice(0, 250), "+639123456789"]
        );
      }
    } else {
      for (const u of users) {
        // Fetch user preferences
        const [userSettingsRows] = await pool.query(
          "SELECT setting_key, setting_value FROM user_settings WHERE user_id = ?",
          [u.user_id]
        );
        const userSettings = {};
        userSettingsRows.forEach(r => {
          userSettings[r.setting_key] = r.setting_value;
        });

        // Resolve setting value: user preference first, then fallback to global system setting
        const smsAlertsPref = userSettings.sms_alerts !== undefined ? userSettings.sms_alerts : systemSettings.sms_alerts;
        const critOnlyPref  = userSettings.critical_alerts_only !== undefined ? userSettings.critical_alerts_only : systemSettings.critical_alerts_only;

        if (smsAlertsPref !== "1") continue;
        if (critOnlyPref === "1" && alertLevel !== "critical") continue;

        await pool.query(
          "INSERT INTO sms_logs (device_id, message, recipient, provider, status) VALUES (?, ?, ?, 'Semaphore', 'sent')",
          [deviceId, alertMsg.slice(0, 250), u.phone_number]
        );
      }
    }
  } catch (err) {
    console.error("[SMS Alert Trigger] Error:", err.message);
  }
}

// ── MQTT Subscriber ───────────────────────────────────────────────────────────
// Connects to the public HiveMQ broker — no auth, no TLS required.
// Device lookup uses mqtt_topic (VARCHAR), NOT esp32_uid (column does not exist).
function initMqtt() {
  const mqttClient = mqtt.connect("mqtt://broker.hivemq.com:1883");

  mqttClient.on("connect", async () => {
    // Subscribe to all AquaSense device topics (wildcard backup)
    mqttClient.subscribe("esp32/aquasense/#", (err) => {
      if (err) {
        console.error("[MQTT] Subscribe error:", err.message);
      } else {
        console.log("[MQTT] Subscriber ready — listening on esp32/aquasense/#");
      }
    });

    // Dynamically subscribe to all custom topics stored in the database
    try {
      const [devices] = await pool.query("SELECT mqtt_topic FROM devices WHERE mqtt_topic IS NOT NULL");
      for (const dev of devices) {
        const topic = dev.mqtt_topic.trim();
        if (topic) {
          mqttClient.subscribe(topic, (err) => {
            if (err) {
              console.error(`[MQTT] Failed to subscribe to topic on startup: ${topic}`, err.message);
            } else {
              console.log(`[MQTT] Subscribed to registered topic on startup: ${topic}`);
            }
          });
        }
      }
    } catch (dbErr) {
      console.error("[MQTT] Failed to fetch device topics for subscription on startup:", dbErr.message);
    }
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

      // ── 1.5 Verify HMAC-SHA256 Data Integrity Signature ───────────────────
      const rawPayload = `${d.device_id}|${d.ph_level}|${d.turbidity}|${d.tds}|${d.temperature}|${d.ammonia}|${d.flow_rate}|${d.water_consumed}`;
      const secretKey = process.env.ESP32_HMAC_SECRET || "AquaSense_IoT_Secret_2026";
      const calculatedHash = crypto.createHmac('sha256', secretKey).update(rawPayload).digest('hex');

      if (!d.signature || d.signature !== calculatedHash) {
        console.warn(`[SECURITY WARNING] Dropped unauthenticated or tampered payload on topic "${topic}". Invalid signature.`);
        return;
      }

      // ── 2. Look up device by mqtt_topic ───────────────────────────────────
      // The devices table uses device_id (auto-increment INT) as PK.
      // mqtt_topic (VARCHAR) is the correct column to match against — there
      // is NO esp32_uid column.
      const [[dev]] = await pool.query(
        "SELECT device_id FROM devices WHERE mqtt_topic = ? AND is_deleted = 0",
        [topic]
      );

      if (!dev) {
        // Topic not registered — ignore silently (avoids log spam from
        // unrelated traffic on the public broker)
        return;
      }

      // Fetch system settings
      const settings = await getSettingsMap();

      // ── 3. Insert sensor reading ──────────────────────────────────────────
      // Compute score, safety classification, allowed use, and explanation
      const cls = classifyWaterQuality({
        ph_level:    d.ph_level      ?? null,
        turbidity:   d.turbidity     ?? null,
        tds:         d.tds           ?? null,
        temperature: d.temperature   ?? null,
        ammonia:     d.ammonia       ?? null,
      });

      if (settings.data_logging === "1") {
        await pool.query(
          `INSERT INTO sensor_readings
             (device_id, ph_level, turbidity, tds, temperature, ammonia, flow_rate, water_consumed, score, safety_classification, allowed_use, explanation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            dev.device_id,
            d.ph_level      ?? null,
            d.turbidity     ?? null,
            d.tds           ?? null,
            d.temperature   ?? null,
            d.ammonia       ?? null,
            d.flow_rate     ?? null,
            d.water_consumed ?? null,
            cls.score,
            cls.classification,
            cls.recommended_use,
            cls.explanation
          ]
        );
      }

      // ── 4. Mark device as online ──────────────────────────────────────────
      await pool.query(
        "UPDATE devices SET status = 'online', last_online = NOW() WHERE device_id = ?",
        [dev.device_id]
      );

      // ── 4b. Device is reporting again — clear any open "offline" alert ─────
      await pool.query(
        `UPDATE alerts
         SET status = 'resolved'
         WHERE device_id = ? AND parameter = 'connectivity' AND status = 'unresolved'`,
        [dev.device_id]
      );

      // ── 4c. Check if any sensor is down and raise an alert if needed ─────
      const sensors = [
        d.ph_level !== undefined && d.ph_level !== null,
        d.turbidity !== undefined && d.turbidity !== null,
        d.tds !== undefined && d.tds !== null,
        d.temperature !== undefined && d.temperature !== null,
        d.ammonia !== undefined && d.ammonia !== null
      ];
      const activeSensorsCount = sensors.filter(Boolean).length;

      if (activeSensorsCount < 5) {
        const missing = [];
        if (d.ph_level === undefined || d.ph_level === null) missing.push("pH");
        if (d.turbidity === undefined || d.turbidity === null) missing.push("Turbidity");
        if (d.tds === undefined || d.tds === null) missing.push("TDS");
        if (d.temperature === undefined || d.temperature === null) missing.push("Temperature");
        if (d.ammonia === undefined || d.ammonia === null) missing.push("Ammonia");

        const alertMsg = `Warning: Only ${activeSensorsCount} of 5 sensors are sending data. Missing: ${missing.join(", ")}`;

        // Prevent duplicate unresolved alert
        const [[existingSensorAlert]] = await pool.query(
          `SELECT id FROM alerts
           WHERE device_id = ? AND parameter = 'sensor_health' AND status = 'unresolved'
           LIMIT 1`,
          [dev.device_id]
        );

        if (!existingSensorAlert) {
          if (settings.maintenance_mode !== "1") {
            await pool.query(
              `INSERT INTO alerts (device_id, parameter, value, level, status, message)
               VALUES (?, 'sensor_health', ?, 'high', 'unresolved', ?)`,
              [dev.device_id, activeSensorsCount, alertMsg]
            );
            await triggerSmsAlert(dev.device_id, alertMsg, "high");
          }
        } else {
          // Update message if it changed
          await pool.query(
            `UPDATE alerts SET message = ?, value = ? WHERE id = ?`,
            [alertMsg, activeSensorsCount, existingSensorAlert.id]
          );
        }
      } else {
        // All sensors are okay, resolve any open sensor_health alert for this device
        await pool.query(
          `UPDATE alerts
           SET status = 'resolved'
           WHERE device_id = ? AND parameter = 'sensor_health' AND status = 'unresolved'`,
          [dev.device_id]
        );
      }

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
    const settings = await getSettingsMap();
    if (settings.maintenance_mode === "1") return; // Skip all alerts in maintenance mode

    const [thresholds] = await pool.query("SELECT * FROM threshold_settings");

    const paramMap = {
      ph:          reading.ph_level,
      turbidity:   reading.turbidity,
      tds:         reading.tds,
      temperature: reading.temperature,
      ammonia:     reading.ammonia,
      flow_rate:   reading.flow_rate,
    };

    // Calculate historical averages of the last 15 readings for normal comparison
    const [historical] = await pool.query(
      `SELECT AVG(ph_level) as avg_ph, AVG(turbidity) as avg_turbidity, 
              AVG(tds) as avg_tds, AVG(temperature) as avg_temp, 
              AVG(ammonia) as avg_ammonia, AVG(flow_rate) as avg_flow
       FROM (
         SELECT ph_level, turbidity, tds, temperature, ammonia, flow_rate
         FROM sensor_readings
         WHERE device_id = ?
         ORDER BY recorded_at DESC
         LIMIT 15
       ) as sub`,
      [deviceId]
    );

    const averages = historical[0] || {};

    for (const t of thresholds) {
      const value = paramMap[t.parameter_name];
      if (value === undefined || value === null) continue;

      const v   = Number(value);
      const min = Number(t.min_value);
      const max = Number(t.max_value);

      // 1. Standard safety threshold out-of-range alert
      if (v < min || v > max) {
        // Prevent duplicate unresolved alert for this device parameter
        const [[existing]] = await pool.query(
          `SELECT id FROM alerts
           WHERE device_id = ? AND parameter = ? AND status = 'unresolved' AND message NOT LIKE '%spike%'
           LIMIT 1`,
          [deviceId, t.parameter_name]
        );

        if (!existing) {
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
          await triggerSmsAlert(deviceId, message, level);
        }
      }

      // 2. High deviation from historical average (Spike Alert)
      let avgVal = null;
      if (t.parameter_name === "ph") avgVal = averages.avg_ph;
      else if (t.parameter_name === "turbidity") avgVal = averages.avg_turbidity;
      else if (t.parameter_name === "tds") avgVal = averages.avg_tds;
      else if (t.parameter_name === "temperature") avgVal = averages.avg_temp;
      else if (t.parameter_name === "ammonia") avgVal = averages.avg_ammonia;
      else if (t.parameter_name === "flow_rate") avgVal = averages.avg_flow;

      if (avgVal !== null && avgVal > 0.5) {
        const avg = Number(avgVal);
        if (v > avg * 1.5) {
          // Prevent duplicate unresolved anomaly/spike alert
          const [[existingAnomaly]] = await pool.query(
            `SELECT id FROM alerts
             WHERE device_id = ? AND parameter = ? AND status = 'unresolved' AND message LIKE '%spike%'
             LIMIT 1`,
            [deviceId, t.parameter_name]
          );

          if (!existingAnomaly) {
            let message = `${t.parameter_name.toUpperCase()} reading of ${v} is way too high compared to historical normal average (${avg.toFixed(1)})`;
            if (t.parameter_name === "flow_rate") {
              message = `Flow rate anomaly: sudden spike to ${v} L/min (normal avg: ${avg.toFixed(1)} L/min). Potential leak detected!`;
            }

            await pool.query(
              `INSERT INTO alerts (device_id, parameter, value, level, status, message)
               VALUES (?, ?, ?, 'high', 'unresolved', ?)`,
              [deviceId, t.parameter_name, v, message]
            );
            await triggerSmsAlert(deviceId, message, "high");
          }
        }
      }
    }
  } catch (err) {
    console.error("[MQTT] Threshold evaluation error:", err.message);
  }
}

// ── Device health checker ─────────────────────────────────────────────────
// Runs on a timer (HEALTH_CHECK_INTERVAL_MS). Any device still marked
// 'online' that hasn't reported in OFFLINE_THRESHOLD_MINUTES gets flipped
// to 'offline' and raises a connectivity alert — but only once, so it
// won't spam a new alert every tick while the device stays down.
async function checkDeviceHealth() {
  try {
    const settings = await getSettingsMap();
    const [staleDevices] = await pool.query(
      `SELECT device_id, device_name
       FROM devices
       WHERE status = 'online'
         AND (last_online < (NOW() - INTERVAL ? MINUTE) OR last_online IS NULL)`,
      [OFFLINE_THRESHOLD_MINUTES]
    );

    for (const dev of staleDevices) {
      await pool.query(
        "UPDATE devices SET status = 'offline' WHERE device_id = ?",
        [dev.device_id]
      );

      // Don't duplicate the alert if one is already open for this device
      const [[existing]] = await pool.query(
        `SELECT id FROM alerts
         WHERE device_id = ? AND parameter = 'connectivity' AND status = 'unresolved'
         LIMIT 1`,
        [dev.device_id]
      );

      if (!existing) {
        if (settings.device_offline_alerts === "1" && settings.maintenance_mode !== "1") {
          const message = `${dev.device_name} stopped sending data ${OFFLINE_THRESHOLD_MINUTES}+ minutes ago and has been marked offline.`;
          await pool.query(
            `INSERT INTO alerts (device_id, parameter, value, level, status, message)
             VALUES (?, 'connectivity', NULL, 'medium', 'unresolved', ?)`,
            [dev.device_id, message]
          );
          await triggerSmsAlert(dev.device_id, message, "medium");
          console.log(`[Health Check] ${dev.device_name} (ID ${dev.device_id}) → offline. Alert raised.`);
        } else {
          console.log(`[Health Check] ${dev.device_name} (ID ${dev.device_id}) → offline. Alert skipped due to system settings.`);
        }
      }
    }
  } catch (err) {
    console.error("[Health Check] Error checking device health:", err.message);
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
    const mqttClient = initMqtt();
    app.set("mqttClient", mqttClient);
    console.log("[AquaMonitor] MQTT subscriber initializing…");

    // Start periodic offline-device health checks
    setInterval(checkDeviceHealth, HEALTH_CHECK_INTERVAL_MS);
    checkDeviceHealth(); // run once immediately on boot
    console.log(`[AquaMonitor] Device health checker running — offline threshold: ${OFFLINE_THRESHOLD_MINUTES} min`);

  } catch (err) {
    console.error("[AquaMonitor] Failed to initialize:", err.message);
    process.exit(1);
  }
})();