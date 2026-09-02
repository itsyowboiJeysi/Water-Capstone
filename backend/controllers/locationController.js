// controllers/locationController.js — AgosTech Locations
const { pool } = require("../config/db");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/locations
// Returns all locations (used for dropdown + table view)
// ─────────────────────────────────────────────────────────────────────────────
async function getLocations(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT location_id, building_name, area_name, description, created_at
       FROM locations
       ORDER BY building_name ASC`
    );
    return res.status(200).json(rows);
  } catch (err) {
    console.error("[AgosTech] getLocations error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/locations
// Body: { building_name, area_name, description }
// Admin only — enforce with verifyToken + requireRole("admin") middleware on the route
// ─────────────────────────────────────────────────────────────────────────────
async function createLocation(req, res) {
  const { building_name, area_name, description } = req.body || {};

  if (!building_name || !building_name.trim()) {
    return res.status(400).json({ message: "Building name is required." });
  }
  if (!area_name || !area_name.trim()) {
    return res.status(400).json({ message: "Area / Zone is required." });
  }

  try {
    // Prevent exact duplicate building+area combos
    const [existing] = await pool.query(
      "SELECT location_id FROM locations WHERE building_name = ? AND area_name = ?",
      [building_name.trim(), area_name.trim()]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: "This location already exists." });
    }

    const [result] = await pool.query(
      `INSERT INTO locations (building_name, area_name, description)
       VALUES (?, ?, ?)`,
      [building_name.trim(), area_name.trim(), description ? description.trim() : null]
    );

    const [newRow] = await pool.query(
      "SELECT location_id, building_name, area_name, description, created_at FROM locations WHERE location_id = ?",
      [result.insertId]
    );

    return res.status(201).json({
      message: "Location added successfully!",
      location: newRow[0],
    });

  } catch (err) {
    console.error("[AgosTech] createLocation error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/locations/:id
// Body: { building_name, area_name, description }
// ─────────────────────────────────────────────────────────────────────────────
async function updateLocation(req, res) {
  const { id } = req.params;
  const { building_name, area_name, description } = req.body || {};

  if (!building_name || !building_name.trim()) {
    return res.status(400).json({ message: "Building name is required." });
  }
  if (!area_name || !area_name.trim()) {
    return res.status(400).json({ message: "Area / Zone is required." });
  }

  try {
    const [existing] = await pool.query("SELECT location_id FROM locations WHERE location_id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Location not found." });
    }

    await pool.query(
      `UPDATE locations
       SET building_name = ?, area_name = ?, description = ?
       WHERE location_id = ?`,
      [building_name.trim(), area_name.trim(), description ? description.trim() : null, id]
    );

    return res.status(200).json({ message: "Location updated successfully." });

  } catch (err) {
    console.error("[AgosTech] updateLocation error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/locations/:id
// ─────────────────────────────────────────────────────────────────────────────
async function deleteLocation(req, res) {
  const { id } = req.params;

  try {
    const [existing] = await pool.query("SELECT location_id FROM locations WHERE location_id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Location not found." });
    }

    await pool.query("DELETE FROM locations WHERE location_id = ?", [id]);

    return res.status(200).json({ message: "Location deleted successfully." });

  } catch (err) {
    // Likely a foreign key constraint (devices still reference this location)
    console.error("[AgosTech] deleteLocation error:", err);
    if (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451) {
      return res.status(409).json({ message: "Cannot delete — devices are still assigned to this location." });
    }
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

module.exports = { getLocations, createLocation, updateLocation, deleteLocation };