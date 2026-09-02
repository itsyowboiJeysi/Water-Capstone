// routes/deviceRoutes.js — AgosTech Devices
const express = require("express");
const router  = express.Router();

const {
  getDevices,
  createDevice,
  updateDevice,
  updateDeviceStatus,
  deleteDevice,
} = require("../controllers/deviceController");

router.get("/",              getDevices);
router.post("/",              createDevice);
router.put("/:id",            updateDevice);
router.patch("/:id/status",   updateDeviceStatus);
router.delete("/:id",         deleteDevice);

module.exports = router;