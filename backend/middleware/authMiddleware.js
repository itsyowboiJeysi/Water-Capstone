const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");

async function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "aquamonitor_secret");
    
    // Check if user still exists in the database
    const [rows] = await pool.query("SELECT user_id FROM users WHERE user_id = ?", [decoded.id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Account no longer exists." });
    }

    req.user = decoded; // { id, email, role }
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(403).json({ message: "Invalid or expired token." });
    }
    console.error("[AquaMonitor] verifyToken error:", err);
    return res.status(500).json({ message: "Server error." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({ message: "Access denied. Admins only." });
  }
  next();
}

module.exports = { verifyToken, requireAdmin };