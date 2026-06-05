const express = require("express");
const router  = express.Router();
const {
  register,
  login,
  forgotPassword,       // ← new
  validateResetToken,   // ← new
  resetPassword,        // ← new
} = require("../controllers/authController");

router.post("/register", register);
router.post("/login",    login);
router.post("/forgot-password",    forgotPassword);      // ← new
router.get ("/validate-reset-token", validateResetToken);  // ← new
router.post("/reset-password",      resetPassword);       // ← new

module.exports = router;