const express = require("express");
const router  = express.Router();
// Destructure verifyToken and requireAdmin from authMiddleware
const { verifyToken, requireAdmin } = require("../middleware/authMiddleware");
const {
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
  getDevicesHealth,
  getMaintenanceLogs,
  createMaintenanceLog,
  exportSensorReadings,
  getAuditLogs,
} = require("../controllers/dataController");
const {
  updateDevice,
  updateDeviceStatus,
  deleteDevice,
} = require("../controllers/deviceController");

// Read-only routes (accessible by Admin, HSU, GSU)
router.get  ("/dashboard/summary",      verifyToken, getDashboardSummary);
router.get  ("/sensors/latest",         verifyToken, getLatestReadings);
router.get  ("/sensors",                verifyToken, getSensorReadings);
router.get  ("/sensors/export",         verifyToken, exportSensorReadings);
router.get  ("/alerts",                 verifyToken, getAlerts);
router.get  ("/devices",                verifyToken, getDevices);
router.get  ("/locations",              verifyToken, getLocations);
router.get  ("/analytics/summary",      verifyToken, getAnalyticsSummary);
router.get  ("/devices/health",         verifyToken, getDevicesHealth);
router.get  ("/maintenance",            verifyToken, getMaintenanceLogs);

// GSU and Admin can submit maintenance logs
router.post ("/maintenance",            verifyToken, createMaintenanceLog);

// Audit logs (RESTRICTED: Admin only)
router.get  ("/audit-logs",             verifyToken, requireAdmin, getAuditLogs);

// CRUD routes (RESTRICTED: Admin only)
router.delete("/sensors",               verifyToken, requireAdmin, deleteSensorReadings); // Bulk delete readings
router.delete("/alerts",                verifyToken, requireAdmin, deleteAlerts);
router.patch("/alerts/:id/resolve",     verifyToken, requireAdmin, resolveAlert);
router.delete("/alerts/:id",            verifyToken, requireAdmin, deleteAlert);
router.post ("/devices",                verifyToken, requireAdmin, createDevice);
router.put  ("/devices/:id",            verifyToken, requireAdmin, updateDevice);
router.patch("/devices/:id/status",     verifyToken, requireAdmin, updateDeviceStatus);
router.delete("/devices/:id",           verifyToken, requireAdmin, deleteDevice);
router.post  ("/locations",             verifyToken, requireAdmin, createLocation);
router.delete("/locations/:id",         verifyToken, requireAdmin, deleteLocation);

module.exports = router;