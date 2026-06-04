// routes/google.js — Google OAuth routes for AquaMonitor
const express  = require("express");
const passport = require("../config/passport");
const jwt      = require("jsonwebtoken");

const router = express.Router();

// ── Step 1: Redirect user to Google consent screen ───────────────────────────
// Triggered by your frontend: window.location.href = 'http://localhost:5000/api/auth/google'
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// ── Step 2: Google redirects back here after consent ─────────────────────────
// Must match exactly what's in Google Cloud Console + your .env GOOGLE_CALLBACK_URL
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: `${process.env.FRONTEND_URL}/login.html?error=google_failed`, session: false }),
  (req, res) => {
    const user = req.user;

    // Sign a JWT just like the normal login flow
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "aquamonitor_secret",
      { expiresIn: "7d" }
    );

    const safeUser = {
      id:       user.id,
      fullname: user.fullname,
      email:    user.email,
      role:     user.role,
      avatar:   user.avatar || null,
    };

    // ── Redirect to frontend with token in URL hash ───────────────────────
    // Your frontend JS reads it from the URL and saves to storage
    const params = new URLSearchParams({
      token,
      user: JSON.stringify(safeUser),
    });

    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?${params.toString()}`);
  }
);

module.exports = router;