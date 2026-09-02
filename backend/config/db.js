// db.js — MySQL connection pool for AgosTech
const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || "localhost",
  user:               process.env.DB_USER     || "root",
  password:           process.env.DB_PASSWORD || "",
  database:           process.env.DB_NAME     || "smart_water_monitoring",
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

// Creates the users table if it doesn't already exist
async function initDB() {
  const createDB = `
    CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || "smart_water_monitoring"}\`;
  `;

  // Temporary connection without specifying DB to create it if needed
  const tempPool = mysql.createPool({
    host:     process.env.DB_HOST     || "localhost",
    user:     process.env.DB_USER     || "root",
    password: process.env.DB_PASSWORD || "",
  });

  await tempPool.query(createDB);
  await tempPool.end();

  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      user_id      INT          NOT NULL AUTO_INCREMENT,
      fullname     VARCHAR(150) NOT NULL,
      email        VARCHAR(255) NOT NULL UNIQUE,
      phone_number VARCHAR(20)  DEFAULT NULL,
      password_hash VARCHAR(255) DEFAULT NULL,
      role         VARCHAR(50)  NOT NULL DEFAULT 'gsu',
      status       VARCHAR(20)  NOT NULL DEFAULT 'pending',
      google_id    VARCHAR(255) DEFAULT NULL,
      avatar       VARCHAR(500) DEFAULT NULL,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  await pool.query(createUsersTable);

  try {
    await pool.query("ALTER TABLE users MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'");
  } catch (err) {
    console.warn("[AgosTech] Could not modify status column:", err);
  }

  const createOAuthCodesTable = `
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code       VARCHAR(255) NOT NULL,
      user_id    INT          NOT NULL,
      expires_at DATETIME     NOT NULL,
      created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (code),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createOAuthCodesTable);

  const createAuditLogsTable = `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INT          NOT NULL AUTO_INCREMENT,
      user_id     INT          NULL,
      username    VARCHAR(150) NOT NULL,
      role        VARCHAR(50)  NOT NULL,
      action      VARCHAR(100) NOT NULL,
      details     TEXT         NULL,
      ip_address  VARCHAR(45)  NULL,
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createAuditLogsTable);

  const createSmsLogsTable = `
    CREATE TABLE IF NOT EXISTS sms_logs (
      id          INT          NOT NULL AUTO_INCREMENT,
      device_id   VARCHAR(50)  NULL,
      alert_id    INT          NULL,
      recipient   VARCHAR(50)  NOT NULL,
      message     TEXT         NOT NULL,
      provider    VARCHAR(50)  DEFAULT 'Semaphore',
      status      VARCHAR(20)  NOT NULL DEFAULT 'sent',
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createSmsLogsTable);

  const createSettingsTable = `
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key   VARCHAR(100) NOT NULL,
      setting_value LONGTEXT NOT NULL,
      PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createSettingsTable);
  
  // Safe alteration for existing schemas
  try {
    await pool.query("ALTER TABLE system_settings MODIFY COLUMN setting_value LONGTEXT NOT NULL");
  } catch (err) {
    console.warn("[AgosTech] Could not alter system_settings table schema:", err);
  }

  const createUserSettingsTable = `
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id       INT          NOT NULL,
      setting_key   VARCHAR(100) NOT NULL,
      setting_value LONGTEXT NOT NULL,
      PRIMARY KEY (user_id, setting_key),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createUserSettingsTable);

  const createThresholdSettingsTable = `
    CREATE TABLE IF NOT EXISTS threshold_settings (
      id             INT          NOT NULL AUTO_INCREMENT,
      parameter_name VARCHAR(50)  NOT NULL UNIQUE,
      min_value      DECIMAL(10,2) NOT NULL,
      max_value      DECIMAL(10,2) NOT NULL,
      unit           VARCHAR(20)  NOT NULL,
      description    VARCHAR(255) NULL,
      created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createThresholdSettingsTable);

  try {
    await pool.query("ALTER TABLE threshold_settings ADD COLUMN unit VARCHAR(20) NULL DEFAULT ''");
  } catch (err) {
    // Column unit already exists
  }

  try {
    await pool.query("ALTER TABLE user_settings MODIFY COLUMN setting_value LONGTEXT NOT NULL");
  } catch (err) {
    console.warn("[AgosTech] Could not alter user_settings table schema:", err);
  }

  // Seed default thresholds if missing
  const defaultThresholds = [
    ["ph", 6.50, 8.50, "pH", "Acidity / Alkalinity (PNSDW 2017)"],
    ["tds", 0.00, 500.00, "ppm", "Total Dissolved Solids (PNSDW 2017)"],
    ["temperature", 0.00, 35.00, "°C", "Water Thermal Level (PNSDW 2017)"],
    ["turbidity", 0.00, 5.00, "NTU", "Water Clarity / Cloudiness (PNSDW 2017)"],
    ["ammonia", 0.00, 0.50, "mg/L", "NH3 Concentration (PNSDW 2017)"],
    ["flow_rate", 0.00, 100.00, "L/min", "Water Volume Flow Rate"]
  ];
  for (const [param, minV, maxV, unit, desc] of defaultThresholds) {
    const [existing] = await pool.query("SELECT parameter_name FROM threshold_settings WHERE parameter_name = ?", [param]);
    if (existing.length === 0) {
      await pool.query(
        "INSERT INTO threshold_settings (parameter_name, min_value, max_value, unit, description) VALUES (?, ?, ?, ?, ?)",
        [param, minV, maxV, unit, desc]
      );
    }
  }

  // Seed default settings individually if they are missing
  const defaults = [
    ["sms_alerts", "1"],
    ["critical_alerts_only", "0"],
    ["device_offline_alerts", "1"],
    ["offline_threshold_minutes", "30"],
    ["daily_summary_report", "1"],
    ["auto_refresh_dashboard", "1"],
    ["data_logging", "1"],
    ["maintenance_mode", "0"],
    ["google_oauth_login", "1"],
    ["esp_telemetry_interval_sec", "5"]
  ];
  for (const [key, val] of defaults) {
    const [existing] = await pool.query("SELECT setting_key FROM system_settings WHERE setting_key = ?", [key]);
    if (existing.length === 0) {
      await pool.query("INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)", [key, val]);
      console.log(`[AgosTech] Seeded missing default setting: ${key} = ${val}`);
    }
  }

  console.log("[AgosTech] Database & users, audit_logs & settings tables ready.");
}

module.exports = { pool, initDB };