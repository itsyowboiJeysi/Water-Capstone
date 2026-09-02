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

router.get("/google/callback", (req, res, next) => {
  passport.authenticate("google", { session: false }, async (err, user, info) => {
    if (err) {
      console.error("[Google OAuth Error Details]:", {
        message: err.message,
        statusCode: err.statusCode || err.oauthError?.statusCode,
        oauthError: err.oauthError ? {
          message: err.oauthError.message,
          statusCode: err.oauthError.statusCode,
          data: err.oauthError.data
        } : null,
        data: err.data
      });
      return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=google_failed`);
    }

    if (!user) {
      console.warn("[Google OAuth] Authentication failed, no user object returned. Info:", info);
      return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=google_failed`);
    }

    try {
      // Generate a one-time code — short-lived (2 minutes is plenty)
      const code      = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

      await pool.query(
        "INSERT INTO oauth_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
        [code, user.user_id, expiresAt]
      );

      // Only the code goes in the URL — NOT the JWT
      res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?code=${code}`);

    } catch (dbErr) {
      console.error("[OAuth] Callback DB error:", dbErr);
      res.redirect(`${process.env.FRONTEND_URL}/login.html?error=server_error`);
    }
  })(req, res, next);
});

module.exports = router;