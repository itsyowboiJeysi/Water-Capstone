// server.js — AquaMonitor Express Server
require("dotenv").config();

const express        = require("express");
const cors           = require("cors");
const session        = require("express-session");
const passport       = require("./config/passport");
const { initDB }     = require("./config/db");
const authRoutes     = require("./routes/authRoutes");
const googleRoutes   = require("./routes/google");
const { generalLimiter } = require("./middleware/rateLimiter");
const dataRoutes = require("./routes/dataRoutes");
const locationRoutes = require("./routes/locationRoutes"); 
const deviceRoutes   = require("./routes/deviceRoutes");

// ── MQTT BROKER  ───────
const mqtt = require('mqtt');
const { pool } = require('./config/db');


const app  = express();
const PORT = process.env.PORT || 5000;

// ── Trust proxy (needed for accurate IPs behind a proxy/load balancer) ───────
app.set("trust proxy", 1);

console.log("authRoutes:", typeof authRoutes);
console.log("googleRoutes:", typeof googleRoutes);
console.log("generalLimiter:", typeof generalLimiter);
console.log("dataRoutes:", typeof dataRoutes);
console.log("locationRoutes:", typeof locationRoutes);
console.log("deviceRoutes:", typeof deviceRoutes);



// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ["http://127.0.0.1:5500","http://192.168.1.8:5000" , "http://localhost:5500"], 
  methods: ["GET", "POST", "PUT", "DELETE"],
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
app.use("/api/auth", authRoutes);
app.use("/api/auth", googleRoutes);   // GET /api/auth/google  &  /api/auth/google/callback
app.use("/api", dataRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/devices", deviceRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", app: "AquaMonitor", time: new Date().toISOString() });
});

// ── Start server after DB is ready ────────────────────────────────────────────
(async () => {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`[AquaMonitor] Server running at http://localhost:${PORT}`);
      console.log(`[AquaMonitor] Google OAuth → http://localhost:${PORT}/api/auth/google`);
    });
  } catch (err) {
    console.error("[AquaMonitor] Failed to initialize:", err.message);
    process.exit(1);
  }
})();
// Public broker — no Mosquitto install needed, works from any internet
// connection. Must match mqtt_server/mqtt_port in the ESP32 firmware.
//
// Topic convention: esp32/aquasense/<device-uid>
// The device's unique id lives in the TOPIC, not the JSON payload —
// the minimal firmware only sends raw sensor numbers in the payload.
const client = mqtt.connect('mqtt://broker.hivemq.com:1883');

client.on('connect', () => {
  client.subscribe('esp32/aquasense/+');  // all devices under this prefix
  console.log('[MQTT] Subscriber ready (public broker)');
});

client.on('message', async (topic, message) => {
  let d;
  try {
    d = JSON.parse(message.toString());
  } catch (err) {
    console.error('[MQTT] Bad JSON payload on', topic, err.message);
    return;
  }

  // Extract device uid from the topic: esp32/aquasense/<uid> → <uid>
  const esp32Uid = topic.split('/').pop();
  if (!esp32Uid) return;

  // Resolve internal device_id from esp32_uid
  const [[dev]] = await pool.query(
    'SELECT device_id FROM devices WHERE esp32_uid = ?',
    [esp32Uid]
  );
  if (!dev) {
    console.warn('[MQTT] Unregistered device, skipping:', esp32Uid);
    return;
  }

  await pool.query(
    `INSERT INTO sensor_readings
     (device_id, ph_level, turbidity, tds, temperature,
      ammonia, flow_rate, water_consumed)
     VALUES (?,?,?,?,?,?,?,?)`,
    [dev.device_id, d.ph_level, d.turbidity, d.tds,
     d.temperature, d.ammonia, d.flow_rate,
     d.water_consumed]
  );
});