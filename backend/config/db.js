// db.js — MySQL connection pool for AquaMonitor
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
      id           INT          NOT NULL AUTO_INCREMENT,
      fullname     VARCHAR(150) NOT NULL,
      email        VARCHAR(255) NOT NULL UNIQUE,
      phone_number VARCHAR(20)  DEFAULT NULL,
      password     VARCHAR(255) DEFAULT NULL,
      role         VARCHAR(50)  NOT NULL DEFAULT 'user',
      google_id    VARCHAR(255) DEFAULT NULL,
      avatar       VARCHAR(500) DEFAULT NULL,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  await pool.query(createUsersTable);

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
    console.warn("[AquaMonitor] Could not alter system_settings table schema:", err);
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

  try {
    await pool.query("ALTER TABLE user_settings MODIFY COLUMN setting_value LONGTEXT NOT NULL");
  } catch (err) {
    console.warn("[AquaMonitor] Could not alter user_settings table schema:", err);
  }

  // Seed default settings individually if they are missing
  const defaults = [
    ["sms_alerts", "1"],
    ["critical_alerts_only", "0"],
    ["device_offline_alerts", "1"],
    ["daily_summary_report", "1"],
    ["auto_refresh_dashboard", "1"],
    ["data_logging", "1"],
    ["maintenance_mode", "0"],
    ["google_oauth_login", "1"]
  ];
  for (const [key, val] of defaults) {
    const [existing] = await pool.query("SELECT setting_key FROM system_settings WHERE setting_key = ?", [key]);
    if (existing.length === 0) {
      await pool.query("INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)", [key, val]);
      console.log(`[AquaMonitor] Seeded missing default setting: ${key} = ${val}`);
    }
  }

  console.log("[AquaMonitor] Database & users, audit_logs & settings tables ready.");
}

module.exports = { pool, initDB };