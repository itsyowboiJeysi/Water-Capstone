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

  console.log("[AquaMonitor] Database & users & audit_logs tables ready.");
}

module.exports = { pool, initDB };