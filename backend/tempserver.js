require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const mysql = require("mysql2");
const morgan = require("morgan");
const authRoutes = require("./routes/authRoutes");

const app = express();

// =============================
// MIDDLEWARE
// =============================

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.use("/api/auth", authRoutes);

// =============================
// DATABASE CONNECTION
// =============================

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database Connection Failed");
    console.error(err);
    return;
  }

  console.log("✅ MySQL Connected");

  connection.release();
});

// Make DB globally available
app.set("db", db);

// =============================
// HEALTH CHECK
// =============================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    project: "IoT Smart Water Monitoring System",
    version: "1.0.0",
    status: "Running"
  });
});

// =============================
// TEST DATABASE
// =============================

app.get("/api/test-db", (req, res) => {
  db.query("SELECT NOW() as server_time", (err, result) => {
    if (err) {
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }

    res.json({
      success: true,
      database_time: result[0].server_time
    });
  });
});

// =============================
// SENSOR DATA ENDPOINT
// ESP32 POSTS HERE
// =============================

app.post("/api/sensors", (req, res) => {
  const {
    device_id,
    ph_level,
    turbidity,
    tds,
    temperature,
    ammonia,
    flow_rate,
    water_consumed
  } = req.body;

  const query = `
    INSERT INTO sensor_readings
    (
      device_id,
      ph_level,
      turbidity,
      tds,
      temperature,
      ammonia,
      flow_rate,
      water_consumed
    )
    VALUES (?,?,?,?,?,?,?,?)
  `;

  db.query(
    query,
    [
      device_id,
      ph_level,
      turbidity,
      tds,
      temperature,
      ammonia,
      flow_rate,
      water_consumed
    ],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.status(201).json({
        success: true,
        message: "Sensor data saved",
        reading_id: result.insertId
      });
    }
  );
});

// =============================
// GET LATEST READING
// =============================

app.get("/api/sensors/latest/:deviceId", (req, res) => {
  const { deviceId } = req.params;

  const query = `
    SELECT *
    FROM sensor_readings
    WHERE device_id = ?
    ORDER BY recorded_at DESC
    LIMIT 1
  `;

  db.query(query, [deviceId], (err, result) => {
    if (err) {
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }

    if (result.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No readings found"
      });
    }

    res.json(result[0]);
  });
});

// =============================
// GET ALL ALERTS
// =============================

app.get("/api/alerts", (req, res) => {
  db.query(
    "SELECT * FROM alerts ORDER BY created_at DESC",
    (err, result) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json(result);
    }
  );
});

// =============================
// GET DEVICES
// =============================

app.get("/api/devices", (req, res) => {
  db.query(
    `
    SELECT
      d.*,
      l.building_name,
      l.area_name
    FROM devices d
    LEFT JOIN locations l
    ON d.location_id = l.location_id
    `,
    (err, result) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json(result);
    }
  );
});

// =============================
// 404 HANDLER
// =============================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint Not Found"
  });
});


// =============================
// middleware
// =============================
const protect = require("./middleware/authMiddleware");

app.get("/api/profile", protect, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

// =============================
// SERVER START
// =============================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`
=================================
🚀 SERVER RUNNING
PORT: ${PORT}
=================================
  `);
});