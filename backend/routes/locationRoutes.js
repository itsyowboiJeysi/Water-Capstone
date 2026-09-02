// routes/locationRoutes.js — AgosTech Locations
const express = require("express");
const router  = express.Router();

const {
  getLocations,
  createLocation,
  updateLocation,
  deleteLocation,
} = require("../controllers/locationController");

// If you have auth middleware, uncomment and point to the right files:
// const { verifyToken }  = require("../middleware/authMiddleware");
// const { requireAdmin } = require("../middleware/roleMiddleware");

router.get("/",    /* verifyToken, */                  getLocations);
router.post("/",   /* verifyToken, requireAdmin, */    createLocation);
router.put("/:id", /* verifyToken, requireAdmin, */    updateLocation);
router.delete("/:id", /* verifyToken, requireAdmin, */ deleteLocation);

module.exports = router;