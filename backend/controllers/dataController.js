// dataController.js — AquaSense Monitoring Data (matches actual schema)
const { pool } = require("../config/db");

// ─────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/summary
// ─────────────────────────────────────────────────────────────────────────
async function getDashboardSummary(req, res) {
  try {
    const [latestRows] = await pool.query(`
      SELECT sr.*, d.device_name, d.status AS device_status, l.building_name, l.area_name
      FROM sensor_readings sr
      JOIN devices d ON sr.device_id = d.device_id
      LEFT JOIN locations l ON d.location_id = l.location_id
      ORDER BY sr.recorded_at DESC
      LIMIT 1
    `);

    const [deviceCounts] = await pool.query(`
      SELECT
        SUM(status = 'online')      AS online,
        SUM(status = 'offline')     AS offline,
        SUM(status = 'maintenance') AS maintenance,
        COUNT(*)                    AS total
      FROM devices
    `);

    const [alertCounts] = await pool.query(`
      SELECT COUNT(*) AS active FROM alerts WHERE status = 'unresolved'
    `);

    const [thresholds] = await pool.query(`SELECT * FROM threshold_settings`);

    res.json({
      latestReading: latestRows[0] || null,
      devices:       deviceCounts[0],
      activeAlerts:  alertCounts[0].active,
      thresholds,
    });
  } catch (err) {
    console.error("[AquaSense] getDashboardSummary error:", err);
    res.status(500).json({ message: "Server error fetching dashboard summary." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/sensors/latest
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
// GET /api/sensors?limit=50&device_id=&page=1&range=today|7d|30d
// ─────────────────────────────────────────────────────────────────────────
async function getSensorReadings(req, res) {
  try {
    const limit    = Math.min(parseInt(req.query.limit) || 50, 200);
    const page     = Math.max(parseInt(req.query.page)  || 1,  1);
    const offset   = (page - 1) * limit;
    const deviceId = req.query.device_id;
    const range    = req.query.range; // 'today' | '7d' | '30d'

    const conditions = [];
    const params = [];

    if (deviceId) {
      conditions.push("sr.device_id = ?");
      params.push(deviceId);
    }

    if (range === "today") {
      conditions.push("DATE(sr.recorded_at) = CURDATE()");
    } else if (range === "7d") {
      conditions.push("sr.recorded_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)");
    } else if (range === "30d") {
      conditions.push("sr.recorded_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

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
        total:      countRows[0].total,
        totalPages: Math.ceil(countRows[0].total / limit),
      },
    });
  } catch (err) {
    console.error("[AquaSense] getSensorReadings error:", err);
    res.status(500).json({ message: "Server error fetching sensor readings." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/sensors
// Body: { ids: [1, 2, 3] }
// Bulk-deletes one or more sensor readings by id. Admin only — powers the
// multi-select checkboxes + "Delete Selected" button on Sensor Readings.
// ─────────────────────────────────────────────────────────────────────────
async function deleteSensorReadings(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Only administrators can delete sensor readings." });
    }

    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "Please provide at least one reading id to delete." });
    }

    const cleanIds = ids
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (cleanIds.length === 0) {
      return res.status(400).json({ message: "No valid reading ids were provided." });
    }

    const placeholders = cleanIds.map(() => "?").join(",");
    const [result] = await pool.query(
      `DELETE FROM sensor_readings WHERE id IN (${placeholders})`,
      cleanIds
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "No matching readings were found to delete." });
    }

    res.json({
      message: `${result.affectedRows} reading${result.affectedRows === 1 ? "" : "s"} deleted.`,
      deleted: result.affectedRows,
    });
  } catch (err) {
    console.error("[AquaSense] deleteSensorReadings error:", err);
    res.status(500).json({ message: "Server error deleting sensor readings." });
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
// DELETE /api/alerts/:id
// Admin only — powers the trash-icon button + simple Yes/No modal on the
// Alerts page (no typed "CONFIRM" step, unlike Locations/Devices deletes).
// ─────────────────────────────────────────────────────────────────────────
async function deleteAlert(req, res) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Only administrators can delete alerts." });
  }

  const { id } = req.params;

  try {
    const [result] = await pool.query(
      "DELETE FROM alerts WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Alert not found." });
    }

    res.json({ message: "Alert deleted successfully." });
  } catch (err) {
    console.error("[AquaSense] deleteAlert error:", err);

    // sms_logs.alert_id references alerts — if that FK has no ON DELETE
    // CASCADE, MySQL will reject the delete with ER_ROW_IS_REFERENCED_2.
    if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
      return res.status(409).json({
        message: "This alert has related SMS log records and can't be deleted yet.",
      });
    }

    res.status(500).json({ message: "Server error deleting alert." });
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
// POST /api/devices
// Body: { device_name, location_id, mqtt_topic, status? }
// device_id is AUTO_INCREMENT — never accepted from the client
// ─────────────────────────────────────────────────────────────────────────
async function createDevice(req, res) {
  // Only admins may register devices
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Only admins can register devices." });
  }

  const { device_name, location_id, mqtt_topic, status = "offline" } = req.body || {};

  // ── Validation ──────────────────────────────────────────────────────────
  if (!device_name || !device_name.trim()) {
    return res.status(400).json({ message: "Device name is required." });
  }
  if (!mqtt_topic || !mqtt_topic.trim()) {
    return res.status(400).json({ message: "MQTT topic is required." });
  }
  if (!location_id || isNaN(parseInt(location_id))) {
    return res.status(400).json({ message: "A valid location is required." });
  }

  const validStatuses = ["online", "offline", "maintenance"];
  const safeStatus = validStatuses.includes(status) ? status : "offline";

  try {
    // ── Check duplicate mqtt_topic ──────────────────────────────────────
    const [existing] = await pool.query(
      "SELECT device_id FROM devices WHERE mqtt_topic = ?",
      [mqtt_topic.trim()]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        message: "That MQTT topic is already registered to another device.",
      });
    }

    // ── Insert — device_id assigned by AUTO_INCREMENT ───────────────────
    const [result] = await pool.query(
      `INSERT INTO devices (device_name, location_id, mqtt_topic, status)
       VALUES (?, ?, ?, ?)`,
      [device_name.trim(), parseInt(location_id), mqtt_topic.trim(), safeStatus]
    );

    // ── Return the newly created device row ─────────────────────────────
    const [rows] = await pool.query(
      `SELECT d.*, l.building_name, l.area_name
       FROM devices d
       LEFT JOIN locations l ON d.location_id = l.location_id
       WHERE d.device_id = ?`,
      [result.insertId]
    );

    return res.status(201).json({
      message: "Device registered successfully.",
      device:  rows[0],
    });

  } catch (err) {
    console.error("[AquaSense] createDevice error:", err);
    return res.status(500).json({ message: "Server error registering device." });
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

// ─────────────────────────────────────────────────────────────────────────
// POST /api/locations
// Body: { building_name, area_name, description }
// ─────────────────────────────────────────────────────────────────────────
async function createLocation(req, res) {
  const { building_name, area_name, description } = req.body || {};

  if (!building_name || !building_name.trim()) {
    return res.status(400).json({ message: "Building name is required." });
  }
  if (!area_name || !area_name.trim()) {
    return res.status(400).json({ message: "Area / Zone is required." });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO locations (building_name, area_name, description)
       VALUES (?, ?, ?)`,
      [building_name.trim(), area_name.trim(), description?.trim() || null]
    );

    const [rows] = await pool.query(
      "SELECT *, 0 AS device_count FROM locations WHERE location_id = ?",
      [result.insertId]
    );

    return res.status(201).json({
      message:  "Location added successfully.",
      location: rows[0],
    });
  } catch (err) {
    console.error("[AquaSense] createLocation error:", err);
    return res.status(500).json({ message: "Server error adding location." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/locations/:id
// ─────────────────────────────────────────────────────────────────────────
async function deleteLocation(req, res) {
  const { id } = req.params;
  try {
    const [result] = await pool.query(
      "DELETE FROM locations WHERE location_id = ?",
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Location not found." });
    }
    res.json({ message: "Location deleted successfully." });
  } catch (err) {
    console.error("[AquaSense] deleteLocation error:", err);
    // FK constraint is ON DELETE SET NULL for devices, so this should
    // succeed even if devices are still attached — they'll just lose location_id
    res.status(500).json({ message: "Server error deleting location." });
  }
}

module.exports = {
  getDashboardSummary,
  getLatestReadings,
  getSensorReadings,
  deleteSensorReadings,
  getAlerts,
  resolveAlert,
  deleteAlert,
  getDevices,
  createDevice,
  getLocations,
   createLocation,   // ← add
  deleteLocation, 
};