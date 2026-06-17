// config/passport.js — Google OAuth strategy for AquaMonitor
const passport      = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { pool } = require("../config/db");

passport.use(
  new GoogleStrategy(
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
              [googleId, avatar, user.id]
            );
            user.google_id = googleId;
            user.avatar    = avatar;
          }

          return done(null, user);
        }

        // ── New user — insert into DB ──────────────────────────────────────
        const [result] = await pool.query(
          `INSERT INTO users (fullname, email, google_id, avatar, role)
           VALUES (?, ?, ?, ?, 'user')`,
          [fullname, email, googleId, avatar]
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
  )
);

// Passport session serialization (needed even if we don't use sessions for JWT)
passport.serializeUser((user, done) => done(null, user.user_id));
passport.deserializeUser(async (id, done) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    done(null, rows[0] || null);
  } catch (err) {
    done(err, null);
  }
});

module.exports = passport;