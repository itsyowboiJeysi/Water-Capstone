// routes/google.js — Google OAuth routes for AgosTech
const express  = require("express");
const passport = require("../config/passport");
const jwt      = require("jsonwebtoken");

const router = express.Router();

// ── Step 1: Redirect user to Google consent screen ───────────────────────────
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// ── Step 2: Google redirects back here after consent ─────────────────────────
router.get("/google/callback", (req, res, next) => {
  passport.authenticate("google", { session: false }, (err, user, info) => {
    if (err) {
      console.error("[AgosTech] Google OAuth authentication error encountered:");
      console.error("  - Error message:", err.message);
      console.error("  - Error code:", err.code);
      console.error("  - Error name:", err.name);
      if (err.oauthError) {
        console.error("  - oauthError.statusCode:", err.oauthError.statusCode);
        console.error("  - oauthError.data:", err.oauthError.data);
        console.error("  - oauthError.code:", err.oauthError.code);
        console.error("  - oauthError Object:", err.oauthError);
      } else {
        console.error("  - Full Error Stack:", err);
      }
      return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=google_failed`);
    }
    if (!user) {
      console.error("[AgosTech] Google OAuth: no user returned.", info);
      return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=google_failed`);
    }

    // Sign a JWT just like the normal login flow
    const token = jwt.sign(
      { id: user.user_id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "agostech_secret",
      { expiresIn: "7d" }
    );

    const safeUser = {
      id:       user.user_id,
      fullname: user.fullname,
      email:    user.email,
      role:     user.role,
      avatar:   user.avatar || null,
    };

    const params = new URLSearchParams({
      token,
      user: JSON.stringify(safeUser),
    });

    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?${params.toString()}`);
  })(req, res, next);
});

module.exports = router;