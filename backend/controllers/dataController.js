// dataController.js — AgosTech Monitoring Data (matches actual schema)
const { pool } = require("../config/db");
const { classifyWaterQuality } = require("../utils/waterQualityClassifier");
const { logAudit } = require("../utils/auditLogger");

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
      WHERE is_deleted = 0
    `);

    const [alertCounts] = await pool.query(`
      SELECT COUNT(*) AS active FROM alerts WHERE status = 'unresolved'
    `);

    const [thresholds] = await pool.query(`SELECT * FROM threshold_settings`);

    const [dailyConsumption] = await pool.query(`
      SELECT 
        DATE(recorded_at) as date, 
        COALESCE(SUM(water_consumed), 0) as consumed 
      FROM sensor_readings 
      WHERE recorded_at >= CURDATE() - INTERVAL 6 DAY 
      GROUP BY DATE(recorded_at) 
      ORDER BY date ASC
    `);

    const latestReading = latestRows[0] || null;
    if (latestReading) {
      latestReading.classification = classifyWaterQuality(latestReading);
    }

    res.json({
      latestReading,
      devices:       deviceCounts[0],
      activeAlerts:  alertCounts[0].active,
      thresholds,
      dailyConsumption,
    });
  } catch (err) {
    console.error("[AgosTech] getDashboardSummary error:", err);
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
    const enrichedRows = rows.map(r => ({
      ...r,
      classification: classifyWaterQuality(r)
    }));
    res.json(enrichedRows);
  } catch (err) {
    console.error("[AgosTech] getLatestReadings error:", err);
    res.status(500).json({ message: "Server error fetching latest readings." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/sensors?limit=50&device_id=&page=1&range=today|7d|30d
// ─────────────────────────────────────────────────────────────────────────
async function getSensorReadings(req, res) {
  try {
    const limit    = Math.min(parseInt(req.query.limit) || 50, 10000);
    const page     = Math.max(parseInt(req.query.page)  || 1,  1);
    const offset   = (page - 1) * limit;
    const deviceId = req.query.device_id;
    const range    = req.query.range; // 'today' | '7d' | '30d'
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    const conditions = [];
    const params = [];

    if (deviceId) {
      conditions.push("sr.device_id = ?");
      params.push(deviceId);
    }

    if (startDate && endDate) {
      conditions.push("DATE(sr.recorded_at) >= ? AND DATE(sr.recorded_at) <= ?");
      params.push(startDate, endDate);
    } else if (range === "today") {
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

    const enrichedRows = rows.map(r => ({
      ...r,
      classification: classifyWaterQuality(r)
    }));

    res.json({
      data: enrichedRows,
      pagination: {
        page,
        limit,
        total:      countRows[0].total,
        totalPages: Math.ceil(countRows[0].total / limit),
      },
    });
  } catch (err) {
    console.error("[AgosTech] getSensorReadings error:", err);
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

    await logAudit(req, "DELETE_SENSOR_READINGS", `Deleted ${result.affectedRows} sensor reading(s). IDs: ${cleanIds.join(", ")}`);

    res.json({
      message: `${result.affectedRows} reading${result.affectedRows === 1 ? "" : "s"} deleted.`,
      deleted: result.affectedRows,
    });
  } catch (err) {
    console.error("[AgosTech] deleteSensorReadings error:", err);
    res.status(500).json({ message: "Server error deleting sensor readings." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/alerts?status=unresolved|resolved|all&limit=50&page=1
// ─────────────────────────────────────────────────────────────────────────
async function getAlerts(req, res) {
  try {
    const status = req.query.status || "all";
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const page   = req.query.page ? Math.max(parseInt(req.query.page) || 1, 1) : null;

    let where = "";
    if (status === "unresolved") where = "WHERE a.status = 'unresolved'";
    if (status === "resolved")   where = "WHERE a.status = 'resolved'";

    if (page !== null) {
      const offset = (page - 1) * limit;

      const [rows] = await pool.query(
        `SELECT a.*, d.device_name, l.building_name, l.area_name
         FROM alerts a
         LEFT JOIN devices d ON a.device_id = d.device_id
         LEFT JOIN locations l ON d.location_id = l.location_id
         ${where}
         ORDER BY a.created_at DESC
         LIMIT ? OFFSET ?`,
        [limit, offset]
      );

      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM alerts a ${where}`
      );

      return res.json({
        data: rows,
        pagination: {
          page,
          limit,
          total: countRow.total,
          totalPages: Math.ceil(countRow.total / limit),
        }
      });
    }

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
    console.error("[AgosTech] getAlerts error:", err);
    res.status(500).json({ message: "Server error fetching alerts." });
  }
}

// POST /api/audit-logs/export
async function logExportAction(req, res) {
  try {
    const { action, details } = req.body;
    await logAudit(req, action || "EXPORT_PDF", details || "Exported PDF report");
    res.json({ message: "Export logged successfully" });
  } catch (err) {
    console.error("[AgosTech] logExportAction error:", err);
    res.status(500).json({ message: "Server error logging export." });
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
    await logAudit(req, "RESOLVE_ALERT", `Resolved alert ID: ${id}`);
    res.json({ message: "Alert marked as resolved." });
  } catch (err) {
    console.error("[AgosTech] resolveAlert error:", err);
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
    await logAudit(req, "DELETE_ALERT", `Deleted alert ID: ${id}`);
    res.json({ message: "Alert deleted successfully." });
  } catch (err) {
    console.error("[AgosTech] deleteAlert error:", err);

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

async function deleteAlerts(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Only administrators can delete alerts." });
    }

    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "Please provide at least one alert id to delete." });
    }

    const cleanIds = ids
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (cleanIds.length === 0) {
      return res.status(400).json({ message: "No valid alert ids were provided." });
    }

    const placeholders = cleanIds.map(() => "?").join(",");
    const [result] = await pool.query(
      `DELETE FROM alerts WHERE id IN (${placeholders})`,
      cleanIds
    );

    await logAudit(req, "DELETE_ALERTS", `Deleted ${result.affectedRows} alert(s). IDs: ${cleanIds.join(", ")}`);

    res.json({
      message: `${result.affectedRows} alert${result.affectedRows === 1 ? "" : "s"} deleted.`,
      deleted: result.affectedRows,
    });
  } catch (err) {
    console.error("[AgosTech] deleteAlerts error:", err);
    if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
      return res.status(409).json({
        message: "Some selected alerts have related SMS log records and can't be deleted yet.",
      });
    }
    res.status(500).json({ message: "Server error deleting alerts." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/devices
// ─────────────────────────────────────────────────────────────────────────
async function getDevices(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT d.*, l.building_name, l.area_name,
             sr.ph_level, sr.turbidity, sr.tds, sr.temperature, sr.ammonia, sr.flow_rate, sr.recorded_at,
             sr.recorded_at AS last_reading_at
      FROM devices d
      LEFT JOIN locations l ON d.location_id = l.location_id
      LEFT JOIN (
        SELECT * FROM sensor_readings
        WHERE id IN (SELECT MAX(id) FROM sensor_readings GROUP BY device_id)
      ) sr ON d.device_id = sr.device_id
      WHERE d.is_deleted = 0
      ORDER BY d.device_id ASC
    `);

    const enriched = rows.map(device => {
      let activeCount = 5;
      if (device.recorded_at) {
        activeCount = [
          device.ph_level,
          device.turbidity,
          device.tds,
          device.temperature,
          device.ammonia
        ].filter(v => v !== null).length;
      } else {
        activeCount = device.status === 'online' ? 5 : 0;
      }

      let uptime = 100.0;
      if (device.status === 'offline') {
        const lastTime = device.last_online || device.recorded_at;
        if (lastTime) {
          const offlineMs = Date.now() - new Date(lastTime).getTime();
          const offlineHours = offlineMs / (1000 * 60 * 60);
          uptime = Math.max(0, 100 - (offlineHours / 24) * 100);
        } else {
          uptime = 0;
        }
      } else {
        uptime = (activeCount / 5) * 100;
      }

      return {
        ...device,
        active_sensors_count: activeCount,
        uptime_percent: Number(uptime.toFixed(1))
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("[AgosTech] getDevices error:", err);
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
      "SELECT device_id FROM devices WHERE mqtt_topic = ? AND is_deleted = 0",
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

    // Dynamically subscribe to the new MQTT topic
    const mqttClient = req.app.get("mqttClient");
    if (mqttClient && mqttClient.connected) {
      mqttClient.subscribe(mqtt_topic.trim(), (err) => {
        if (err) {
          console.error(`[MQTT] Dynamic subscription failed for topic ${mqtt_topic.trim()}:`, err.message);
        } else {
          console.log(`[MQTT] Dynamically subscribed to new topic: ${mqtt_topic.trim()}`);
        }
      });
    }

    // ── Return the newly created device row ─────────────────────────────
    const [rows] = await pool.query(
      `SELECT d.*, l.building_name, l.area_name
       FROM devices d
       LEFT JOIN locations l ON d.location_id = l.location_id
       WHERE d.device_id = ?`,
      [result.insertId]
    );

    await logAudit(req, "CREATE_DEVICE", `Registered new device: ${device_name.trim()} (Topic: ${mqtt_topic.trim()})`);

    return res.status(201).json({
      message: "Device registered successfully.",
      device:  rows[0],
    });

  } catch (err) {
    console.error("[AgosTech] createDevice error:", err);
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
      LEFT JOIN devices d ON d.location_id = l.location_id AND d.is_deleted = 0
      GROUP BY l.location_id
      ORDER BY l.location_id ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[AgosTech] getLocations error:", err);
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

    await logAudit(req, "CREATE_LOCATION", `Added new location: ${building_name.trim()} - ${area_name.trim()}`);

    return res.status(201).json({
      message:  "Location added successfully.",
      location: rows[0],
    });
  } catch (err) {
    console.error("[AgosTech] createLocation error:", err);
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
    await logAudit(req, "DELETE_LOCATION", `Deleted location ID: ${id}`);
    res.json({ message: "Location deleted successfully." });
  } catch (err) {
    console.error("[AgosTech] deleteLocation error:", err);
    // FK constraint is ON DELETE SET NULL for devices, so this should
    // succeed even if devices are still attached — they'll just lose location_id
    res.status(500).json({ message: "Server error deleting location." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/analytics/summary (GSU / Admin analytics)
// ─────────────────────────────────────────────────────────────────────────
async function getAnalyticsSummary(req, res) {
  try {
    const [[weekConsumption]] = await pool.query(`
      SELECT COALESCE(SUM(water_consumed), 0) AS total 
      FROM sensor_readings 
      WHERE recorded_at >= NOW() - INTERVAL 7 DAY
    `);

    const [[deviceStats]] = await pool.query(`
      SELECT 
        SUM(status = 'online') AS online,
        COUNT(*) AS total
      FROM devices
      WHERE is_deleted = 0
    `);
    const onlineDevices = deviceStats?.online || 0;
    const totalDevices = deviceStats?.total || 0;
    const uptimePercent = totalDevices > 0 ? ((onlineDevices / totalDevices) * 100).toFixed(1) : "100.0";

    const [[alertStats]] = await pool.query(`
      SELECT 
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL 30 DAY THEN 1 END) AS total_month,
        COUNT(CASE WHEN status = 'unresolved' THEN 1 END) AS unresolved
      FROM alerts
    `);

    const [[phStats]] = await pool.query(`
      SELECT AVG(ph_level) AS avg_ph 
      FROM sensor_readings 
      WHERE recorded_at >= NOW() - INTERVAL 7 DAY AND ph_level IS NOT NULL
    `);

    // Generate consecutive calendar days for the last 7 days (including today)
    const dailyTotalsMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
      dailyTotalsMap[dateStr] = {
        day_date: dateStr,
        day_name: dayName,
        consumed: 0
      };
    }

    const [dbDailyTotals] = await pool.query(`
      SELECT 
        DATE_FORMAT(recorded_at, '%Y-%m-%d') as day_date, 
        DAYNAME(recorded_at) as day_name, 
        COALESCE(SUM(water_consumed), 0) as consumed
      FROM sensor_readings
      WHERE recorded_at >= NOW() - INTERVAL 7 DAY
      GROUP BY day_date, day_name
    `);

    // Merge actual database records into our consecutive 7 days list
    dbDailyTotals.forEach(row => {
      const dateStr = row.day_date;
      if (dailyTotalsMap[dateStr]) {
        dailyTotalsMap[dateStr].consumed = Number(row.consumed);
      }
    });

    const dailyTotals = Object.values(dailyTotalsMap).sort((a, b) => a.day_date.localeCompare(b.day_date));

    const [buildingDaily] = await pool.query(`
      SELECT 
        l.building_name, 
        COALESCE(SUM(sr.water_consumed), 0) as consumed
      FROM sensor_readings sr
      JOIN devices d ON sr.device_id = d.device_id
      JOIN locations l ON d.location_id = l.location_id
      WHERE sr.recorded_at >= NOW() - INTERVAL 7 DAY
      GROUP BY l.building_name
    `);

    const [dailyConsumption] = await pool.query(`
      SELECT 
        DATE(recorded_at) as date, 
        COALESCE(SUM(water_consumed), 0) as consumed 
      FROM sensor_readings 
      WHERE recorded_at >= CURDATE() - INTERVAL 6 DAY 
      GROUP BY DATE(recorded_at) 
      ORDER BY date ASC
    `);

    const [qualityAnomalies] = await pool.query(`
      SELECT COUNT(*) AS total FROM alerts WHERE parameter IN ('ph', 'turbidity', 'tds', 'ammonia')
    `);

    const [flowAnomalies] = await pool.query(`
      SELECT COUNT(*) AS total FROM alerts WHERE parameter = 'flow_rate'
    `);

    res.json({
      totalWeekConsumption: Number(weekConsumption?.total || 0),
      uptimePercent,
      onlineDevices,
      totalDevices,
      alertStats: {
        total_month: alertStats?.total_month || 0,
        unresolved: alertStats?.unresolved || 0,
      },
      avgPh: phStats ? phStats.avg_ph : null,
      qualityAnomalies: qualityAnomalies[0].total,
      flowAnomalies: flowAnomalies[0].total,
      buildingDaily,
      dailyTotals,
      dailyConsumption
    });
  } catch (err) {
    console.error("[AgosTech] getAnalyticsSummary error:", err);
    res.status(500).json({ message: "Server error fetching analytics summary." });
  }
}

// GET /api/reports/summary
async function getReportsSummary(req, res) {
  try {
    const startDate = req.query.startDate || "";
    const endDate = req.query.endDate || "";
    const buildingId = req.query.building_id || "";

    const conditions = [];
    const params = [];

    if (startDate) {
      conditions.push("sr.recorded_at >= ?");
      params.push(`${startDate} 00:00:00`);
    }
    if (endDate) {
      conditions.push("sr.recorded_at <= ?");
      params.push(`${endDate} 23:59:59`);
    }
    if (buildingId) {
      conditions.push("d.location_id = ?");
      params.push(parseInt(buildingId, 10));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 1. Water Quality Averages
    const [qualityRows] = await pool.query(`
      SELECT 
        AVG(sr.ph_level) AS avg_ph, 
        AVG(sr.turbidity) AS avg_turbidity, 
        AVG(sr.tds) AS avg_tds, 
        AVG(sr.temperature) AS avg_temperature,
        AVG(sr.ammonia) AS avg_ammonia,
        COUNT(CASE WHEN sr.ph_level < 6.5 OR sr.ph_level > 8.5 THEN 1 END) AS ph_violations,
        COUNT(CASE WHEN sr.turbidity > 5.0 THEN 1 END) AS turbidity_violations,
        COUNT(CASE WHEN sr.ammonia > 0.5 THEN 1 END) AS ammonia_violations,
        COUNT(CASE WHEN sr.temperature < 20.0 OR sr.temperature > 35.0 THEN 1 END) AS temperature_violations,
        COUNT(*) AS total_readings
      FROM sensor_readings sr
      JOIN devices d ON sr.device_id = d.device_id
      ${whereClause}
    `, params);

    // 2. Consumption Summary
    const [consumptionRows] = await pool.query(`
      SELECT 
        COALESCE(SUM(sr.water_consumed), 0) AS total_consumed, 
        AVG(sr.flow_rate) AS avg_flow_rate
      FROM sensor_readings sr
      JOIN devices d ON sr.device_id = d.device_id
      ${whereClause}
    `, params);

    // 3. Maintenance summary for timeframe
    const maintConditions = [];
    const maintParams = [];
    if (startDate) {
      maintConditions.push("ml.logged_date >= ?");
      maintParams.push(startDate);
    }
    if (endDate) {
      maintConditions.push("ml.logged_date <= ?");
      maintParams.push(endDate);
    }
    if (buildingId) {
      maintConditions.push("d.location_id = ?");
      maintParams.push(parseInt(buildingId, 10));
    }
    const maintWhere = maintConditions.length > 0 ? `WHERE ${maintConditions.join(" AND ")}` : "";
    
    const [maintRows] = await pool.query(`
      SELECT COUNT(*) AS total_maintenance_logs
      FROM maintenance_logs ml
      JOIN devices d ON ml.device_id = d.device_id
      ${maintWhere}
    `, maintParams);

    // Fetch active threshold standard setting
    let activeStandard = "pnsdw";
    let activeStandardName = "PNSDW 2017 Standards";
    try {
      const [stdRows] = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'active_threshold_standard'");
      if (stdRows && stdRows[0] && stdRows[0].setting_value) {
        activeStandard = stdRows[0].setting_value.toLowerCase().trim();
        activeStandardName = activeStandard === "who" ? "WHO Guidelines" : "PNSDW 2017 Standards";
      }
    } catch(e) {}

    res.json({
      waterQuality: qualityRows[0] || {},
      consumption: consumptionRows[0] || {},
      maintenance: maintRows[0] || {},
      active_threshold_standard: activeStandard,
      active_standard_name: activeStandardName
    });
  } catch (err) {
    console.error("[AgosTech] getReportsSummary error:", err);
    res.status(500).json({ message: "Server error generating reports summary." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/devices/health
// ─────────────────────────────────────────────────────────────────────────
async function getDevicesHealth(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT d.*, l.building_name, l.area_name,
             sr.ph_level, sr.turbidity, sr.tds, sr.temperature, sr.ammonia, sr.flow_rate, sr.recorded_at
      FROM devices d
      LEFT JOIN locations l ON d.location_id = l.location_id
      LEFT JOIN (
        SELECT * FROM sensor_readings
        WHERE id IN (SELECT MAX(id) FROM sensor_readings GROUP BY device_id)
      ) sr ON d.device_id = sr.device_id
      WHERE d.is_deleted = 0
      ORDER BY d.device_name ASC
    `);

    const enriched = rows.map(device => {
      // Count how many of the 5 core parameters are not null
      let activeCount = 5;
      if (device.recorded_at) {
        activeCount = [
          device.ph_level,
          device.turbidity,
          device.tds,
          device.temperature,
          device.ammonia
        ].filter(v => v !== null).length;
      } else {
        activeCount = device.status === 'online' ? 0 : 5;
      }

      let uptime = 100.0;
      if (device.status === 'offline') {
        const offlineMs = Date.now() - new Date(device.last_online).getTime();
        const offlineHours = offlineMs / (1000 * 60 * 60);
        uptime = Math.max(0, 100 - (offlineHours / 24) * 100);
      } else {
        // Online: uptime is based on reporting sensors (e.g. 5/5 -> 100%, 4/5 -> 80%)
        uptime = (activeCount / 5) * 100;
      }

      return {
        ...device,
        active_sensors_count: activeCount,
        uptime_percent: Number(uptime.toFixed(1))
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("[AgosTech] getDevicesHealth error:", err);
    res.status(500).json({ message: "Server error fetching device health." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/maintenance
// ─────────────────────────────────────────────────────────────────────────
async function getMaintenanceLogs(req, res) {
  try {
    const search = req.query.search || "";
    const deviceId = req.query.device_id || "";
    const range = req.query.range || "";

    const conditions = [];
    const params = [];

    if (deviceId) {
      conditions.push("ml.device_id = ?");
      params.push(parseInt(deviceId, 10));
    }

    if (range === "today") {
      conditions.push("DATE(ml.logged_date) = CURDATE()");
    } else if (range === "7d") {
      conditions.push("ml.logged_date >= DATE_SUB(NOW(), INTERVAL 7 DAY)");
    } else if (range === "30d") {
      conditions.push("ml.logged_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)");
    }

    if (search) {
      conditions.push("(LOWER(ml.title) LIKE ? OR LOWER(ml.detail) LIKE ? OR LOWER(ml.repaired_by) LIKE ? OR LOWER(d.device_name) LIKE ?)");
      const term = `%${search.toLowerCase()}%`;
      params.push(term, term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await pool.query(`
      SELECT ml.*, d.device_name, l.building_name, l.area_name
      FROM maintenance_logs ml
      JOIN devices d ON ml.device_id = d.device_id
      LEFT JOIN locations l ON d.location_id = l.location_id
      ${whereClause}
      ORDER BY ml.logged_date DESC, ml.id DESC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error("[AgosTech] getMaintenanceLogs error:", err);
    res.status(500).json({ message: "Server error fetching maintenance logs." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/maintenance
// ─────────────────────────────────────────────────────────────────────────
async function createMaintenanceLog(req, res) {
  const { device_id, title, detail, tags, repaired_by, logged_date } = req.body || {};

  if (!device_id) {
    return res.status(400).json({ message: "Device ID is required." });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ message: "Title is required." });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO maintenance_logs (device_id, title, detail, tags, repaired_by, logged_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        device_id,
        title.trim(),
        detail?.trim() || null,
        tags?.trim() || null,
        repaired_by?.trim() || null,
        logged_date || new Date().toISOString().slice(0, 10),
      ]
    );

    await logAudit(req, "CREATE_MAINTENANCE", `Logged maintenance activity: ${title.trim()} (Device ID: ${device_id})`);

    res.status(201).json({
      message: "Maintenance log added successfully.",
      logId: result.insertId,
    });
  } catch (err) {
    console.error("[AgosTech] createMaintenanceLog error:", err);
    res.status(500).json({ message: "Server error adding maintenance log." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/sensors/export (Export all or filtered logs)
// ─────────────────────────────────────────────────────────────────────────
async function exportSensorReadings(req, res) {
  try {
    const deviceId = req.query.device_id;
    const range    = req.query.range;

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
       ORDER BY sr.recorded_at DESC`,
      params
    );

    const enrichedRows = rows.map(r => ({
      ...r,
      classification: classifyWaterQuality(r)
    }));

    await logAudit(req, "EXPORT_CSV", `Exported sensor readings to CSV (Filters: Device ID=${deviceId || 'all'}, Range=${range || 'all'}, Count=${rows.length})`);

    res.json(enrichedRows);
  } catch (err) {
    console.error("[AgosTech] exportSensorReadings error:", err);
    res.status(500).json({ message: "Server error exporting sensor readings." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/audit-logs (Admin only)
async function getAuditLogs(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Only administrators can view audit logs." });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const offset = (page - 1) * limit;

    const search = req.query.search || "";
    const role = req.query.role || "";

    const conditions = [];
    const params = [];

    if (role) {
      conditions.push("LOWER(role) = ?");
      params.push(role.toLowerCase());
    }

    if (search) {
      conditions.push("(LOWER(username) LIKE ? OR LOWER(action) LIKE ? OR LOWER(details) LIKE ?)");
      const term = `%${search.toLowerCase()}%`;
      params.push(term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM audit_logs ${whereClause}`,
      params
    );
    const total = countRow.total;

    const dataParams = [...params, limit, offset];
    const [rows] = await pool.query(
      `SELECT * FROM audit_logs 
       ${whereClause} 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      dataParams
    );

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("[AgosTech] getAuditLogs error:", err);
    res.status(500).json({ message: "Server error fetching audit logs." });
  }
}

// DELETE /api/audit-logs/:id (Admin only)
async function deleteAuditLog(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Only administrators can delete audit logs." });
    }

    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM audit_logs WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Audit log not found." });
    }

    res.json({ message: "Audit log deleted successfully." });
  } catch (err) {
    console.error("[AgosTech] deleteAuditLog error:", err);
    res.status(500).json({ message: "Server error deleting audit log." });
  }
}

// DELETE /api/audit-logs (Admin only)
async function deleteAuditLogsBulk(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Only administrators can delete audit logs." });
    }

    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "Please provide audit log IDs to delete." });
    }

    const cleanIds = ids
      .map(id => parseInt(id, 10))
      .filter(id => Number.isInteger(id) && id > 0);

    if (cleanIds.length === 0) {
      return res.status(400).json({ message: "No valid audit log IDs were provided." });
    }

    const placeholders = cleanIds.map(() => "?").join(",");
    const [result] = await pool.query(
      `DELETE FROM audit_logs WHERE id IN (${placeholders})`,
      cleanIds
    );

    res.json({
      message: `${result.affectedRows} audit log(s) deleted successfully.`,
      deleted: result.affectedRows,
    });
  } catch (err) {
    console.error("[AgosTech] deleteAuditLogsBulk error:", err);
    res.status(500).json({ message: "Server error deleting audit logs." });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/analytics/compliance-trend?device_id=
// 7-day average metrics for pH, turbidity, and ammonia (health parameters)
// ─────────────────────────────────────────────────────────────────────────
async function getComplianceTrend(req, res) {
  try {
    const deviceId = req.query.device_id;
    const conditions = ["recorded_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)"];
    const params = [];

    if (deviceId) {
      conditions.push("device_id = ?");
      params.push(deviceId);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const [dbRows] = await pool.query(
      `SELECT 
         DATE_FORMAT(recorded_at, '%Y-%m-%d') AS day_date,
         DAYNAME(recorded_at) AS day_name,
         AVG(ph_level) AS avg_ph,
         AVG(turbidity) AS avg_turbidity,
         AVG(ammonia) AS avg_ammonia
       FROM sensor_readings
       ${where}
       GROUP BY day_date, day_name
       ORDER BY day_date ASC`,
      params
    );

    // Generate last 7 days map
    const dailyAveragesMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
      dailyAveragesMap[dateStr] = {
        day_date: dateStr,
        day_name: dayName,
        avg_ph: null,
        avg_turbidity: null,
        avg_ammonia: null,
      };
    }

    // Merge database results
    dbRows.forEach(row => {
      const dateStr = row.day_date;
      if (dailyAveragesMap[dateStr]) {
        dailyAveragesMap[dateStr].avg_ph = row.avg_ph !== null ? Number(row.avg_ph) : null;
        dailyAveragesMap[dateStr].avg_turbidity = row.avg_turbidity !== null ? Number(row.avg_turbidity) : null;
        dailyAveragesMap[dateStr].avg_ammonia = row.avg_ammonia !== null ? Number(row.avg_ammonia) : null;
      }
    });

    const dailyAverages = Object.values(dailyAveragesMap).sort((a, b) => a.day_date.localeCompare(b.day_date));

    res.json(dailyAverages);
  } catch (err) {
    console.error("[AgosTech] getComplianceTrend error:", err);
    res.status(500).json({ message: "Server error fetching compliance trends." });
  }
}

// DELETE /api/maintenance/:id
async function deleteMaintenanceLog(req, res) {
  const logId = req.params.id;
  try {
    const [[log]] = await pool.query("SELECT * FROM maintenance_logs WHERE id = ?", [logId]);
    if (!log) {
      return res.status(404).json({ message: "Maintenance log not found." });
    }

    await pool.query("DELETE FROM maintenance_logs WHERE id = ?", [logId]);

    // Log this action to the audit logs
    await logAudit(req, "DELETE_MAINTENANCE", `Deleted maintenance activity: ${log.title} (Device ID: ${log.device_id})`);

    res.json({ message: "Maintenance log deleted successfully." });
  } catch (err) {
    console.error("[AgosTech] deleteMaintenanceLog error:", err);
    res.status(500).json({ message: "Server error deleting maintenance log." });
  }
}

// GET /api/sms-logs (Paginated & Filterable)
async function getSmsLogs(req, res) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 200);
    const offset = (page - 1) * limit;

    const search = req.query.search || "";
    const status = req.query.status || "";

    const conditions = [];
    const params = [];

    if (status) {
      conditions.push("LOWER(s.status) = ?");
      params.push(status.toLowerCase());
    }

    if (search) {
      conditions.push("(LOWER(s.message) LIKE ? OR LOWER(s.recipient) LIKE ? OR LOWER(s.device_id) LIKE ? OR LOWER(l.building_name) LIKE ?)");
      const term = `%${search.toLowerCase()}%`;
      params.push(term, term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [statRows] = await pool.query(
      `SELECT 
        COUNT(*) AS totalCount,
        SUM(CASE WHEN LOWER(status) = 'sent' THEN 1 ELSE 0 END) AS sentCount,
        SUM(CASE WHEN LOWER(status) = 'failed' THEN 1 ELSE 0 END) AS failedCount,
        SUM(CASE WHEN LOWER(status) = 'pending' THEN 1 ELSE 0 END) AS pendingCount
       FROM sms_logs`
    );
    const overallStats = {
      total: statRows[0]?.totalCount || 0,
      sent: Number(statRows[0]?.sentCount) || 0,
      failed: Number(statRows[0]?.failedCount) || 0,
      pending: Number(statRows[0]?.pendingCount) || 0
    };

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total 
       FROM sms_logs s 
       LEFT JOIN devices d ON s.device_id = d.device_id 
       LEFT JOIN locations l ON d.location_id = l.location_id 
       ${whereClause}`,
      params
    );
    const total = countRow ? countRow.total : 0;

    const dataParams = [...params, limit, offset];
    const [rows] = await pool.query(
      `SELECT s.*, d.device_name, l.building_name, l.area_name
       FROM sms_logs s
       LEFT JOIN devices d ON s.device_id = d.device_id
       LEFT JOIN locations l ON d.location_id = l.location_id
       ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
      dataParams
    );

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1
      },
      stats: overallStats
    });
  } catch (err) {
    console.error("[AgosTech] getSmsLogs error:", err);
    res.status(500).json({ message: "Server error fetching SMS logs." });
  }
}

// DELETE /api/sms-logs/:id (Admin only)
async function deleteSmsLog(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Only administrators can delete SMS logs." });
    }

    const { id } = req.params;
    const [rows] = await pool.query("SELECT * FROM sms_logs WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "SMS log not found." });
    }

    const log = rows[0];
    await pool.query("DELETE FROM sms_logs WHERE id = ?", [id]);
    await logAudit(req, "DELETE_SMS_LOG", `Deleted SMS log ID: ${id} sent to ${log.recipient}`);

    res.json({ message: "SMS log deleted successfully." });
  } catch (err) {
    console.error("[AgosTech] deleteSmsLog error:", err);
    res.status(500).json({ message: "Server error deleting SMS log." });
  }
}

// DELETE /api/sms-logs (Bulk Delete - Admin only)
async function deleteSmsLogsBulk(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Only administrators can delete SMS logs." });
    }

    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "Please provide SMS log IDs to delete." });
    }

    const cleanIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    if (cleanIds.length === 0) {
      return res.status(400).json({ message: "Invalid SMS log IDs provided." });
    }

    const [result] = await pool.query("DELETE FROM sms_logs WHERE id IN (?)", [cleanIds]);
    await logAudit(req, "BULK_DELETE_SMS_LOGS", `Deleted ${result.affectedRows} SMS log(s). IDs: ${cleanIds.join(", ")}`);

    res.json({ message: `${result.affectedRows} SMS log(s) deleted successfully.` });
  } catch (err) {
    console.error("[AgosTech] deleteSmsLogsBulk error:", err);
    res.status(500).json({ message: "Server error deleting SMS logs." });
  }
}

async function ensureThresholdTableSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS threshold_settings (
      id             INT          NOT NULL AUTO_INCREMENT,
      parameter_name VARCHAR(50)  NOT NULL UNIQUE,
      min_value      DECIMAL(10,2) NOT NULL,
      max_value      DECIMAL(10,2) NOT NULL,
      unit           VARCHAR(20)  NULL DEFAULT '',
      description    VARCHAR(255) NULL,
      created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  try {
    await pool.query("ALTER TABLE threshold_settings ADD COLUMN unit VARCHAR(20) NULL DEFAULT ''");
  } catch (e) {}

  try {
    await pool.query("ALTER TABLE threshold_settings ADD COLUMN description VARCHAR(255) NULL");
  } catch (e) {}

  try {
    await pool.query("UPDATE threshold_settings SET parameter_name = LOWER(TRIM(parameter_name))");
  } catch (e) {}
}

// GET /api/thresholds
async function getThresholds(req, res) {
  try {
    await ensureThresholdTableSchema();

    let [rows] = await pool.query("SELECT * FROM threshold_settings ORDER BY parameter_name ASC");

    if (rows.length === 0) {
      const defaultThresholds = [
        ["ph", 6.50, 8.50, "pH", "Acidity / Alkalinity (PNSDW 2017)"],
        ["tds", 0.00, 500.00, "ppm", "Total Dissolved Solids (PNSDW 2017)"],
        ["temperature", 0.00, 35.00, "°C", "Water Thermal Level (PNSDW 2017)"],
        ["turbidity", 0.00, 5.00, "NTU", "Water Clarity / Cloudiness (PNSDW 2017)"],
        ["ammonia", 0.00, 0.50, "mg/L", "NH3 Concentration (PNSDW 2017)"],
        ["flow_rate", 0.00, 100.00, "L/min", "Water Volume Flow Rate"]
      ];
      for (const [param, minV, maxV, unit, desc] of defaultThresholds) {
        try {
          await pool.query(
            "INSERT IGNORE INTO threshold_settings (parameter_name, min_value, max_value, unit, description) VALUES (?, ?, ?, ?, ?)",
            [param, minV, maxV, unit, desc]
          );
        } catch (e) {
          await pool.query(
            "INSERT IGNORE INTO threshold_settings (parameter_name, min_value, max_value) VALUES (?, ?, ?)",
            [param, minV, maxV]
          );
        }
      }
      [rows] = await pool.query("SELECT * FROM threshold_settings ORDER BY parameter_name ASC");
    }

    res.json(rows);
  } catch (err) {
    console.error("[AgosTech] getThresholds error:", err);
    res.status(500).json({ message: "Server error fetching threshold settings." });
  }
}

// PUT /api/thresholds (Admin only)
async function updateThresholds(req, res) {
  try {
    if ((req.user?.role || "").toLowerCase() !== "admin") {
      return res.status(403).json({ message: "Only administrators can update threshold settings." });
    }

    await ensureThresholdTableSchema();

    let thresholds = req.body?.thresholds;
    if (!thresholds && Array.isArray(req.body)) {
      thresholds = req.body;
    }
    if (!thresholds && req.body && typeof req.body === "object" && req.body.parameter_name) {
      thresholds = [req.body];
    }

    if (!Array.isArray(thresholds) || thresholds.length === 0) {
      return res.status(400).json({ message: "Invalid payload. Provide thresholds array." });
    }

    const units = { ph: "pH", tds: "ppm", temperature: "°C", turbidity: "NTU", ammonia: "mg/L", flow_rate: "L/min" };
    const updatedParams = [];

    for (const item of thresholds) {
      const { parameter_name, min_value, max_value } = item;
      if (!parameter_name || min_value === undefined || max_value === undefined) continue;

      const minV = Number(min_value);
      const maxV = Number(max_value);

      if (isNaN(minV) || isNaN(maxV)) {
        return res.status(400).json({ message: `Invalid numeric threshold for parameter: ${parameter_name}` });
      }
      if (minV > maxV) {
        return res.status(400).json({ message: `Minimum threshold (${minV}) cannot be greater than Maximum (${maxV}) for ${parameter_name}` });
      }

      const pKey = String(parameter_name).toLowerCase().trim();
      const unit = units[pKey] || "";

      // Safe update matching lowercase or raw parameter_name
      const [updRes] = await pool.query(
        "UPDATE threshold_settings SET min_value = ?, max_value = ? WHERE LOWER(TRIM(parameter_name)) = ? OR parameter_name = ?",
        [minV, maxV, pKey, parameter_name]
      );

      // If no row existed yet, insert safely
      if (updRes.affectedRows === 0) {
        try {
          await pool.query(
            "INSERT INTO threshold_settings (parameter_name, min_value, max_value, unit) VALUES (?, ?, ?, ?)",
            [pKey, minV, maxV, unit]
          );
        } catch (e) {
          await pool.query(
            "INSERT INTO threshold_settings (parameter_name, min_value, max_value) VALUES (?, ?, ?)",
            [pKey, minV, maxV]
          );
        }
      }

      updatedParams.push(`${pKey}: [${minV} - ${maxV}]`);
    }

    if (updatedParams.length > 0) {
      try {
        await logAudit(req, "UPDATE_THRESHOLDS", `Updated parameter thresholds: ${updatedParams.join(", ")}`);
      } catch (e) {
        console.warn("[AgosTech] logAudit warning in updateThresholds:", e.message);
      }
    }

    const [rows] = await pool.query("SELECT * FROM threshold_settings ORDER BY parameter_name ASC");
    res.json({ message: "Threshold settings updated successfully.", thresholds: rows });
  } catch (err) {
    console.error("[AgosTech] updateThresholds error:", err);
    res.status(500).json({ message: err.message || "Server error updating threshold settings." });
  }
}

// POST /api/thresholds/reset (Admin only)
async function resetThresholds(req, res) {
  try {
    if ((req.user?.role || "").toLowerCase() !== "admin") {
      return res.status(403).json({ message: "Only administrators can reset threshold settings." });
    }

    await ensureThresholdTableSchema();

    const { standard } = req.body || {};
    const activeStdKey = standard === "who" ? "who" : "pnsdw";
    let defaults;
    let stdName;

    if (standard === "who") {
      stdName = "WHO Guidelines for Drinking-water Quality";
      defaults = [
        ["ph", 6.50, 8.50, "pH"],
        ["tds", 0.00, 600.00, "ppm"],
        ["temperature", 0.00, 30.00, "°C"],
        ["turbidity", 0.00, 1.00, "NTU"],
        ["ammonia", 0.00, 1.50, "mg/L"],
        ["flow_rate", 0.00, 100.00, "L/min"]
      ];
    } else {
      stdName = "PNSDW 2017 Standards";
      defaults = [
        ["ph", 6.50, 8.50, "pH"],
        ["tds", 0.00, 500.00, "ppm"],
        ["temperature", 0.00, 35.00, "°C"],
        ["turbidity", 0.00, 5.00, "NTU"],
        ["ammonia", 0.00, 0.50, "mg/L"],
        ["flow_rate", 0.00, 100.00, "L/min"]
      ];
    }

    try {
      await pool.query(
        "INSERT INTO system_settings (setting_key, setting_value) VALUES ('active_threshold_standard', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
        [activeStdKey, activeStdKey]
      );
    } catch(e) {}

    for (const [param, minV, maxV, unit] of defaults) {
      const pKey = String(param).toLowerCase().trim();
      const [updRes] = await pool.query(
        "UPDATE threshold_settings SET min_value = ?, max_value = ? WHERE LOWER(TRIM(parameter_name)) = ? OR parameter_name = ?",
        [minV, maxV, pKey, param]
      );

      if (updRes.affectedRows === 0) {
        try {
          await pool.query(
            "INSERT INTO threshold_settings (parameter_name, min_value, max_value, unit) VALUES (?, ?, ?, ?)",
            [param, minV, maxV, unit]
          );
        } catch (e) {
          await pool.query(
            "INSERT INTO threshold_settings (parameter_name, min_value, max_value) VALUES (?, ?, ?)",
            [param, minV, maxV]
          );
        }
      }
    }

    try {
      await logAudit(req, "RESET_THRESHOLDS", `Reset water quality threshold parameters to ${stdName}`);
    } catch (e) {
      console.warn("[AgosTech] logAudit warning in resetThresholds:", e.message);
    }

    const [rows] = await pool.query("SELECT * FROM threshold_settings ORDER BY parameter_name ASC");
    res.json({ message: `Thresholds reset to ${stdName} defaults successfully.`, thresholds: rows });
  } catch (err) {
    console.error("[AgosTech] resetThresholds error:", err);
    res.status(500).json({ message: err.message || "Server error resetting threshold settings." });
  }
}

// GET /api/system-settings
async function getSystemSettings(req, res) {
  try {
    const [systemRows] = await pool.query("SELECT * FROM system_settings");
    const settings = {};
    systemRows.forEach(r => {
      settings[r.setting_key] = isNaN(Number(r.setting_value)) ? r.setting_value : Number(r.setting_value);
    });

    // If user is authenticated, fetch their custom settings
    if (req.user && req.user.id) {
      const [userRows] = await pool.query(
        "SELECT setting_key, setting_value FROM user_settings WHERE user_id = ?",
        [req.user.id]
      );
      userRows.forEach(r => {
        settings[r.setting_key] = isNaN(Number(r.setting_value)) ? r.setting_value : Number(r.setting_value);
      });
    }

    res.json(settings);
  } catch (err) {
    console.error("[AgosTech] getSystemSettings error:", err);
    res.status(500).json({ message: "Server error fetching system settings." });
  }
}

// PUT /api/system-settings
async function updateSystemSettings(req, res) {
  try {
    const payload = req.body || {};
    const updatedKeys = [];
    
    const USER_SETTINGS_KEYS = new Set([
      "sms_alerts",
      "critical_alerts_only",
      "device_offline_alerts",
      "daily_summary_report",
      "auto_refresh_dashboard"
    ]);

    const SYSTEM_SETTINGS_KEYS = new Set([
      "data_logging",
      "maintenance_mode",
      "google_oauth_login",
      "report_header_title",
      "report_header_subtitle",
      "report_header_address",
      "report_logo_base64",
      "esp_telemetry_interval_sec"
    ]);

    const userRole = (req.user?.role || "").toLowerCase();
    const isAdmin = userRole === "admin" || userRole === "gsu" || userRole === "hsu"; // Allow system management roles

    for (const [key, value] of Object.entries(payload)) {
      const valStr = String(value);

      if (USER_SETTINGS_KEYS.has(key)) {
        if (req.user && req.user.id) {
          await pool.query(
            `INSERT INTO user_settings (user_id, setting_key, setting_value) 
             VALUES (?, ?, ?) 
             ON DUPLICATE KEY UPDATE setting_value = ?`,
            [req.user.id, key, valStr, valStr]
          );
          updatedKeys.push(key);
        }
      } else if (SYSTEM_SETTINGS_KEYS.has(key)) {
        if (!isAdmin) {
          console.warn(`[AgosTech] User ${req.user?.email} (Role: ${req.user?.role}) denied permission to update system setting: ${key}`);
          return res.status(403).json({ message: "Access denied. Admin privileges required to update system settings." });
        }

        if (key === 'report_logo_base64' && valStr && !valStr.startsWith('data:image/')) {
          return res.status(400).json({ message: "Invalid format: Logo must be an image file." });
        }

        if (key === 'esp_telemetry_interval_sec') {
          const intervalSec = parseInt(valStr);
          if (isNaN(intervalSec) || intervalSec < 3 || intervalSec > 7200) {
            return res.status(400).json({ message: "Invalid interval. Please enter a value between 3 seconds and 7200 seconds (2 hours)." });
          }
        }

        await pool.query(
          `INSERT INTO system_settings (setting_key, setting_value) 
           VALUES (?, ?) 
           ON DUPLICATE KEY UPDATE setting_value = ?`,
          [key, valStr, valStr]
        );
        updatedKeys.push(key);
        console.log(`[AgosTech] Successfully saved system setting to MySQL: ${key} = ${valStr}`);

        // If ESP Telemetry Interval changed, publish config via MQTT to all ESP32 devices
        if (key === 'esp_telemetry_interval_sec') {
          const intervalSec = parseInt(valStr);
          const mqttClient = req.app.get("mqttClient");
          if (mqttClient && mqttClient.connected) {
            const configPacket = JSON.stringify({
              action: "update_interval",
              interval_sec: intervalSec,
              interval_ms: intervalSec * 1000
            });

            // 1. Publish to global system-wide config topic
            mqttClient.publish("esp32/agostech/config", configPacket, { retain: true, qos: 1 }, (mqttErr) => {
              if (mqttErr) console.error("[MQTT] Error broadcasting ESP sending interval:", mqttErr.message);
              else console.log(`[MQTT] Published new ESP telemetry interval (${intervalSec}s / ${intervalSec * 1000}ms) to global topic: esp32/agostech/config`);
            });

            // 2. Publish to all registered device specific config topics (e.g. esp32/agostech/data/config)
            try {
              const [devs] = await pool.query("SELECT mqtt_topic FROM devices WHERE is_deleted = 0");
              for (const dev of devs) {
                if (dev.mqtt_topic && dev.mqtt_topic.trim()) {
                  const devTopic = dev.mqtt_topic.trim();
                  const devConfigTopic = devTopic.endsWith("/config") ? devTopic : `${devTopic}/config`;
                  mqttClient.publish(devConfigTopic, configPacket, { retain: true, qos: 1 });
                }
              }
            } catch (devErr) {
              console.error("[MQTT] Error broadcasting interval to per-device config topics:", devErr.message);
            }
          } else {
            console.warn("[MQTT] Warning: MQTT client is disconnected. Setting saved to MySQL, but MQTT broadcast pending reconnect.");
          }
        }
      }
    }

    if (updatedKeys.length > 0) {
      await logAudit(req, "UPDATE_SYSTEM_SETTINGS", `Updated settings: ${updatedKeys.join(", ")}`);
    }

    res.json({ message: "Settings updated successfully.", updatedKeys });
  } catch (err) {
    console.error("[AgosTech] updateSystemSettings error:", err);
    res.status(500).json({ message: "Server error updating system settings." });
  }
}

// GET /api/system-settings/google-oauth (public)
async function getGoogleOauthSetting(req, res) {
  try {
    const [[row]] = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'google_oauth_login'");
    const enabled = row ? row.setting_value === "1" : true;
    res.json({ enabled });
  } catch (err) {
    console.error("[AgosTech] getGoogleOauthSetting error:", err);
    res.json({ enabled: true });
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
  deleteAlerts,
  getDevices,
  createDevice,
  getLocations,
  createLocation,
  deleteLocation,
  getAnalyticsSummary,
  getComplianceTrend,
  getDevicesHealth,
  getMaintenanceLogs,
  createMaintenanceLog,
  deleteMaintenanceLog,
  exportSensorReadings,
  getAuditLogs,
  deleteAuditLog,
  deleteAuditLogsBulk,
  logExportAction,
  getSmsLogs,
  deleteSmsLog,
  deleteSmsLogsBulk,
  getThresholds,
  updateThresholds,
  resetThresholds,
  getSystemSettings,
  updateSystemSettings,
  getGoogleOauthSetting,
  getReportsSummary,
};