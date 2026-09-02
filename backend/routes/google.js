// routes/google.js — Native Google OAuth 2.0 Implementation from Scratch for AgosTech
const express     = require("express");
const https       = require("https");
const querystring = require("querystring");
const jwt         = require("jsonwebtoken");
const { pool }    = require("../config/db");

const router = express.Router();

// Helper: Perform standard HTTPS requests with custom body & header support
function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ statusCode: res.statusCode, data: parsed, raw: body });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: body, raw: body });
        }
      });
    });

    req.on("error", (err) => {
      // If local dev environment encounters CA verification error due to antivirus/proxy
      if (err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || err.code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
        console.warn("[AgosTech OAuth] Retrying HTTPS request with insecure TLS agent fallback for local dev proxy...");
        const agent = new https.Agent({ rejectUnauthorized: false });
        const fallbackOptions = { ...options, agent };
        const fallbackReq = https.request(fallbackOptions, (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              resolve({ statusCode: res.statusCode, data: parsed, raw: body });
            } catch (e) {
              resolve({ statusCode: res.statusCode, data: body, raw: body });
            }
          });
        });
        fallbackReq.on("error", (fallbackErr) => reject(fallbackErr));
        if (postData) fallbackReq.write(postData);
        fallbackReq.end();
        return;
      }
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// ── Step 1: Initiate Google OAuth Authorization ──────────────────────────────
router.get("/google", async (req, res) => {
  try {
    // Check if Google OAuth login is enabled in system settings
    const [[setting]] = await pool.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'google_oauth_login'"
    );
    if (setting && setting.setting_value === "0") {
      const frontendUrl = process.env.FRONTEND_URL || "http://127.0.0.1:5500/frontend";
      return res.redirect(`${frontendUrl}/login.html?error=google_disabled`);
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || "http://localhost:5000/api/auth/google/callback";

    if (!clientId) {
      console.error("[AgosTech Google OAuth] Missing GOOGLE_CLIENT_ID in environment.");
      const frontendUrl = process.env.FRONTEND_URL || "http://127.0.0.1:5500/frontend";
      return res.redirect(`${frontendUrl}/login.html?error=google_failed`);
    }

    const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + querystring.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      access_type: "offline",
      prompt: "select_account"
    });

    res.redirect(authUrl);
  } catch (err) {
    console.error("[AgosTech Google OAuth] Initiation error:", err.message);
    const frontendUrl = process.env.FRONTEND_URL || "http://127.0.0.1:5500/frontend";
    res.redirect(`${frontendUrl}/login.html?error=google_failed`);
  }
});

// ── Step 2: Google OAuth Callback Handler ─────────────────────────────────────
router.get("/google/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://127.0.0.1:5500/frontend";
  const code = req.query.code;
  const oauthError = req.query.error;

  if (oauthError || !code) {
    console.error("[AgosTech Google OAuth] Callback error or missing code:", oauthError || "No code provided");
    return res.redirect(`${frontendUrl}/login.html?error=google_failed`);
  }

  try {
    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_CALLBACK_URL || "http://localhost:5000/api/auth/google/callback";

    // 1. Exchange authorization code for tokens
    const tokenPostData = querystring.stringify({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    });

    const tokenResponse = await httpsRequest({
      hostname: "oauth2.googleapis.com",
      port: 443,
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(tokenPostData)
      }
    }, tokenPostData);

    if (tokenResponse.statusCode !== 200 || !tokenResponse.data.access_token) {
      console.error("[AgosTech Google OAuth] Token exchange failed:", tokenResponse.data);
      return res.redirect(`${frontendUrl}/login.html?error=google_failed`);
    }

    const accessToken = tokenResponse.data.access_token;

    // 2. Fetch user profile from Google's UserInfo API
    const userinfoResponse = await httpsRequest({
      hostname: "www.googleapis.com",
      port: 443,
      path: "/oauth2/v3/userinfo",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });

    if (userinfoResponse.statusCode !== 200 || !userinfoResponse.data.email) {
      console.error("[AgosTech Google OAuth] UserInfo fetch failed:", userinfoResponse.data);
      return res.redirect(`${frontendUrl}/login.html?error=google_failed`);
    }

    const profile = userinfoResponse.data;
    const googleId = profile.sub;
    const email    = profile.email;
    const fullname = profile.name || profile.given_name || email.split("@")[0];
    const avatar   = profile.picture || null;

    // 3. Database operations — find or create user in MySQL
    let user;
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE google_id = ? OR email = ?",
      [googleId, email]
    );

    if (rows.length > 0) {
      user = rows[0];
      // If found by email but google_id not linked, link it now
      if (!user.google_id) {
        await pool.query(
          "UPDATE users SET google_id = ?, avatar = ? WHERE user_id = ?",
          [googleId, avatar, user.user_id]
        );
        user.google_id = googleId;
        user.avatar    = avatar;
      }
    } else {
      // Register new user with default 'user' role
      const [insertResult] = await pool.query(
        `INSERT INTO users (fullname, email, google_id, avatar, role)
         VALUES (?, ?, ?, ?, 'user')`,
        [fullname, email, googleId, avatar]
      );
      const [newUserRows] = await pool.query(
        "SELECT * FROM users WHERE user_id = ?",
        [insertResult.insertId]
      );
      user = newUserRows[0];
    }

    // 4. Generate AgosTech JWT session token
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

    console.log(`[AgosTech Google OAuth] Successfully authenticated user: ${user.email} (ID: ${user.user_id})`);
    res.redirect(`${frontendUrl}/dashboard.html?${params.toString()}`);

  } catch (err) {
    console.error("[AgosTech Google OAuth] Fatal callback error:", err);
    res.redirect(`${frontendUrl}/login.html?error=google_failed`);
  }
});

module.exports = router;