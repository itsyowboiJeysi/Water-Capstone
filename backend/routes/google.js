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
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?code=${code}`);

    } catch (err) {
      console.error("[OAuth] Callback error:", err);
      res.redirect(`${process.env.FRONTEND_URL}/login.html?error=server_error`);
    }
  }
);

router.post("/exchange-code", async (req, res) => {
  const { code } = req.body;
  console.log("[OAuth] /exchange-code request received for code prefix:", code ? code.slice(0, 8) : "none");
  if (!code) {
    console.warn("[OAuth] Exchange failed: No code provided.");
    return res.status(400).json({ message: "Code is required." });
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM oauth_codes WHERE code = ?",
      [code]
    );
    console.log("[OAuth] Database lookup found codes count:", rows.length);
    if (rows.length === 0) {
      console.warn("[OAuth] Exchange failed: Code not found in database.");
      return res.status(401).json({ message: "Code is invalid." });
    }

    const record = rows[0];
    const expDate = new Date(record.expires_at);
    const nowDate = new Date();
    console.log("[OAuth] Expiration check: expires_at =", expDate.toISOString(), "now =", nowDate.toISOString());
    if (expDate < nowDate) {
      console.warn("[OAuth] Exchange failed: Code has expired.");
      await pool.query("DELETE FROM oauth_codes WHERE code = ?", [code]);
      return res.status(401).json({ message: "Code has expired." });
    }

    const { user_id } = record;
    console.log("[OAuth] Exchange code valid for user_id:", user_id);

    // Delete used code immediately
    await pool.query("DELETE FROM oauth_codes WHERE code = ?", [code]);

    // Fetch user
    const [users] = await pool.query("SELECT * FROM users WHERE user_id = ?", [user_id]);
    console.log("[OAuth] User query returned rows count:", users.length);
    if (users.length === 0) {
      console.warn("[OAuth] Exchange failed: Associated user not found in DB.");
      return res.status(404).json({ message: "User not found." });
    }

    const user = users[0];
    const token = jwt.sign(
      { id: user.user_id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "aquamonitor_secret",
      { expiresIn: "7d" }
    );
    console.log("[OAuth] JWT generated successfully for user:", user.email);

    res.json({
      token,
      user: {
        id:       user.user_id,
        fullname: user.fullname,
        email:    user.email,
        role:     user.role,
        avatar:   user.avatar,
      }
    });
  } catch (err) {
    console.error("[OAuth] exchange-code exception:", err);
    res.status(500).json({ message: "Server error." });
  }
});
module.exports = router;