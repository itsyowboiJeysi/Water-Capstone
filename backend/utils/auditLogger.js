const { pool } = require("../config/db");

async function logAudit(req, action, details) {
  try {
    let userId = null;
    let username = "anonymous";
    let role = "anonymous";

    if (req && req.user) {
      userId = req.user.user_id || req.user.id || null;
      username = req.user.fullname || req.user.email || "authenticated_user";
      role = req.user.role || "user";
    }

    const ipAddress = req ? (req.headers["x-forwarded-for"] || req.socket.remoteAddress || null) : null;

    await pool.query(
      `INSERT INTO audit_logs (user_id, username, role, action, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, username, role, action, details, ipAddress]
    );
  } catch (err) {
    console.error("[Audit Logger] Error logging audit action:", err.message);
  }
}

module.exports = { logAudit };
