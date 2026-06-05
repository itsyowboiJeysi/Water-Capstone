// authController.js — AquaMonitor Auth
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const { pool } = require("../config/db");
const { sendPasswordResetEmail } = require("../services/mailer");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { fullname, email, phone_number, password, role }
// ─────────────────────────────────────────────────────────────────────────────
async function register(req, res) {
  const { fullname, email, phone_number, password, role } = req.body || {};

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!fullname || !email || !password || !role) {
    return res.status(400).json({ message: "All required fields must be filled." });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return res.status(400).json({ message: "Please enter a valid email address." });
  }

  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }

  const validRoles = ["admin", "gsu", "hsu"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ message: "Invalid role. Must be admin, gsu, or hsu." });
  }

  if (phone_number && !/^(09|\+639)\d{9}$/.test(phone_number)) {
    return res.status(400).json({ message: "Enter a valid PH number (e.g. 09XXXXXXXXX)." });
  }

  try {
    // ── Check duplicate email ──────────────────────────────────────────────
    const [existing] = await pool.query(
      "SELECT user_id FROM users WHERE email = ?", [email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: "This email already exists. Please use a different one." });
    }

    // ── Hash password & insert ─────────────────────────────────────────────
    const hashedPassword = await bcrypt.hash(password, 12);

    await pool.query(
      `INSERT INTO users (fullname, email, phone_number, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
      [fullname, email, phone_number || null, hashedPassword, role]
    );

    return res.status(201).json({ message: "Account created successfully!" });

  } catch (err) {
    console.error("[AquaMonitor] Register error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// Returns: { token, user: { user_id, fullname, email, role } }
// ─────────────────────────────────────────────────────────────────────────────
async function login(req, res) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  try {
    // ── Look up user ───────────────────────────────────────────────────────
    const [rows] = await pool.query(
      `SELECT user_id, fullname, email, phone_number, password_hash, role
       FROM users WHERE email = ?`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password. Please try again." });
    }

    const user = rows[0];

    // ── Compare password ───────────────────────────────────────────────────
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password. Please try again." });
    }

    // ── Sign JWT ───────────────────────────────────────────────────────────
    const token = jwt.sign(
      { id: user.user_id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "aquamonitor_secret",
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      token,
      user: {
        id:           user.user_id,
        fullname:     user.fullname,
        email:        user.email,
        phone_number: user.phone_number,
        role:         user.role,
      }
    });

  } catch (err) {
    console.error("[AquaMonitor] Login error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password  { email }
// ─────────────────────────────────────────────────────────────────────────────
async function forgotPassword(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required." });

  try {
    const [rows] = await pool.query(
      "SELECT user_id FROM users WHERE email = ?", [email]
    );

    // Always respond OK — never confirm if email exists (security)
    if (rows.length === 0) return res.json({ message: "If that email exists, a reset link has been sent." });

    const token  = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE email = ?",
      [token, expiry, email]
    );

    const resetLink = `${process.env.FRONTEND_RESET_URL}#token=${token}`;
   
    await sendPasswordResetEmail(email, resetLink);

    res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    console.error("forgotPassword error:", err);
    res.status(500).json({ message: "Server error. Please try again." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/validate-reset-token?token=xxx
// ─────────────────────────────────────────────────────────────────────────────
async function validateResetToken(req, res) {
  const { token } = req.query;
  if (!token) return res.status(400).json({ message: "Token is required." });

  try {
    const [rows] = await pool.query(
      "SELECT user_id FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()",
      [token]
    );
    if (rows.length === 0) return res.status(400).json({ message: "Token is invalid or expired." });
    res.json({ valid: true });
  } catch (err) {
    console.error("validateResetToken error:", err);
    res.status(500).json({ message: "Server error." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password  { token, newPassword }
// ─────────────────────────────────────────────────────────────────────────────
async function resetPassword(req, res) {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ message: "Token and new password are required." });

  try {
    const [rows] = await pool.query(
      "SELECT user_id FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()",
      [token]
    );
    if (rows.length === 0) return res.status(400).json({ message: "Token is invalid or expired." });

    const hashed = await bcrypt.hash(newPassword, 12);

    await pool.query(
      `UPDATE users
       SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL
       WHERE user_id = ?`,
      [hashed, rows[0].user_id]
    );

    res.json({ message: "Password updated successfully." });
  } catch (err) {
    console.error("resetPassword error:", err);
    res.status(500).json({ message: "Server error. Please try again." });
  }
}

async function exchangeCode(req, res) {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: "Code is required." });

  try {
    const [rows] = await pool.query(
      "SELECT * FROM oauth_codes WHERE code = ? AND expires_at > NOW()",
      [code]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired code." });
    }

    const { user_id } = rows[0];

    await pool.query("DELETE FROM oauth_codes WHERE code = ?", [code]);

    const [users] = await pool.query(
      "SELECT user_id, fullname, email, role, avatar FROM users WHERE user_id = ?",  // ← user_id not id
      [user_id]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const user  = users[0];
    const token = jwt.sign(
      { id: user.user_id, email: user.email, role: user.role },  // ← user.user_id
      process.env.JWT_SECRET || "aquamonitor_secret",
      { expiresIn: "7d" }
    );

    res.json({ 
      token, 
      user: {
        id:       user.user_id,   // ← user.user_id
        fullname: user.fullname,
        email:    user.email,
        role:     user.role,
        avatar:   user.avatar || null,
      }
    });

  } catch (err) {
    console.error("[AquaMonitor] exchangeCode error:", err);
    res.status(500).json({ message: "Server error." });
  }
}

module.exports = { register, login, forgotPassword, validateResetToken, resetPassword, exchangeCode };

