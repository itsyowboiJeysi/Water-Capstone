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
      console.error("[AquaMonitor] OAuth callback error:", err);
      res.redirect(`${process.env.FRONTEND_URL}/login.html?error=server_error`);
    }
  }
);

router.post("/exchange-code", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: "Code is required." });

  try {
    const [rows] = await pool.query(
      "SELECT * FROM oauth_codes WHERE code = ? AND expires_at > NOW()",
      [code]
    );
    if (rows.length === 0) return res.status(401).json({ message: "Code is invalid or expired." });

    const { user_id } = rows[0];

    // Delete used code immediately
    await pool.query("DELETE FROM oauth_codes WHERE code = ?", [code]);

    // Fetch user
    const [users] = await pool.query("SELECT * FROM users WHERE user_id = ?", [user_id]);
    if (users.length === 0) return res.status(404).json({ message: "User not found." });

    const user = users[0];
    const token = jwt.sign(
      { id: user.user_id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "aquamonitor_secret",
      { expiresIn: "7d" }
    );

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
    console.error("[OAuth] exchange-code error:", err);
    res.status(500).json({ message: "Server error." });
  }
});
module.exports = router;