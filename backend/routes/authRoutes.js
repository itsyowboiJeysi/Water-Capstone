const express = require("express");
const router  = express.Router();
const verifyToken  = require("../middleware/authMiddleware");
const {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  speedLimiter,
} = require("../middleware/rateLimiter");
const {
  register,
  login,
  forgotPassword,       // ← new
  validateResetToken,   // ← new
  resetPassword,        // ← new
  exchangeCode,
  getMe,

} = require("../controllers/authController");

router.post("/register", registerLimiter, speedLimiter, register);
router.post("/login",    loginLimiter, speedLimiter, login);
router.post("/forgot-password",    forgotPasswordLimiter, forgotPassword);      // ← new
router.get ("/validate-reset-token", validateResetToken);  // ← new
router.post("/reset-password",      resetPassword);       // ← new
router.post("/exchange-code", loginLimiter, speedLimiter, exchangeCode);
router.get ("/me",                    verifyToken, getMe);

module.exports = router;