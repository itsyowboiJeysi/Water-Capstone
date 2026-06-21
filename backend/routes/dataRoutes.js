const express = require("express");
const router  = express.Router();
const verifyToken = require("../middleware/authMiddleware");
const {
  getDashboardSummary,
  getLatestReadings,
  getSensorReadings,
  deleteSensorReadings,
  getAlerts,
  resolveAlert,
  getDevices,
  createDevice,
  getLocations,
  createLocation,   // ← add
  deleteLocation,   // ← add
} = require("../controllers/dataController");
const {
  updateDevice,
  updateDeviceStatus,
  deleteDevice,
} = require("../controllers/deviceController");

router.get  ("/dashboard/summary",      verifyToken, getDashboardSummary);
router.get  ("/sensors/latest",         verifyToken, getLatestReadings);
router.get  ("/sensors",                verifyToken, getSensorReadings);
router.delete("/sensors",               verifyToken, deleteSensorReadings);  // ← BULK DELETE READINGS
router.get  ("/alerts",                 verifyToken, getAlerts);
router.patch("/alerts/:id/resolve",     verifyToken, resolveAlert);
router.get  ("/devices",                verifyToken, getDevices);
router.post ("/devices",                verifyToken, createDevice);   // ← ADD DEVICE
router.put  ("/devices/:id",            verifyToken, updateDevice);
router.patch("/devices/:id/status",     verifyToken, updateDeviceStatus);
router.delete("/devices/:id",           verifyToken, deleteDevice);   // ← FIX: was missing, caused "Network error" on delete
router.get  ("/locations",              verifyToken, getLocations);
router.post  ("/locations",     verifyToken, createLocation);   // ← ADD LOCATION
router.delete("/locations/:id", verifyToken, deleteLocation); 

module.exports = router;