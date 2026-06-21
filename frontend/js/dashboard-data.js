// dashboard-data.js — AquaSense live data binder  (PATCHED — Analytics + Alerts connected)
// Matches real schema: smart_water_monitoring.sql
// sensor_readings has NO water_status column — status is computed from threshold_settings
// alerts uses: level, status ('unresolved'/'resolved'), parameter, message
// devices: device_id is VARCHAR (e.g. 'ESP-001'), no installed_date, no esp32_uid
// locations: all rows from /api/locations are shown (no id filter)

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

// Map alerts.level → CSS class
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
  await refreshAlertBadgeCounts();
  await loadBuildingsPreview();
}

// ── Keep sidebar + dashboard-panel alert badges in sync with the real
//    unresolved-alert count (replaces the static "3" placeholder) ───────────
async function refreshAlertBadgeCounts() {
  try {
    const rows = await apiGet("/api/alerts?status=unresolved&limit=200");
    updateAlertBadges(rows ? rows.length : 0);
  } catch (err) {
    console.error("[AquaSense] refreshAlertBadgeCounts error:", err);
  }
}

function updateAlertBadges(count) {
  const navBadge = document.getElementById("navAlertsBadge")
    || document.querySelector('.nav-item[data-view="alerts"] .nav-badge');
  if (navBadge) {
    navBadge.textContent = count;
    navBadge.style.display = count > 0 ? "" : "none";
  }

  const panelBadge = document.getElementById("dashboardAlertsBadge");
  if (panelBadge) {
    panelBadge.textContent = count;
    panelBadge.style.display = count > 0 ? "" : "none";
  }
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

    const real = rows;

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

  const isAdmin = currentUserIsAdmin();
  const checkHeader = document.getElementById("readingsCheckHeader");
  if (checkHeader) checkHeader.style.display = isAdmin ? "" : "none";

  // Make sure thresholds are loaded so status colors/filtering are correct
  // even when this is the first view the user lands on.
  if (Object.keys(thresholdMap).length === 0) {
    try {
      const summary = await apiGet("/api/dashboard/summary");
      if (summary) buildThresholdMap(summary.thresholds);
    } catch (err) {
      console.warn("[AquaSense] Could not pre-load thresholds for readings view:", err);
    }
  }

  // Pull whatever filters are currently active from dashboard.html's filter bar
  const filters = (typeof readingsActiveFilters !== "undefined") ? readingsActiveFilters : {};
  const params = new URLSearchParams();
  params.set("limit", "50");
  if (filters.device_id) params.set("device_id", filters.device_id);
  if (filters.range)     params.set("range", filters.range);

  try {
    const result = await apiGet(`/api/sensors?${params.toString()}`);
    if (!result) return;

    let rows = result.data || [];

    // Status filtering happens client-side since "status" is derived from
    // threshold_settings rather than stored as a column on sensor_readings.
    if (filters.status) {
      rows = rows.filter(r => overallStatus(r) === filters.status);
    }

    const colCount = isAdmin ? 11 : 10;

    if (rows.length === 0) {
      tbody.innerHTML = emptyRow(colCount, "No sensor readings match your filters.");
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const status = overallStatus(r);
      const checkboxCell = isAdmin
        ? `<td class="row-checkbox-cell"><input type="checkbox" class="reading-row-checkbox" value="${r.id}"/></td>`
        : "";

      return `<tr>
        ${checkboxCell}
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

    // Reset selection state (checkboxes are freshly rendered, none checked)
    if (typeof updateReadingsSelection === "function") updateReadingsSelection();
  } catch (err) {
    console.error("[AquaSense] loadSensorReadingsLog error:", err);
    tbody.innerHTML = emptyRow(isAdmin ? 11 : 10, "Unable to load sensor readings.");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ALERTS VIEW  ← NOW FULLY CONNECTED TO DATABASE
// ═════════════════════════════════════════════════════════════════════════════

// loadAlerts: shared helper used by dashboard preview + full alerts view
async function loadAlerts(status = "all", containerId = "alerts-full-list", isPreview = false) {
  const el = document.getElementById(containerId);
  if (!el) return;

  try {
    const apiStatus  = status === "active" ? "unresolved" : status;
    const limitParam = isPreview ? "&limit=5" : "&limit=50";
    const rows = await apiGet(`/api/alerts?status=${apiStatus}${limitParam}`);
    if (!rows) return;

    if (rows.length === 0) {
      el.innerHTML = emptyPanel(
        apiStatus === "unresolved" ? "No active alerts. All systems normal." : "No alerts recorded yet."
      );
      return;
    }

    const isAdmin = currentUserIsAdmin();

    el.innerHTML = rows.map(a => {
      const level      = alertClass(a.level);
      const isResolved = a.status === "resolved";
      const alertIcon  = isResolved
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

      const dotClass = isResolved ? "low" : level;
      const paramInfo = a.parameter ? ` · ${a.parameter.toUpperCase()}: ${a.value ?? ""}` : "";

      // Delete icon — full alert list only (not the dashboard preview widget),
      // admins only. Opens a simple Yes/No modal, no typed "CONFIRM" step.
      const alertId = a.alert_id ?? a.id;
      const deleteBtn = (!isPreview && isAdmin && alertId != null) ? `
            <button class="alert-delete-btn delete-alert-btn" data-id="${alertId}" data-name="${escapeHtml(a.message || a.parameter || 'Alert')}" title="Delete alert" aria-label="Delete alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>` : "";

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
          }${deleteBtn}
        </div>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadAlerts error:", err);
    el.innerHTML = emptyPanel("Unable to load alerts.");
  }
}

// Full alerts page view: loads stat cards + full list  ← NEW
async function loadAlertsView() {
  try {
    // Fetch all alerts for the stat counts
    const [allAlerts, unresolvedAlerts] = await Promise.all([
      apiGet("/api/alerts?status=all&limit=200"),
      apiGet("/api/alerts?status=unresolved&limit=200"),
    ]);
    if (!allAlerts) return;

    const total      = allAlerts.length;
    const unresolved = unresolvedAlerts ? unresolvedAlerts.length : 0;
    const resolved   = total - unresolved;

    // ── Stat cards ────────────────────────────────────────────────────────
    const statsEl = document.getElementById("alerts-stats");
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat-card danger">
          <div class="stat-header">
            <div class="stat-icon-wrap danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <span class="stat-badge danger">Unresolved</span>
          </div>
          <div class="stat-value">${unresolved}</div>
          <div class="stat-label">Active Alerts</div>
        </div>
        <div class="stat-card warn">
          <div class="stat-header">
            <div class="stat-icon-wrap warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <span class="stat-badge warn">This Month</span>
          </div>
          <div class="stat-value">${total}</div>
          <div class="stat-label">Total Alerts</div>
        </div>
        <div class="stat-card safe">
          <div class="stat-header">
            <div class="stat-icon-wrap safe"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
            <span class="stat-badge safe">Resolved</span>
          </div>
          <div class="stat-value">${resolved}</div>
          <div class="stat-label">Resolved Alerts</div>
        </div>
        <div class="stat-card info">
          <div class="stat-header">
            <div class="stat-icon-wrap info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
            <span class="stat-badge info">Coverage</span>
          </div>
          <div class="stat-value">${total > 0 ? Math.round((resolved / total) * 100) : 0}<span class="stat-unit">%</span></div>
          <div class="stat-label">Resolution Rate</div>
        </div>`;
    }

    // ── Update nav badge with live count ──────────────────────────────────
    updateAlertBadges(unresolved);

    // ── Full alert list ───────────────────────────────────────────────────
    await loadAlerts("all", "alerts-full-list", false);

  } catch (err) {
    console.error("[AquaSense] loadAlertsView error:", err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ANALYTICS VIEW  ← NOW FULLY CONNECTED TO DATABASE
// ═════════════════════════════════════════════════════════════════════════════
async function loadAnalytics() {
  try {
    // Fetch analytics summary from the new backend endpoint
    const data = await apiGet("/api/analytics/summary");
    if (!data) return;

    // ── Stat cards ────────────────────────────────────────────────────────
    const statsEl = document.getElementById("analytics-stats");
    if (statsEl) {
      const uptimeClass = Number(data.uptimePercent) >= 80 ? "safe" : "warn";
      const alertClass_ = (data.alertStats.unresolved || 0) > 0 ? "warn" : "safe";

      statsEl.innerHTML = `
        <div class="stat-card info">
          <div class="stat-header">
            <div class="stat-icon-wrap info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg></div>
            <span class="stat-badge info">This Week</span>
          </div>
          <div class="stat-value">${fmt(data.totalWeekConsumption, 0)}<span class="stat-unit">L</span></div>
          <div class="stat-label">Total Consumption</div>
          <div class="stat-sub">Last 7 days across all buildings</div>
        </div>
        <div class="stat-card ${uptimeClass}">
          <div class="stat-header">
            <div class="stat-icon-wrap ${uptimeClass}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>
            <span class="stat-badge ${uptimeClass}">${uptimeClass === "safe" ? "Good" : "Degraded"}</span>
          </div>
          <div class="stat-value">${data.uptimePercent}<span class="stat-unit">%</span></div>
          <div class="stat-label">Device Uptime</div>
          <div class="stat-sub">${data.onlineDevices} of ${data.totalDevices} devices online</div>
        </div>
        <div class="stat-card ${alertClass_}">
          <div class="stat-header">
            <div class="stat-icon-wrap ${alertClass_}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <span class="stat-badge ${alertClass_}">This Month</span>
          </div>
          <div class="stat-value">${data.alertStats.total_month || 0}<span class="stat-unit">alerts</span></div>
          <div class="stat-label">Total Alerts</div>
          <div class="stat-sub">${data.alertStats.unresolved || 0} unresolved</div>
        </div>
        <div class="stat-card safe">
          <div class="stat-header">
            <div class="stat-icon-wrap safe"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 C12 2 4 9 4 14 A8 8 0 0 0 20 14 C20 9 12 2 12 2 Z"/></svg></div>
            <span class="stat-badge safe">Avg</span>
          </div>
          <div class="stat-value">${data.avgPh !== null ? fmt(data.avgPh) : "—"}<span class="stat-unit">pH</span></div>
          <div class="stat-label">Avg pH (7 days)</div>
          <div class="stat-sub">Within PNSDW 2017 standard (6.5–8.5)</div>
        </div>`;
    }

    // ── Bar chart: daily consumption ──────────────────────────────────────
    renderAnalyticsChart(data.dailyTotals, data.buildingDaily);

  } catch (err) {
    console.error("[AquaSense] loadAnalytics error:", err);
    const statsEl = document.getElementById("analytics-stats");
    if (statsEl) statsEl.innerHTML = `<div class="stat-card navy" style="grid-column:1/-1;"><div class="stat-label" style="text-align:center;padding:20px;">Unable to load analytics data.</div></div>`;
  }
}

// ── Analytics chart renderer ─────────────────────────────────────────────────
function renderAnalyticsChart(dailyTotals, buildingDaily) {
  const chartEl = document.getElementById("analytics-chart");
  if (!chartEl) return;

  if (!dailyTotals || dailyTotals.length === 0) {
    chartEl.innerHTML = emptyPanel("No consumption data available yet. Data will appear once ESP32 devices report water_consumed values.");
    return;
  }

  // Find max value for scaling
  const maxVal = Math.max(...dailyTotals.map(d => Number(d.consumed) || 0), 1);
  const chartH = 140; // usable bar height in px
  const svgW   = 600;
  const svgH   = 190;
  const leftPad = 50;
  const days    = dailyTotals.length;
  const slotW   = (svgW - leftPad - 10) / Math.max(days, 1);
  const barW    = Math.min(slotW * 0.55, 48);

  // Y-axis labels
  const yLabels = [maxVal, maxVal * 0.75, maxVal * 0.5, maxVal * 0.25].map(v => Math.round(v));
  const yPositions = [20, 55, 90, 125];

  let gridLines = yLabels.map((val, i) => `
    <line x1="${leftPad}" y1="${yPositions[i]}" x2="${svgW - 5}" y2="${yPositions[i]}" stroke="#DDE3EE" stroke-width="1" stroke-dasharray="4,4"/>
    <text x="${leftPad - 5}" y="${yPositions[i] + 4}" font-size="10" fill="#8292B0" text-anchor="end">${val}L</text>
  `).join("");

  let bars = dailyTotals.map((d, i) => {
    const x       = leftPad + i * slotW + (slotW - barW) / 2;
    const val     = Number(d.consumed) || 0;
    const barH    = Math.max((val / maxVal) * chartH, 2);
    const y       = 20 + chartH - barH;
    const dayName = d.day_name ? d.day_name.slice(0, 3) : `D${i + 1}`;
    const isMax   = val === maxVal;
    const fill    = isMax ? "url(#wg1)" : "url(#bg1)";
    const cx      = x + barW / 2;

    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="5" fill="${fill}"/>
      <text x="${cx}" y="${svgH - 25}" font-size="10" fill="#8292B0" text-anchor="middle">${dayName}</text>
      ${val > 0 ? `<text x="${cx}" y="${y - 4}" font-size="9" fill="#4A5878" text-anchor="middle">${Math.round(val)}</text>` : ""}
    `;
  }).join("");

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;height:${svgH}px;overflow:visible;">
      <defs>
        <linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2C9AD1" stop-opacity=".9"/>
          <stop offset="100%" stop-color="#1A6FA8" stop-opacity=".7"/>
        </linearGradient>
        <linearGradient id="wg1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#D4A017" stop-opacity=".9"/>
          <stop offset="100%" stop-color="#C97A00" stop-opacity=".7"/>
        </linearGradient>
      </defs>
      ${gridLines}
      ${bars}
    </svg>`;

  // ── Per-building breakdown table ──────────────────────────────────────
  const tableEl = document.getElementById("analytics-building-table");
  if (!tableEl || !buildingDaily || buildingDaily.length === 0) return;

  // Aggregate total per building
  const buildingMap = {};
  buildingDaily.forEach(row => {
    const name = row.building_name || "Unknown";
    buildingMap[name] = (buildingMap[name] || 0) + Number(row.consumed || 0);
  });

  const grandTotal = Object.values(buildingMap).reduce((a, b) => a + b, 0) || 1;

  tableEl.innerHTML = Object.entries(buildingMap).map(([name, total], i) => {
    const pct = ((total / grandTotal) * 100).toFixed(1);
    return `<tr>
      <td>${String(i + 1).padStart(2, "0")}</td>
      <td><strong>${name}</strong></td>
      <td>${fmt(total, 1)} L</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#2C9AD1,#1A6FA8);border-radius:3px;"></div>
          </div>
          <span style="font-size:11px;color:var(--text-mid);width:36px;text-align:right;">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join("");
}

// ═════════════════════════════════════════════════════════════════════════════
// DEVICES VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadDevices() {
  const tbody   = document.getElementById("devices-tbody");
  const statsEl = document.getElementById("devices-stats");

  const isAdmin = currentUserIsAdmin();
  const actionHeader = document.getElementById("devDeleteHeader");
  if (actionHeader) actionHeader.style.display = isAdmin ? "" : "none";

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
      tbody.innerHTML = emptyRow(isAdmin ? 6 : 5, "No devices registered yet.");
      return;
    }

    tbody.innerHTML = rows.map(d => {
      const lastSeen = d.last_reading_at
        ? timeAgo(d.last_reading_at)
        : (d.last_online ? timeAgo(d.last_online) : "—");

      const statusClass = d.status === "online" ? "online"
        : d.status === "maintenance" ? "maintenance"
        : "offline";

      const deleteCell = isAdmin ? `
        <td>
          <button class="btn-delete-row delete-device-btn" data-id="${d.device_id}" data-name="${escapeHtml(d.device_name || d.device_id)}">
            Delete
          </button>
        </td>` : "";

      return `<tr>
        <td><strong>${d.device_id}</strong></td>
        <td>${d.device_name || "—"}</td>
        <td>${d.building_name || "—"}</td>
        <td>${lastSeen}</td>
        <td><span class="device-badge ${statusClass}"><span class="device-badge-dot"></span>${d.status.charAt(0).toUpperCase() + d.status.slice(1)}</span></td>
        ${deleteCell}
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadDevices error:", err);
    if (tbody) tbody.innerHTML = emptyRow(5, "Unable to load devices.");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LOCATIONS VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadLocations(containerId = "locations-tbody") {
  const el = document.getElementById(containerId);
  if (!el) return;

  const isAdmin = currentUserIsAdmin();

  // Show/hide the Action header column for admins only
  const actionHeader = document.getElementById("locDeleteHeader");
  if (actionHeader) actionHeader.style.display = isAdmin ? "" : "none";

  try {
    const rows = await apiGet("/api/locations");
    if (!rows) return;

    if (rows.length === 0) {
      el.innerHTML = emptyRow(isAdmin ? 7 : 6, "No locations configured yet.");
      return;
    }

    el.innerHTML = rows.map((l, i) => {
      const hasDevices = Number(l.device_count) > 0;
      const deleteCell = isAdmin ? `
        <td>
          <button class="btn-delete-row delete-location-btn" data-id="${l.location_id}" data-name="${escapeHtml(l.building_name || 'Unnamed')}">
            Delete
          </button>
        </td>` : "";

      return `<tr>
        <td>${String(i + 1).padStart(2, "0")}</td>
        <td><strong>${l.building_name || "Unnamed"}</strong></td>
        <td>${l.area_name || "—"}</td>
        <td>${l.description || "—"}</td>
        <td>${l.device_count} device${l.device_count == 1 ? "" : "s"}</td>
        <td><span class="r-status ${hasDevices ? "safe" : "offline"}">${hasDevices ? "Monitored" : "No Devices"}</span></td>
        ${deleteCell}
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadLocations error:", err);
  }
}

// ── Helpers reused by delete buttons (role check + safe HTML escaping) ──────
function currentUserIsAdmin() {
  try {
    const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
    if (!raw) return false;
    const user = JSON.parse(raw);
    return (user.role || "").toLowerCase() === "admin";
  } catch (e) {
    return false;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ═════════════════════════════════════════════════════════════════════════════
// MAINTENANCE LOGS VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadMaintenanceLogs() {
  const el = document.getElementById("maintenance-list");
  if (!el) return;
  el.innerHTML = emptyPanel("Maintenance log API not yet wired. Add GET /api/maintenance to dataRoutes.js.");
}

// ═════════════════════════════════════════════════════════════════════════════
// SMS LOGS VIEW
// ═════════════════════════════════════════════════════════════════════════════

async function loadSmsLogs() {
  // ── Stat cards ──────────────────────────────────────────────────────────
  const statsEl = document.getElementById("sms-stats");
 
  // ── Log list ────────────────────────────────────────────────────────────
  const listEl = document.getElementById("sms-list");
 
  try {
    const rows = await apiGet("/api/sms-logs?limit=50");
    if (!rows) return;
 
    // ── Compute counts ────────────────────────────────────────────────────
    const sent    = rows.filter(r => r.status === "sent").length;
    const failed  = rows.filter(r => r.status === "failed").length;
    const pending = rows.filter(r => r.status === "pending").length;
 
    // ── Render stat cards ─────────────────────────────────────────────────
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat-card safe">
          <div class="stat-header">
            <div class="stat-icon-wrap safe">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.4h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </div>
            <span class="stat-badge safe">Sent</span>
          </div>
          <div class="stat-value">${sent}</div>
          <div class="stat-label">Messages Sent</div>
        </div>
 
        <div class="stat-card danger">
          <div class="stat-header">
            <div class="stat-icon-wrap danger">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <span class="stat-badge danger">Failed</span>
          </div>
          <div class="stat-value">${failed}</div>
          <div class="stat-label">Failed</div>
        </div>
 
        <div class="stat-card warn">
          <div class="stat-header">
            <div class="stat-icon-wrap warn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <span class="stat-badge warn">Pending</span>
          </div>
          <div class="stat-value">${pending}</div>
          <div class="stat-label">Pending</div>
        </div>`;
    }
 
    // ── Render log list ───────────────────────────────────────────────────
    if (!listEl) return;
 
    if (rows.length === 0) {
      listEl.innerHTML = emptyPanel("No SMS notifications sent yet.");
      return;
    }
 
    const phoneIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.4h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
    </svg>`;
 
    listEl.innerHTML = rows.map(s => {
      const statusClass = s.status === "sent"    ? "sent"
                        : s.status === "failed"  ? "failed"
                        : "pending";
 
      const iconBg = s.status === "failed"
        ? "background:rgba(239,68,68,.1);stroke:#DC2626"
        : "background:rgba(44,154,209,.1);stroke:var(--water-1)";
 
      const location = s.building_name
        ? `${s.building_name}${s.device_id ? " · " + s.device_id : ""}`
        : (s.device_id || "—");
 
      const sentAt = s.created_at
        ? new Date(s.created_at).toLocaleString("en-PH", {
            month: "short", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true,
          })
        : "—";
 
      return `
        <div class="sms-item">
          <div class="sms-icon-wrap" style="${iconBg}">${phoneIcon}</div>
          <div class="sms-info">
            <div class="sms-msg">${s.message}</div>
            <div class="sms-meta">
              To: ${s.recipient} · ${location} · Provider: ${s.provider || "Semaphore"} · ${sentAt}
            </div>
          </div>
          <span class="sms-status ${statusClass}">${s.status.charAt(0).toUpperCase() + s.status.slice(1)}</span>
        </div>`;
    }).join("");
 
  } catch (err) {
    console.error("[AquaSense] loadSmsLogs error:", err);
    if (listEl) listEl.innerHTML = emptyPanel("Unable to load SMS logs.");
    if (statsEl) statsEl.innerHTML = "";
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// VIEW LOADER MAP + AUTO-REFRESH
// ═════════════════════════════════════════════════════════════════════════════
// Attached directly to `window` (not `const`) because dashboard.html's
// inline script calls `window.viewLoaders.devices()` / `.locations()`
// after every add/delete. A top-level `const` here would NOT become a
// `window` property in a plain (non-module) <script>, so those calls
// would silently no-op and the tables would only refresh on full reload.
window.viewLoaders = {
  dashboard:   loadDashboard,
  live:        loadLiveMonitoring,
  readings:    loadSensorReadingsLog,
  analytics:   loadAnalytics,                             // ← NOW CONNECTED
  alerts:      loadAlertsView,                            // ← NOW CONNECTED
  devices:     loadDevices,
  locations:   () => loadLocations("locations-tbody"),
  maintenance: loadMaintenanceLogs,
  sms:         loadSmsLogs,
};
const viewLoaders = window.viewLoaders;

let refreshInterval = null;

// Views that should keep polling the backend while the user is looking at
// them. "devices" and "alerts" are included so a device the health-check
// marks offline (and the alert it raises) shows up here on its own —
// no manual reload needed.
const AUTO_REFRESH_VIEWS = ["dashboard", "live", "devices", "alerts"];

function startAutoRefresh(viewKey) {
  if (refreshInterval) clearInterval(refreshInterval);
  if (AUTO_REFRESH_VIEWS.includes(viewKey)) {
    refreshInterval = setInterval(() => {
      if (viewLoaders[viewKey]) viewLoaders[viewKey]();
    }, 30000);
  }
}

// ── Wire into dashboard.html's navigate() ────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const _originalNavigate = window.navigate;
  window.navigate = function (viewKey) {
    if (typeof _originalNavigate === "function") _originalNavigate(viewKey);
    if (viewLoaders[viewKey]) viewLoaders[viewKey]();
    startAutoRefresh(viewKey);
  };

  document.querySelectorAll(".nav-item[data-view]").forEach(item => {
    const clone = item.cloneNode(true);
    item.parentNode.replaceChild(clone, item);
    clone.addEventListener("click", () => navigate(clone.dataset.view));
  });

  loadDashboard();
  startAutoRefresh("dashboard");

  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    const active = document.querySelector(".view.active");
    if (active) {
      const key = active.id.replace("view-", "");
      if (viewLoaders[key]) viewLoaders[key]();
    }
  });
});