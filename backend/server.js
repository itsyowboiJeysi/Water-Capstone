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
  origin: ["http://127.0.0.1:5500", "http://localhost:5500"],
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