const { pool } = require("c:\\Users\\JC\\OneDrive\\Desktop\\Water-Capstone\\backend\\config\\db.js");

(async () => {
  try {
    const [rows] = await pool.query("SELECT * FROM sensor_readings ORDER BY recorded_at DESC LIMIT 10");
    console.log("Sensor Readings Sample:");
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  }
})();
