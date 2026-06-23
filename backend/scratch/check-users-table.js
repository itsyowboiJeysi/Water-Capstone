const { pool } = require("../config/db");

async function check() {
  try {
    const [rows] = await pool.query("DESCRIBE users");
    console.log("Users table structure:");
    console.log(rows);
    process.exit(0);
  } catch (err) {
    console.error("Error describing users table:", err);
    process.exit(1);
  }
}

check();
