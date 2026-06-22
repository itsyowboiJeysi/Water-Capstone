const express = require("express");
const router  = express.Router();
const { verifyToken, requireAdmin } = require("../middleware/authMiddleware");

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
  updateMe,
  getAllUsers,
  updateUserRoleStatus,
  deleteUser,
} = require("../controllers/authController");

router.post("/register", registerLimiter, speedLimiter, register);
router.post("/login",    loginLimiter, speedLimiter, login);
router.post("/forgot-password",    forgotPasswordLimiter, forgotPassword);      // ← new
router.get ("/validate-reset-token", validateResetToken);  // ← new
router.post("/reset-password",      resetPassword);       // ← new
router.post("/exchange-code", loginLimiter, speedLimiter, exchangeCode);
router.get ("/me",                    verifyToken, getMe);
router.put ("/me",                    verifyToken, updateMe);

router.get ("/users",                 verifyToken, requireAdmin, getAllUsers);
router.put ("/users/:id",             verifyToken, requireAdmin, updateUserRoleStatus);
router.delete("/users/:id",          verifyToken, requireAdmin, deleteUser);

module.exports = router;