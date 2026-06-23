const { pool } = require("../config/db");

async function check() {
  try {
    const [rows] = await pool.query("SELECT * FROM system_settings");
    console.log("Current System Settings in Database:");
    console.log(rows);
    process.exit(0);
  } catch (err) {
    console.error("Error querying settings:", err);
    process.exit(1);
  }
}

check();
