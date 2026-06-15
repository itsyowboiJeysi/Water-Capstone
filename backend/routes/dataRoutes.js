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
  getLocations,
  getAnalyticsSummary,
  getSmsLogs, 
} = require("../controllers/dataController");

router.get("/dashboard/summary", verifyToken, getDashboardSummary);
router.get("/sensors/latest",    verifyToken, getLatestReadings);
router.get("/sensors",           verifyToken, getSensorReadings);
router.get("/alerts",            verifyToken, getAlerts);
router.patch("/alerts/:id/resolve", verifyToken, resolveAlert);
router.get("/devices",           verifyToken, getDevices);
router.get("/locations",         verifyToken, getLocations);
router.get("/analytics/summary",    verifyToken, getAnalyticsSummary); 
router.get("/sms-logs",             verifyToken, getSmsLogs);

module.exports = router;