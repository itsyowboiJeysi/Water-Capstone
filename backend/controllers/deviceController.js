// controllers/deviceController.js — AquaMonitor Devices
const { pool } = require("../config/db");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/devices
// Returns all devices, joined with their location's building/area name
// ─────────────────────────────────────────────────────────────────────────────
async function getDevices(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT d.device_id, d.device_name, d.location_id, d.status,
              d.last_online, d.mqtt_topic,
              l.building_name, l.area_name
       FROM devices d
       LEFT JOIN locations l ON d.location_id = l.location_id
       ORDER BY d.device_name ASC`
    );
    return res.status(200).json(rows);
  } catch (err) {
    console.error("[AquaMonitor] getDevices error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/devices
// Body: { device_name, location_id, status, mqtt_topic }
// device_id is auto-assigned by MySQL — do NOT send it from the client.
// Admin only — enforce with verifyToken + requireRole("admin") middleware on the route
// ─────────────────────────────────────────────────────────────────────────────
async function createDevice(req, res) {
  const { device_name, location_id, status, mqtt_topic } = req.body || {};

  if (!device_name || !device_name.trim()) {
    return res.status(400).json({ message: "Device name is required." });
  }
  if (!location_id) {
    return res.status(400).json({ message: "Please select a location." });
  }
  if (!mqtt_topic || !mqtt_topic.trim()) {
    return res.status(400).json({ message: "MQTT topic is required." });
  }

  try {
    // Confirm the location actually exists
    const [loc] = await pool.query(
      "SELECT location_id FROM locations WHERE location_id = ?",
      [location_id]
    );
    if (loc.length === 0) {
      return res.status(400).json({ message: "Selected location does not exist." });
    }

    // Prevent duplicate mqtt_topic (device_id is now auto-assigned, so this
    // is the new uniqueness check that matters)
    const [existingTopic] = await pool.query(
      "SELECT device_id FROM devices WHERE mqtt_topic = ?",
      [mqtt_topic.trim()]
    );
    if (existingTopic.length > 0) {
      return res.status(409).json({ message: "A device with this MQTT topic is already registered." });
    }

    const [result] = await pool.query(
      `INSERT INTO devices (device_name, location_id, status, mqtt_topic, last_online)
       VALUES (?, ?, ?, ?, NULL)`,
      [
        device_name.trim(),
        location_id,
        status || "offline",
        mqtt_topic.trim(),
      ]
    );

    const newDeviceId = result.insertId;

    const [newRow] = await pool.query(
      `SELECT d.device_id, d.device_name, d.location_id, d.status,
              d.last_online, d.mqtt_topic,
              l.building_name, l.area_name
       FROM devices d
       LEFT JOIN locations l ON d.location_id = l.location_id
       WHERE d.device_id = ?`,
      [newDeviceId]
    );

    return res.status(201).json({
      message: "Device registered successfully!",
      device: newRow[0],
    });

  } catch (err) {
    console.error("[AquaMonitor] createDevice error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/devices/:id
// Body: { device_name, location_id, status, mqtt_topic }
// ─────────────────────────────────────────────────────────────────────────────
async function updateDevice(req, res) {
  const { id } = req.params; // device_id (now an auto-increment int)
  const { device_name, location_id, status, mqtt_topic } = req.body || {};

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ message: "Invalid device ID." });
  }

  try {
    const [existing] = await pool.query("SELECT device_id FROM devices WHERE device_id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Device not found." });
    }

    await pool.query(
      `UPDATE devices
       SET device_name = ?, location_id = ?, status = ?, mqtt_topic = ?
       WHERE device_id = ?`,
      [device_name, location_id, status, mqtt_topic, id]
    );

    return res.status(200).json({ message: "Device updated successfully." });

  } catch (err) {
    console.error("[AquaMonitor] updateDevice error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/devices/:id/status
// Body: { status }
// Used by the MQTT broker/bridge service to mark a device online/offline
// ─────────────────────────────────────────────────────────────────────────────
async function updateDeviceStatus(req, res) {
  const { id } = req.params; // device_id (now an auto-increment int)
  const { status } = req.body || {};

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ message: "Invalid device ID." });
  }

  const validStatuses = ["online", "offline", "maintenance"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ message: "Status must be online, offline, or maintenance." });
  }

  try {
    const [existing] = await pool.query("SELECT device_id FROM devices WHERE device_id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Device not found." });
    }

    await pool.query(
      `UPDATE devices
       SET status = ?, last_online = IF(? = 'online', NOW(), last_online)
       WHERE device_id = ?`,
      [status, status, id]
    );

    return res.status(200).json({ message: "Device status updated." });

  } catch (err) {
    console.error("[AquaMonitor] updateDeviceStatus error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/devices/:id
// ─────────────────────────────────────────────────────────────────────────────
async function deleteDevice(req, res) {
  const { id } = req.params; // device_id (now an auto-increment int)

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ message: "Invalid device ID." });
  }

  try {
    const [existing] = await pool.query("SELECT device_id FROM devices WHERE device_id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Device not found." });
    }

    await pool.query("DELETE FROM devices WHERE device_id = ?", [id]);

    return res.status(200).json({ message: "Device deleted successfully." });

  } catch (err) {
    console.error("[AquaMonitor] deleteDevice error:", err);
    if (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451) {
      return res.status(409).json({ message: "Cannot delete — readings or alerts are still linked to this device." });
    }
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

module.exports = {
  getDevices,
  createDevice,
  updateDevice,
  updateDeviceStatus,
  deleteDevice,
};