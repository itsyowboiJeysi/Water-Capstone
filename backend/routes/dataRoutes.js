const express = require("express");
const router  = express.Router();
const verifyToken = require("../middleware/authMiddleware");
const {
  getDashboardSummary,
  getLatestReadings,
  getSensorReadings,
  getAlerts,
  resolveAlert,
  getDevices,
  createDevice,
  getLocations,
} = require("../controllers/dataController");

router.get  ("/dashboard/summary",      verifyToken, getDashboardSummary);
router.get  ("/sensors/latest",         verifyToken, getLatestReadings);
router.get  ("/sensors",                verifyToken, getSensorReadings);
router.get  ("/alerts",                 verifyToken, getAlerts);
router.patch("/alerts/:id/resolve",     verifyToken, resolveAlert);
router.get  ("/devices",                verifyToken, getDevices);
router.post ("/devices",                verifyToken, createDevice);   // ← ADD DEVICE
router.get  ("/locations",              verifyToken, getLocations);

module.exports = router;