// dataController.js — AquaSense Monitoring Data (matches actual schema)
const { pool } = require("../config/db");

// ─────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/summary
// ─────────────────────────────────────────────────────────────────────────
async function getDashboardSummary(req, res) {
  try {
    // Latest reading overall
    const [latestRows] = await pool.query(`
      SELECT sr.*, d.device_name, d.status AS device_status, l.building_name, l.area_name
      FROM sensor_readings sr
      JOIN devices d ON sr.device_id = d.device_id
      LEFT JOIN locations l ON d.location_id = l.location_id
      ORDER BY sr.recorded_at DESC
      LIMIT 1
    `);

    // Device status counts
    const [deviceCounts] = await pool.query(`
      SELECT
        SUM(status = 'online') AS online,
        SUM(status = 'offline') AS offline,
        SUM(status = 'maintenance') AS maintenance,
        COUNT(*) AS total
      FROM devices
    `);

    // Active (unresolved) alerts count
    const [alertCounts] = await pool.query(`
      SELECT COUNT(*) AS active FROM alerts WHERE status = 'unresolved'
    `);

    // Thresholds
    const [thresholds] = await pool.query(`SELECT * FROM threshold_settings`);

    res.json({
      latestReading: latestRows[0] || null,
      devices: deviceCounts[0],
      activeAlerts: alertCounts[0].active,
      thresholds,
    });
  } catch (err) {
    console.error("[AquaSense] getDashboardSummary error:", err);
    res.status(500).json({ message: "Server error fetching dashboard summary." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/sensors/latest
// Latest reading per device
// ─────────────────────────────────────────────────────────────────────────
async function getLatestReadings(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT sr.*, d.device_name, d.status AS device_status, l.building_name, l.area_name
      FROM sensor_readings sr
      JOIN devices d ON sr.device_id = d.device_id
      LEFT JOIN locations l ON d.location_id = l.location_id
      WHERE sr.id IN (
        SELECT MAX(id) FROM sensor_readings GROUP BY device_id
      )
      ORDER BY sr.recorded_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("[AquaSense] getLatestReadings error:", err);
    res.status(500).json({ message: "Server error fetching latest readings." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/sensors?limit=50&device_id=&page=1
// ─────────────────────────────────────────────────────────────────────────
async function getSensorReadings(req, res) {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const page   = Math.max(parseInt(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;
    const deviceId = req.query.device_id;

    let where = "";
    const params = [];
    if (deviceId) {
      where = "WHERE sr.device_id = ?";
      params.push(deviceId);
    }

    const [rows] = await pool.query(
      `SELECT sr.*, d.device_name, l.building_name
       FROM sensor_readings sr
       JOIN devices d ON sr.device_id = d.device_id
       LEFT JOIN locations l ON d.location_id = l.location_id
       ${where}
       ORDER BY sr.recorded_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM sensor_readings sr ${where}`,
      params
    );

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total: countRows[0].total,
        totalPages: Math.ceil(countRows[0].total / limit),
      },
    });
  } catch (err) {
    console.error("[AquaSense] getSensorReadings error:", err);
    res.status(500).json({ message: "Server error fetching sensor readings." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/alerts?status=unresolved|resolved|all&limit=50
// ─────────────────────────────────────────────────────────────────────────
async function getAlerts(req, res) {
  try {
    const status = req.query.status || "all";
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);

    let where = "";
    if (status === "unresolved") where = "WHERE a.status = 'unresolved'";
    if (status === "resolved")   where = "WHERE a.status = 'resolved'";

    const [rows] = await pool.query(
      `SELECT a.*, d.device_name, l.building_name, l.area_name
       FROM alerts a
       LEFT JOIN devices d ON a.device_id = d.device_id
       LEFT JOIN locations l ON d.location_id = l.location_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ?`,
      [limit]
    );

    res.json(rows);
  } catch (err) {
    console.error("[AquaSense] getAlerts error:", err);
    res.status(500).json({ message: "Server error fetching alerts." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PATCH /api/alerts/:id/resolve
// ─────────────────────────────────────────────────────────────────────────
async function resolveAlert(req, res) {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      "UPDATE alerts SET status = 'resolved' WHERE id = ?",
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Alert not found." });
    }
    res.json({ message: "Alert marked as resolved." });
  } catch (err) {
    console.error("[AquaSense] resolveAlert error:", err);
    res.status(500).json({ message: "Server error resolving alert." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/devices
// ─────────────────────────────────────────────────────────────────────────
async function getDevices(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT
        d.*,
        l.building_name, l.area_name,
        (SELECT MAX(recorded_at) FROM sensor_readings sr WHERE sr.device_id = d.device_id) AS last_reading_at
      FROM devices d
      LEFT JOIN locations l ON d.location_id = l.location_id
      ORDER BY d.device_id ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error("[AquaSense] getDevices error:", err);
    res.status(500).json({ message: "Server error fetching devices." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/locations
// ─────────────────────────────────────────────────────────────────────────
async function getLocations(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT
        l.*,
        COUNT(d.device_id) AS device_count
      FROM locations l
      LEFT JOIN devices d ON d.location_id = l.location_id
      GROUP BY l.location_id
      ORDER BY l.location_id ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error("[AquaSense] getLocations error:", err);
    res.status(500).json({ message: "Server error fetching locations." });
  }
}

module.exports = {
  getDashboardSummary,
  getLatestReadings,
  getSensorReadings,
  getAlerts,
  resolveAlert,
  getDevices,
  getLocations,
};