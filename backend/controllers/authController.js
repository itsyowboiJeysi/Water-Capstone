// authController.js — AquaMonitor Auth
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { pool } = require("../config/db");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { fullname, email, phone_number, password, role }
// ─────────────────────────────────────────────────────────────────────────────
exports.register = async (req, res) => {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// Returns: { token, user: { user_id, fullname, email, role } }
// ─────────────────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
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
};