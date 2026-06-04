// middleware/auth.js — JWT verification middleware
const jwt = require("jsonwebtoken");

function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "aquamonitor_secret");
    req.user = decoded; // { id, email, role }
    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token." });
  }
}

module.exports = verifyToken;