const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { initDB, pool } = require("../config/db");
const { exchangeCode } = require("../controllers/authController");
const crypto = require("crypto");

(async () => {
  try {
    console.log("1. Running initDB()...");
    await initDB();

    console.log("2. Checking if oauth_codes table exists...");
    const [tables] = await pool.query("SHOW TABLES LIKE 'oauth_codes'");
    if (tables.length === 0) {
      throw new Error("oauth_codes table was not created!");
    }
    console.log("-> oauth_codes table exists!");

    console.log("3. Simulating Google OAuth user creation / lookup...");
    const testGoogleId = "test_google_id_99999";
    const testEmail = "test_oauth_verification_user@gmail.com";
    const testName = "Google OAuth Test User";

    // Clean up previous test run if exists
    await pool.query("DELETE FROM users WHERE email = ? OR google_id = ?", [testEmail, testGoogleId]);

    const [userCount] = await pool.query("SELECT COUNT(*) AS total FROM users");
    const role   = (userCount[0].total === 0) ? "admin" : "gsu";
    const status = "active";

    const [result] = await pool.query(
      `INSERT INTO users (fullname, email, google_id, avatar, role, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [testName, testEmail, testGoogleId, null, role, status]
    );

    console.log(`-> Created test Google user with ID: ${result.insertId}, role: ${role}, status: ${status}`);

    console.log("4. Simulating one-time authorization code generation & DB insertion...");
    const code = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

    await pool.query(
      "INSERT INTO oauth_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
      [code, result.insertId, expiresAt]
    );

    console.log(`-> Code inserted: ${code.slice(0, 8)}...`);

    console.log("5. Simulating POST /exchange-code controller call...");
    const req = { body: { code } };
    let resData = null;
    let resStatus = 200;

    const res = {
      status: (code) => {
        resStatus = code;
        return res;
      },
      json: (data) => {
        resData = data;
        return res;
      }
    };

    await exchangeCode(req, res);

    console.log(`-> exchangeCode response status: ${resStatus}`);
    console.log("-> exchangeCode response data:", resData);

    if (resStatus === 200 && resData && resData.token && resData.user) {
      console.log("SUCCESS! Full Google OAuth flow simulation completed cleanly.");
    } else {
      throw new Error(`Exchange code failed with status ${resStatus}: ${JSON.stringify(resData)}`);
    }

    console.log("6. Cleaning up test data...");
    await pool.query("DELETE FROM users WHERE user_id = ?", [result.insertId]);
    console.log("-> Cleanup complete.");
    process.exit(0);

  } catch (err) {
    console.error("TEST FAILED:", err);
    process.exit(1);
  }
})();
