const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");

// General API limiter — applies to all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});

// Strict limiter for login — prevents brute-force/credential stuffing
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
  skipSuccessfulRequests: true, // only count failed attempts
});

// Registration limiter — prevents mass account creation
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many accounts created from this IP. Try again later." },
});

// Forgot-password limiter — prevents email-bombing
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many reset requests. Please try again in an hour." },
});

// Sensor ingestion limiter — protects ESP32 endpoint from flooding
const sensorLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // adjust to your sensor's reporting interval
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many sensor submissions. Slowing down." },
});

// Optional: gradual slowdown before hard block (good for /api/auth/*)
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 3,
  delayMs: (hits) => hits * 500, // each extra request adds 500ms delay
});

module.exports = {
  generalLimiter,
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  sensorLimiter,
  speedLimiter,
};