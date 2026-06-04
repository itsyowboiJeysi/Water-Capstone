
const express  = require("express");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { pool } = require("../db");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { fullname, email, phone_number, password, role }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  const { fullname, email, phone_number, password, role } = req.body;

  // ── Server-side validation ─────────────────────────────────────────────────
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

  if (phone_number && !/^(09|\+639)\d{9}$/.test(phone_number)) {
    return res.status(400).json({ message: "Enter a valid PH number (e.g. 09XXXXXXXXX)." });
  }

  try {
    // ── Check if email already exists ──────────────────────────────────────
    const [existing] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({ message: "This email already exists. Please use a different one." });
    }

    // ── Hash password ──────────────────────────────────────────────────────
    const hashedPassword = await bcrypt.hash(password, 12);

    // ── Insert user ────────────────────────────────────────────────────────
    await pool.query(
      `INSERT INTO users (fullname, email, phone_number, password, role)
       VALUES (?, ?, ?, ?, ?)`,
      [fullname, email, phone_number || null, hashedPassword, role]
    );

    return res.status(201).json({ message: "Account created successfully!" });

  } catch (err) {
    console.error("[AquaMonitor] Register error:", err);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// Returns: { token, user: { id, fullname, email, role } }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  // ── Server-side validation ─────────────────────────────────────────────────
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  try {
    // ── Look up user ───────────────────────────────────────────────────────
    const [rows] = await pool.query(
      "SELECT id, fullname, email, phone_number, password, role FROM users WHERE email = ?",
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password. Please try again." });
    }

    const user = rows[0];

    // ── Compare passwords ──────────────────────────────────────────────────
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password. Please try again." });
    }

    // ── Sign JWT ───────────────────────────────────────────────────────────
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "aquamonitor_secret",
      { expiresIn: "7d" }
    );

    // ── Return token + safe user object (no password) ──────────────────────
    return res.status(200).json({
      token,
      user: {
        id:           user.id,
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
});

module.exports = router;