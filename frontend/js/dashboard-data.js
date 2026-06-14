// dashboard-data.js — AquaSense live data binder
// Matches real schema: smart_water_monitoring.sql
// sensor_readings has NO water_status column — status is computed from threshold_settings
// alerts uses: level, status ('unresolved'/'resolved'), parameter, message
// devices: device_id is VARCHAR (e.g. 'ESP-001'), no installed_date, no esp32_uid
// locations: only use location_id 1–5 (delete dupes > 5 with cleanup query below)

const API_BASE = "http://localhost:5000";

// ── Auth headers ─────────────────────────────────────────────────────────────
function authHeaders() {
  const token = localStorage.getItem("token") || sessionStorage.getItem("token");
  return { "Authorization": `Bearer ${token}` };
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) {
    logout();
    return null;
  }
  if (!res.ok) throw new Error(`Request failed: ${path} (${res.status})`);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmt(val, decimals = 1) {
  if (val === null || val === undefined) return "—";
  return Number(val).toFixed(decimals);
}

function emptyRow(colspan, msg) {
  return `<tr><td colspan="${colspan}" style="text-align:center;color:var(--text-light);padding:28px;font-size:13px;">${msg}</td></tr>`;
}

function emptyPanel(msg) {
  return `<div style="text-align:center;color:var(--text-light);padding:32px 20px;font-size:13px;">${msg}</div>`;
}

// ── Threshold map (populated from /api/dashboard/summary) ────────────────────
let thresholdMap = {};

function buildThresholdMap(thresholds) {
  thresholdMap = {};
  (thresholds || []).forEach(t => {
    thresholdMap[t.parameter_name] = {
      min: Number(t.min_value),
      max: Number(t.max_value),
    };
  });
}

// Returns 'safe' | 'warn' | 'danger'
function paramStatus(paramName, value) {
  const t = thresholdMap[paramName];
  if (!t || value === null || value === undefined) return "safe";
  const v = Number(value);
  if (v < t.min || v > t.max) return "danger";
  // warn if within 10% of max
  const range = t.max - t.min;
  if (range > 0 && v > t.max - range * 0.10) return "warn";
  return "safe";
}

function paramPercent(paramName, value) {
  const t = thresholdMap[paramName];
  if (!t || value === null || value === undefined) return 0;
  const range = t.max - t.min;
  if (range <= 0) return 0;
  const pct = ((Number(value) - t.min) / range) * 100;
  return Math.max(0, Math.min(100, pct));
}

function rangeLabel(paramName) {
  const t = thresholdMap[paramName];
  return t ? `${t.min} – ${t.max}` : "—";
}

// Compute overall status for a reading row (worst of all params)
function overallStatus(r) {
  const checks = [
    paramStatus("ph",          r.ph_level),
    paramStatus("turbidity",   r.turbidity),
    paramStatus("tds",         r.tds),
    paramStatus("temperature", r.temperature),
    paramStatus("ammonia",     r.ammonia),
    paramStatus("flow_rate",   r.flow_rate),
  ];
  if (checks.includes("danger")) return "danger";
  if (checks.includes("warn"))   return "warn";
  return "safe";
}

function statusLabel(s) {
  if (s === "danger") return "Danger";
  if (s === "warn")   return "Warning";
  return "Safe";
}

// Map alerts.level → CSS class (schema uses 'critical'|'high'|'medium'|'low')
function alertClass(level) {
  if (level === "critical") return "critical";
  if (level === "high")     return "high";
  if (level === "medium")   return "medium";
  return "low";
}

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadDashboard() {
  try {
    const summary = await apiGet("/api/dashboard/summary");
    if (!summary) return;

    buildThresholdMap(summary.thresholds);
    renderDashboardStats(summary);
    renderLiveParams(summary.latestReading, "dashboard-params");
  } catch (err) {
    console.error("[AquaSense] loadDashboard error:", err);
  }

  await loadRecentReadingsTable();
  await loadAlerts("unresolved", "dashboard-alerts", true);
  await loadBuildingsPreview();
}

// ── Dashboard stat cards (top row) ──────────────────────────────────────────
function renderDashboardStats(summary) {
  const grid = document.getElementById("dashboard-stats");
  if (!grid) return;

  const r = summary.latestReading;
  const d = summary.devices || {};

  if (!r) {
    grid.innerHTML = `<div class="stat-card navy" style="grid-column:1/-1;"><div class="stat-label" style="text-align:center;padding:20px;">No sensor data yet. Waiting for ESP32 devices to report.</div></div>`;
    return;
  }

  const phS   = paramStatus("ph",          r.ph_level);
  const turbS = paramStatus("turbidity",   r.turbidity);
  const tdsS  = paramStatus("tds",         r.tds);

  grid.innerHTML = `
    <div class="stat-card ${phS}">
      <div class="stat-header">
        <div class="stat-icon-wrap ${phS}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 C12 2 4 9 4 14 A8 8 0 0 0 20 14 C20 9 12 2 12 2 Z"/></svg></div>
        <span class="stat-badge ${phS}">${statusLabel(phS)}</span>
      </div>
      <div class="stat-value">${fmt(r.ph_level)}<span class="stat-unit">pH</span></div>
      <div class="stat-label">pH Level</div>
      <div class="stat-sub">Safe: ${rangeLabel("ph")} pH</div>
    </div>

    <div class="stat-card ${turbS}">
      <div class="stat-header">
        <div class="stat-icon-wrap ${turbS}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div>
        <span class="stat-badge ${turbS}">${statusLabel(turbS)}</span>
      </div>
      <div class="stat-value">${fmt(r.turbidity)}<span class="stat-unit">NTU</span></div>
      <div class="stat-label">Turbidity</div>
      <div class="stat-sub">Safe: ${rangeLabel("turbidity")} NTU</div>
    </div>

    <div class="stat-card ${tdsS}">
      <div class="stat-header">
        <div class="stat-icon-wrap ${tdsS}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div>
        <span class="stat-badge ${tdsS}">${statusLabel(tdsS)}</span>
      </div>
      <div class="stat-value">${fmt(r.tds, 0)}<span class="stat-unit">ppm</span></div>
      <div class="stat-label">TDS</div>
      <div class="stat-sub">Safe: ${rangeLabel("tds")} ppm</div>
    </div>

    <div class="stat-card info">
      <div class="stat-header">
        <div class="stat-icon-wrap info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
        <span class="stat-badge info">Active</span>
      </div>
      <div class="stat-value">${d.online || 0}<span class="stat-unit">/ ${d.total || 0}</span></div>
      <div class="stat-label">Devices Online</div>
      <div class="stat-sub">${d.offline || 0} offline · ${d.maintenance || 0} maintenance</div>
    </div>
  `;
}

// ── Live sensor param tiles ──────────────────────────────────────────────────
function renderLiveParams(r, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!r) {
    el.innerHTML = emptyPanel("No live sensor data available. Connect an ESP32 device to begin monitoring.");
    return;
  }

  const params = [
    { key: "ph_level",    label: "pH Level",    unit: "pH",    thr: "ph",          dec: 2 },
    { key: "turbidity",   label: "Turbidity",   unit: "NTU",   thr: "turbidity",   dec: 2 },
    { key: "tds",         label: "TDS",         unit: "ppm",   thr: "tds",         dec: 0 },
    { key: "temperature", label: "Temperature", unit: "°C",    thr: "temperature", dec: 2 },
    { key: "ammonia",     label: "Ammonia",     unit: "mg/L",  thr: "ammonia",     dec: 2 },
    { key: "flow_rate",   label: "Flow Rate",   unit: "L/min", thr: "flow_rate",   dec: 1 },
  ];

  el.innerHTML = params.map(p => {
    const val    = r[p.key];
    const status = paramStatus(p.thr, val);
    const pct    = paramPercent(p.thr, val);
    return `
      <div class="param-tile">
        <div class="param-top">
          <span class="param-name">${p.label}</span>
          <div class="param-status-dot ${status}"></div>
        </div>
        <div class="param-val">${fmt(val, p.dec)}<span class="param-unit">${p.unit}</span></div>
        <div class="param-range">Safe: ${rangeLabel(p.thr)} ${p.unit}</div>
        <div class="param-bar-wrap"><div class="param-bar ${status}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

// ── Recent readings table (dashboard bottom-right) ───────────────────────────
async function loadRecentReadingsTable() {
  const tbody = document.getElementById("dashboard-recent-readings");
  if (!tbody) return;

  try {
    const rows = await apiGet("/api/sensors/latest");
    if (!rows) return;

    if (rows.length === 0) {
      tbody.innerHTML = emptyRow(5, "No sensor readings recorded yet.");
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const isOffline = r.device_status === "offline";
      const status    = isOffline ? "offline" : overallStatus(r);
      const badge     = isOffline
        ? `<span class="r-status offline">Offline</span>`
        : `<span class="r-status ${status}">${statusLabel(status)}</span>`;

      return `<tr>
        <td><strong>${r.device_id}</strong><br/><span style="font-size:11px;color:var(--text-light)">${r.building_name || "—"}</span></td>
        <td>${fmt(r.ph_level)}</td>
        <td>${fmt(r.turbidity)} NTU</td>
        <td>${fmt(r.temperature)} °C</td>
        <td>${badge}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadRecentReadingsTable error:", err);
    tbody.innerHTML = emptyRow(5, "Unable to load readings.");
  }
}

// ── Buildings preview (dashboard bottom-left) ────────────────────────────────
async function loadBuildingsPreview() {
  const el = document.getElementById("dashboard-buildings");
  if (!el) return;

  try {
    const rows = await apiGet("/api/locations");
    if (!rows) return;

    // Only show the 5 real buildings (IDs 1–5); skip duplicates
    const real = rows.filter(l => l.location_id <= 5);

    if (real.length === 0) {
      el.innerHTML = `
        <div class="panel-head"><div class="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>Monitored Buildings</div></div>
        ${emptyPanel("No locations configured yet.")}`;
      return;
    }

    const items = real.map((l, i) => {
      const hasDevices = Number(l.device_count) > 0;
      return `
        <div class="building-item">
          <div class="building-num">${String(i + 1).padStart(2, "0")}</div>
          <div class="building-info">
            <div class="building-name">${l.building_name || "Unnamed"}</div>
            <div class="building-area">${l.area_name || "—"}</div>
          </div>
          <div class="building-status ${hasDevices ? "safe" : "offline"}">
            <div class="b-dot ${hasDevices ? "safe" : "offline"}"></div>
            ${l.device_count} device${l.device_count == 1 ? "" : "s"}
          </div>
        </div>`;
    }).join("");

    el.innerHTML = `
      <div class="panel-head">
        <div class="panel-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          Monitored Buildings
        </div>
        <button class="panel-action" onclick="navigate('locations')">View all →</button>
      </div>
      ${items}`;
  } catch (err) {
    console.error("[AquaSense] loadBuildingsPreview error:", err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LIVE MONITORING VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadLiveMonitoring() {
  try {
    const summary = await apiGet("/api/dashboard/summary");
    if (!summary) return;

    buildThresholdMap(summary.thresholds);
    renderLiveStats(summary.latestReading);
    renderLiveParams(summary.latestReading, "live-params");
  } catch (err) {
    console.error("[AquaSense] loadLiveMonitoring error:", err);
  }
}

function renderLiveStats(r) {
  const grid = document.getElementById("live-stats");
  if (!grid) return;

  if (!r) {
    grid.innerHTML = `<div class="stat-card navy" style="grid-column:1/-1;"><div class="stat-label" style="text-align:center;padding:20px;">No live data available.</div></div>`;
    return;
  }

  const phS   = paramStatus("ph",          r.ph_level);
  const turbS = paramStatus("turbidity",   r.turbidity);
  const tempS = paramStatus("temperature", r.temperature);
  const flowS = paramStatus("flow_rate",   r.flow_rate);

  grid.innerHTML = `
    <div class="stat-card ${phS}">
      <div class="stat-header"><div class="stat-icon-wrap ${phS}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div><span class="stat-badge ${phS}">${statusLabel(phS)}</span></div>
      <div class="stat-value">${fmt(r.ph_level)}<span class="stat-unit">pH</span></div>
      <div class="stat-label">pH Level</div><div class="stat-sub">${r.building_name || "—"} · ${timeAgo(r.recorded_at)}</div>
    </div>
    <div class="stat-card ${turbS}">
      <div class="stat-header"><div class="stat-icon-wrap ${turbS}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div><span class="stat-badge ${turbS}">${statusLabel(turbS)}</span></div>
      <div class="stat-value">${fmt(r.turbidity)}<span class="stat-unit">NTU</span></div>
      <div class="stat-label">Turbidity</div><div class="stat-sub">Latest reading</div>
    </div>
    <div class="stat-card ${tempS}">
      <div class="stat-header"><div class="stat-icon-wrap ${tempS}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg></div><span class="stat-badge ${tempS}">${statusLabel(tempS)}</span></div>
      <div class="stat-value">${fmt(r.temperature)}<span class="stat-unit">°C</span></div>
      <div class="stat-label">Temperature</div><div class="stat-sub">${tempS === "safe" ? "Within safe range" : "Check threshold"}</div>
    </div>
    <div class="stat-card ${flowS}">
      <div class="stat-header"><div class="stat-icon-wrap ${flowS}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><span class="stat-badge ${flowS}">${statusLabel(flowS)}</span></div>
      <div class="stat-value">${fmt(r.flow_rate)}<span class="stat-unit">L/min</span></div>
      <div class="stat-label">Flow Rate</div><div class="stat-sub">${flowS !== "safe" ? "Elevated — monitor closely" : "Normal"}</div>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// SENSOR READINGS LOG VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadSensorReadingsLog() {
  const tbody = document.getElementById("readings-tbody");
  if (!tbody) return;

  try {
    const result = await apiGet("/api/sensors?limit=50");
    if (!result) return;

    if (!result.data || result.data.length === 0) {
      tbody.innerHTML = emptyRow(10, "No sensor readings recorded yet. Data will appear once ESP32 devices start reporting.");
      return;
    }

    tbody.innerHTML = result.data.map(r => {
      const status = overallStatus(r);
      return `<tr>
        <td>#${r.id}</td>
        <td><strong>${r.device_id}</strong> / ${r.building_name || "—"}</td>
        <td>${fmt(r.ph_level)}</td>
        <td>${fmt(r.turbidity)} NTU</td>
        <td>${fmt(r.tds, 0)} ppm</td>
        <td>${fmt(r.temperature)}°C</td>
        <td>${fmt(r.ammonia, 2)} mg/L</td>
        <td>${fmt(r.flow_rate)} L/m</td>
        <td><span class="r-status ${status}">${statusLabel(status)}</span></td>
        <td style="color:var(--text-light);font-size:11px">${timeAgo(r.recorded_at)}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadSensorReadingsLog error:", err);
    tbody.innerHTML = emptyRow(10, "Unable to load sensor readings.");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ALERTS  — schema: level, status ('unresolved'/'resolved'), parameter, message
// ═════════════════════════════════════════════════════════════════════════════
async function loadAlerts(status = "all", containerId = "alerts-full-list", isPreview = false) {
  const el = document.getElementById(containerId);
  if (!el) return;

  try {
    // API accepts: status=unresolved | resolved | all
    const apiStatus = status === "active" ? "unresolved" : status;
    const limitParam = isPreview ? "&limit=5" : "&limit=50";
    const rows = await apiGet(`/api/alerts?status=${apiStatus}${limitParam}`);
    if (!rows) return;

    if (rows.length === 0) {
      el.innerHTML = emptyPanel(
        apiStatus === "unresolved" ? "No active alerts. All systems normal." : "No alerts recorded yet."
      );
      return;
    }

    el.innerHTML = rows.map(a => {
      const level      = alertClass(a.level);
      const isResolved = a.status === "resolved";
      const alertIcon  = isResolved
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

      const dotClass = isResolved ? "low" : level;
      const paramInfo = a.parameter ? ` · ${a.parameter.toUpperCase()}: ${a.value ?? ""}` : "";

      return `
        <div class="alert-item" ${isResolved ? 'style="opacity:.55;"' : ""}>
          <div class="alert-dot-wrap ${dotClass}">${alertIcon}</div>
          <div class="alert-info">
            <div class="alert-title">${a.message || a.parameter || "Alert"}</div>
            <div class="alert-meta">${a.building_name || a.device_id || "—"}${paramInfo} · ${timeAgo(a.created_at)}${isResolved ? " · Resolved" : ""}</div>
          </div>
          ${isResolved
            ? `<span class="alert-level resolved">Resolved</span>`
            : `<span class="alert-level ${level}">${a.level ? a.level.charAt(0).toUpperCase() + a.level.slice(1) : "Alert"}</span>`
          }
        </div>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadAlerts error:", err);
    el.innerHTML = emptyPanel("Unable to load alerts.");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DEVICES VIEW — device_id is VARCHAR; no installed_date; no esp32_uid
// ═════════════════════════════════════════════════════════════════════════════
async function loadDevices() {
  const tbody   = document.getElementById("devices-tbody");
  const statsEl = document.getElementById("devices-stats");

  try {
    const rows = await apiGet("/api/devices");
    if (!rows) return;

    if (statsEl) {
      const online      = rows.filter(d => d.status === "online").length;
      const offline     = rows.filter(d => d.status === "offline").length;
      const maintenance = rows.filter(d => d.status === "maintenance").length;

      statsEl.innerHTML = `
        <div class="stat-card safe"><div class="stat-header"><div class="stat-icon-wrap safe"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><span class="stat-badge safe">Online</span></div><div class="stat-value">${online}</div><div class="stat-label">Online Devices</div></div>
        <div class="stat-card danger"><div class="stat-header"><div class="stat-icon-wrap danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><span class="stat-badge danger">Offline</span></div><div class="stat-value">${offline}</div><div class="stat-label">Offline Devices</div></div>
        <div class="stat-card navy"><div class="stat-header"><div class="stat-icon-wrap navy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/></svg></div><span class="stat-badge navy">Total</span></div><div class="stat-value">${rows.length}</div><div class="stat-label">Total Devices</div></div>
        <div class="stat-card warn"><div class="stat-header"><div class="stat-icon-wrap warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><span class="stat-badge warn">Pending</span></div><div class="stat-value">${maintenance}</div><div class="stat-label">In Maintenance</div></div>
      `;
    }

    if (!tbody) return;

    if (rows.length === 0) {
      tbody.innerHTML = emptyRow(5, "No devices registered yet.");
      return;
    }

    // device_id is VARCHAR like 'ESP-001' — use it directly; last_online is the timestamp column
    tbody.innerHTML = rows.map(d => {
      const lastSeen = d.last_reading_at
        ? timeAgo(d.last_reading_at)
        : (d.last_online ? timeAgo(d.last_online) : "—");

      const statusClass = d.status === "online" ? "online"
        : d.status === "maintenance" ? "maintenance"
        : "offline";

      return `<tr>
        <td><strong>${d.device_id}</strong></td>
        <td>${d.device_name || "—"}</td>
        <td>${d.building_name || "—"}</td>
        <td>${lastSeen}</td>
        <td><span class="device-badge ${statusClass}"><span class="device-badge-dot"></span>${d.status.charAt(0).toUpperCase() + d.status.slice(1)}</span></td>
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadDevices error:", err);
    if (tbody) tbody.innerHTML = emptyRow(5, "Unable to load devices.");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LOCATIONS VIEW — filter to IDs 1–5 to skip duplicate rows
// ═════════════════════════════════════════════════════════════════════════════
async function loadLocations(containerId = "locations-tbody") {
  const el = document.getElementById(containerId);
  if (!el) return;

  try {
    const rows = await apiGet("/api/locations");
    if (!rows) return;

    // Only real buildings (IDs 1–5); duplicates are location_id > 5
    const real = rows.filter(l => l.location_id <= 5);

    if (real.length === 0) {
      el.innerHTML = emptyRow(6, "No locations configured yet.");
      return;
    }

    el.innerHTML = real.map((l, i) => {
      const hasDevices = Number(l.device_count) > 0;
      return `<tr>
        <td>${String(i + 1).padStart(2, "0")}</td>
        <td><strong>${l.building_name || "Unnamed"}</strong></td>
        <td>${l.area_name || "—"}</td>
        <td>${l.description || "—"}</td>
        <td>${l.device_count} device${l.device_count == 1 ? "" : "s"}</td>
        <td><span class="r-status ${hasDevices ? "safe" : "offline"}">${hasDevices ? "Monitored" : "No Devices"}</span></td>
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadLocations error:", err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAINTENANCE LOGS VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadMaintenanceLogs() {
  const el = document.getElementById("maintenance-list");
  if (!el) return;

  // Maintenance logs don't have a dedicated API endpoint yet,
  // so we show a placeholder until /api/maintenance is added.
  // The data IS in the DB (maintenance_logs table).
  // TODO: add GET /api/maintenance to dataRoutes.js
  el.innerHTML = emptyPanel("Maintenance log API not yet wired. Add GET /api/maintenance to dataRoutes.js.");
}

// ═════════════════════════════════════════════════════════════════════════════
// SMS LOGS VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadSmsLogs() {
  const el = document.getElementById("sms-list");
  if (!el) return;

  // TODO: add GET /api/sms-logs to dataRoutes.js
  el.innerHTML = emptyPanel("SMS log API not yet wired. Add GET /api/sms-logs to dataRoutes.js.");
}

// ═════════════════════════════════════════════════════════════════════════════
// VIEW LOADER MAP + AUTO-REFRESH
// ═════════════════════════════════════════════════════════════════════════════
const viewLoaders = {
  dashboard:   loadDashboard,
  live:        loadLiveMonitoring,
  readings:    loadSensorReadingsLog,
  alerts:      () => loadAlerts("all", "alerts-full-list", false),
  devices:     loadDevices,
  locations:   () => loadLocations("locations-tbody"),
  maintenance: loadMaintenanceLogs,
  sms:         loadSmsLogs,
};

let refreshInterval = null;

function startAutoRefresh(viewKey) {
  if (refreshInterval) clearInterval(refreshInterval);
  if (["dashboard", "live"].includes(viewKey)) {
    refreshInterval = setInterval(() => {
      if (viewLoaders[viewKey]) viewLoaders[viewKey]();
    }, 30000);
  }
}

// ── Wire into dashboard.html's navigate() ────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Wrap the existing navigate() to also trigger data loads
  const _originalNavigate = window.navigate;
  window.navigate = function (viewKey) {
    if (typeof _originalNavigate === "function") _originalNavigate(viewKey);
    if (viewLoaders[viewKey]) viewLoaders[viewKey]();
    startAutoRefresh(viewKey);
  };

  // Patch nav item clicks so they go through the new navigate()
  document.querySelectorAll(".nav-item[data-view]").forEach(item => {
    // remove the old listener by cloning
    const clone = item.cloneNode(true);
    item.parentNode.replaceChild(clone, item);
    clone.addEventListener("click", () => navigate(clone.dataset.view));
  });

  // Initial load
  loadDashboard();
  startAutoRefresh("dashboard");

  // Refresh button
  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    const active = document.querySelector(".view.active");
    if (active) {
      const key = active.id.replace("view-", "");
      if (viewLoaders[key]) viewLoaders[key]();
    }
  });
});