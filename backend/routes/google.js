const express  = require("express");
const passport = require("../config/passport");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const { pool } = require("../config/db");

const router = express.Router();

router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: `${process.env.FRONTEND_URL}/login.html?error=google_failed`,
    session: false
  }),
  async (req, res) => {
    try {
      const user = req.user;

      // Generate a one-time code — short-lived (2 minutes is plenty)
      const code      = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

      await pool.query(
        "INSERT INTO oauth_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
        [code, user.user_id, expiresAt]
      );

      // Only the code goes in the URL — NOT the JWT
    res.redirect(`${process.env.FRONTEND_URL}/frontend/dashboard.html?code=${code}`);

    } catch (err) {
      console.error("[AquaMonitor] OAuth callback error:", err);
      res.redirect(`${process.env.FRONTEND_URL}/login.html?error=server_error`);
    }
  }
);

module.exports = router;