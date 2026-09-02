// config/passport.js — Google OAuth strategy for AgosTech
const passport      = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { pool } = require("../config/db");

const googleStrategy = new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email    = profile.emails?.[0]?.value;
        const fullname = profile.displayName;
        const avatar   = profile.photos?.[0]?.value;

        if (!email) {
          return done(new Error("No email returned from Google."), null);
        }

        // ── Check if user already exists (by google_id or email) ──────────
        const [rows] = await pool.query(
          "SELECT * FROM users WHERE google_id = ? OR email = ?",
          [googleId, email]
        );

        if (rows.length > 0) {
          const user = rows[0];

          // If found by email but google_id not yet linked, link it now
          if (!user.google_id) {
            await pool.query(
              "UPDATE users SET google_id = ?, avatar = ? WHERE user_id = ?",
              [googleId, avatar, user.user_id]
            );
            user.google_id = googleId;
            user.avatar    = avatar;
          }

          return done(null, user);
        }

        // ── New user — insert into DB ──────────────────────────────────────
        const [userCount] = await pool.query("SELECT COUNT(*) AS total FROM users");
        const role   = (userCount[0].total === 0) ? "admin" : "gsu";
        const status = "active"; // Google authenticated users are auto-verified

        const [result] = await pool.query(
          `INSERT INTO users (fullname, email, google_id, avatar, role, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [fullname, email, googleId, avatar || null, role, status]
        );

        const [newUser] = await pool.query(
          "SELECT * FROM users WHERE user_id = ?",
          [result.insertId]
        );

        return done(null, newUser[0]);

      } catch (err) {
        return done(err, null);
      }
    }
  );

// Fix Node.js TLS Certificate inspection issues on local dev environments (Windows)
const https = require("https");
if (process.env.NODE_ENV !== "production") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  if (googleStrategy._oauth2) {
    const customAgent = new https.Agent({ rejectUnauthorized: false });
    if (typeof googleStrategy._oauth2.setAgent === "function") {
      googleStrategy._oauth2.setAgent(customAgent);
    }
    googleStrategy._oauth2._agent = customAgent;
  }
}

passport.use(googleStrategy);

// Passport session serialization (needed even if we don't use sessions for JWT)
passport.serializeUser((user, done) => done(null, user.user_id));
passport.deserializeUser(async (id, done) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [id]);
    done(null, rows[0] || null);
  } catch (err) {
    done(err, null);
  }
});

module.exports = passport;