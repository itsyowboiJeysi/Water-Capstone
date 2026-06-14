// dashboard-data.js — AquaSense live data binder
const API_BASE = "http://localhost:5000";

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
  if (!res.ok) throw new Error(`Request failed: ${path}`);
  return res.json();
}

// ── Helpers ──────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusClass(status) {
  if (!status) return "offline";
  return status; // 'safe' | 'warning' -> map below
}

function mapWaterStatus(status) {
  // sensor_readings.water_status: safe | warning | danger
  if (status === "warning") return "warn";
  if (status === "danger")  return "danger";
  return "safe";
}

function emptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}" style="text-align:center;color:var(--text-light);padding:28px;font-size:13px;">${message}</td></tr>`;
}

function emptyPanelMessage(message) {
  return `<div style="text-align:center;color:var(--text-light);padding:32px 20px;font-size:13px;">${message}</div>`;
}

// ── Threshold lookup (loaded once) ─────────────────────────────────────────
let thresholdMap = {};
function buildThresholdMap(thresholds) {
  thresholdMap = {};
  (thresholds || []).forEach(t => {
    thresholdMap[t.parameter_name] = { min: Number(t.min_value), max: Number(t.max_value) };
  });
}

function paramStatus(param, value) {
  const t = thresholdMap[param];
  if (!t || value === null || value === undefined) return "safe";
  const v = Number(value);
  if (v < t.min || v > t.max) return "danger";
  // warn if within 10% of max
  const range = t.max - t.min;
  if (range > 0 && v > t.max - range * 0.1) return "warn";
  return "safe";
}

function paramPercent(param, value) {
  const t = thresholdMap[param];
  if (!t || value === null || value === undefined) return 0;
  const range = t.max - t.min;
  if (range <= 0) return 0;
  const pct = ((Number(value) - t.min) / range) * 100;
  return Math.max(0, Math.min(100, pct));
}

// ════════════════════════════════════════════════════════════════════════
// DASHBOARD VIEW
// ════════════════════════════════════════════════════════════════════════
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

  await loadLatestReadingsTable();
  await loadAlerts("active", "dashboard-alerts", true);
  await loadLocations("dashboard-buildings", true);
}

function renderDashboardStats(summary) {
  const r = summary.latestReading;
  const grid = document.getElementById("dashboard-stats");
  if (!grid) return;

  if (!r) {
    grid.innerHTML = `
      <div class="stat-card navy" style="grid-column: 1 / -1;">
        <div class="stat-label" style="text-align:center;padding:20px 0;">No sensor data available yet. Waiting for ESP32 devices to report.</div>
      </div>`;
    return;
  }

  const phStatus  = paramStatus("ph", r.ph_level);
  const turbStatus = paramStatus("turbidity", r.turbidity);
  const tdsStatus  = paramStatus("tds", r.tds);

  const d = summary.devices || {};

  grid.innerHTML = `
    <div class="stat-card ${phStatus}">
      <div class="stat-header"><div class="stat-icon-wrap ${phStatus}"><svg viewBox="0 0 24 24"><path d="M12 2 C12 2 4 9 4 14 A8 8 0 0 0 20 14 C20 9 12 2 12 2 Z"/></svg></div><span class="stat-badge ${phStatus}">${phStatus === 'safe' ? 'Safe' : phStatus === 'warn' ? 'Warning' : 'Danger'}</span></div>
      <div class="stat-value">${fmt(r.ph_level)}<span class="stat-unit">pH</span></div>
      <div class="stat-label">pH Level</div><div class="stat-sub">Range: ${rangeLabel('ph')}</div>
    </div>
    <div class="stat-card ${turbStatus}">
      <div class="stat-header"><div class="stat-icon-wrap ${turbStatus}"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div><span class="stat-badge ${turbStatus}">${turbStatus === 'safe' ? 'Safe' : turbStatus === 'warn' ? 'Warning' : 'Danger'}</span></div>
      <div class="stat-value">${fmt(r.turbidity)}<span class="stat-unit">NTU</span></div>
      <div class="stat-label">Turbidity</div><div class="stat-sub">Range: ${rangeLabel('turbidity')}</div>
    </div>
    <div class="stat-card ${tdsStatus}">
      <div class="stat-header"><div class="stat-icon-wrap ${tdsStatus}"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><span class="stat-badge ${tdsStatus}">${tdsStatus === 'safe' ? 'Safe' : tdsStatus === 'warn' ? 'Warning' : 'Danger'}</span></div>
      <div class="stat-value">${fmt(r.tds, 0)}<span class="stat-unit">ppm</span></div>
      <div class="stat-label">TDS</div><div class="stat-sub">Range: ${rangeLabel('tds')}</div>
    </div>
    <div class="stat-card info">
      <div class="stat-header"><div class="stat-icon-wrap info"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><span class="stat-badge info">Active</span></div>
      <div class="stat-value">${d.online || 0}<span class="stat-unit">online</span></div>
      <div class="stat-label">Devices</div><div class="stat-sub">${d.offline || 0} offline · ${d.maintenance || 0} maintenance</div>
    </div>
  `;
}

function fmt(val, decimals = 1) {
  if (val === null || val === undefined) return "—";
  return Number(val).toFixed(decimals);
}

function rangeLabel(param) {
  const t = thresholdMap[param];
  if (!t) return "—";
  return `${t.min} – ${t.max}`;
}

function renderLiveParams(r, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!r) {
    el.innerHTML = emptyPanelMessage("No live sensor data available. Connect an ESP32 device to begin monitoring.");
    return;
  }

  const params = [
    { key: "ph_level",   name: "pH Level",     unit: "pH",    thr: "ph" },
    { key: "turbidity",  name: "Turbidity",    unit: "NTU",   thr: "turbidity" },
    { key: "tds",        name: "TDS",          unit: "ppm",   thr: "tds" },
    { key: "temperature",name: "Temperature",  unit: "°C",    thr: "temperature" },
    { key: "ammonia",    name: "Ammonia",      unit: "mg/L",  thr: "ammonia" },
    { key: "flow_rate",  name: "Flow Rate",    unit: "L/min", thr: "flow_rate" },
  ];

  el.innerHTML = params.map(p => {
    const val = r[p.key];
    const status = paramStatus(p.thr, val);
    const pct = paramPercent(p.thr, val);
    return `
      <div class="param-tile">
        <div class="param-top"><span class="param-name">${p.name}</span><div class="param-status-dot ${status}"></div></div>
        <div class="param-val">${fmt(val, p.key === 'tds' ? 0 : 2)}<span class="param-unit">${p.unit}</span></div>
        <div class="param-range">${rangeLabel(p.thr)} ${p.unit}</div>
        <div class="param-bar-wrap"><div class="param-bar ${status}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

// ════════════════════════════════════════════════════════════════════════
// LATEST READINGS TABLE (Dashboard "Recent Sensor Readings")
// ════════════════════════════════════════════════════════════════════════
async function loadLatestReadingsTable() {
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
      const status = r.device_status === "offline"
        ? `<span class="r-status offline">Offline</span>`
        : `<span class="r-status ${mapWaterStatus(r.water_status)}">${r.water_status === 'warning' ? 'Warning' : r.water_status === 'danger' ? 'Danger' : 'Safe'}</span>`;

      return `<tr>
        <td><strong>${r.device_id || ('DEV-' + r.device_id)}</strong><br/><span style="font-size:11px;color:var(--text-light)">${r.building_name || '—'}</span></td>
        <td>${fmt(r.ph_level)}</td>
        <td>${fmt(r.turbidity)} NTU</td>
        <td>${fmt(r.temperature)} °C</td>
        <td>${status}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadLatestReadingsTable error:", err);
    tbody.innerHTML = emptyRow(5, "Unable to load sensor readings.");
  }
}

// ════════════════════════════════════════════════════════════════════════
// LIVE MONITORING VIEW
// ════════════════════════════════════════════════════════════════════════
async function loadLiveMonitoring() {
  try {
    const summary = await apiGet("/api/dashboard/summary");
    if (!summary) return;
    buildThresholdMap(summary.thresholds);

    const r = summary.latestReading;
    renderLiveStats(r);
    renderLiveParams(r, "live-params");
  } catch (err) {
    console.error("[AquaSense] loadLiveMonitoring error:", err);
  }
}

function renderLiveStats(r) {
  const grid = document.getElementById("live-stats");
  if (!grid) return;

  if (!r) {
    grid.innerHTML = `<div class="stat-card navy" style="grid-column:1/-1;"><div class="stat-label" style="text-align:center;padding:20px 0;">No live data available.</div></div>`;
    return;
  }

  const phStatus = paramStatus("ph", r.ph_level);
  const turbStatus = paramStatus("turbidity", r.turbidity);
  const tempStatus = paramStatus("temperature", r.temperature);
  const flowStatus = paramStatus("flow_rate", r.flow_rate);

  grid.innerHTML = `
    <div class="stat-card ${phStatus}"><div class="stat-header"><div class="stat-icon-wrap ${phStatus}"><svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div><span class="stat-badge ${phStatus}">${phStatus==='safe'?'Normal':phStatus==='warn'?'Warning':'Danger'}</span></div><div class="stat-value">${fmt(r.ph_level)}<span class="stat-unit">pH</span></div><div class="stat-label">pH Level</div><div class="stat-sub">${r.building_name || '—'}</div></div>
    <div class="stat-card ${turbStatus}"><div class="stat-header"><div class="stat-icon-wrap ${turbStatus}"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div><span class="stat-badge ${turbStatus}">${turbStatus==='safe'?'Clear':turbStatus==='warn'?'Warning':'Danger'}</span></div><div class="stat-value">${fmt(r.turbidity)}<span class="stat-unit">NTU</span></div><div class="stat-label">Turbidity</div><div class="stat-sub">Latest reading</div></div>
    <div class="stat-card ${tempStatus}"><div class="stat-header"><div class="stat-icon-wrap ${tempStatus}"><svg viewBox="0 0 24 24"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg></div><span class="stat-badge ${tempStatus}">${tempStatus==='safe'?'Normal':tempStatus==='warn'?'Warning':'Danger'}</span></div><div class="stat-value">${fmt(r.temperature)}<span class="stat-unit">°C</span></div><div class="stat-label">Temperature</div><div class="stat-sub">${tempStatus === 'safe' ? 'Within safe range' : 'Check threshold'}</div></div>
    <div class="stat-card ${flowStatus}"><div class="stat-header"><div class="stat-icon-wrap ${flowStatus}"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><span class="stat-badge ${flowStatus}">${flowStatus==='safe'?'Normal':flowStatus==='warn'?'High':'Danger'}</span></div><div class="stat-value">${fmt(r.flow_rate)}<span class="stat-unit">L/min</span></div><div class="stat-label">Flow Rate</div><div class="stat-sub">${flowStatus !== 'safe' ? 'Elevated — monitor closely' : 'Normal'}</div></div>
  `;
}

// ════════════════════════════════════════════════════════════════════════
// SENSOR READINGS LOG VIEW
// ════════════════════════════════════════════════════════════════════════
async function loadSensorReadingsLog() {
  const tbody = document.getElementById("readings-tbody");
  if (!tbody) return;

  try {
    const result = await apiGet("/api/sensors?limit=50");
    if (!result) return;

    if (result.data.length === 0) {
      tbody.innerHTML = emptyRow(10, "No sensor readings recorded yet. Data will appear here once ESP32 devices begin reporting.");
      return;
    }

    tbody.innerHTML = result.data.map(r => `
      <tr>
        <td>#${r.id}</td>
        <td><strong>${r.device_id || ('DEV-' + r.device_id)}</strong> / ${r.building_name || '—'}</td>
        <td>${fmt(r.ph_level)}</td>
        <td>${fmt(r.turbidity)} NTU</td>
        <td>${fmt(r.tds, 0)} ppm</td>
        <td>${fmt(r.temperature)}°C</td>
        <td>${fmt(r.ammonia, 2)} mg/L</td>
        <td>${fmt(r.flow_rate)} L/m</td>
        <td><span class="r-status ${mapWaterStatus(r.water_status)}">${r.water_status === 'warning' ? 'Warning' : r.water_status === 'danger' ? 'Danger' : 'Safe'}</span></td>
        <td style="color:var(--text-light);font-size:11px">${timeAgo(r.recorded_at)}</td>
      </tr>`).join("");
  } catch (err) {
    console.error("[AquaSense] loadSensorReadingsLog error:", err);
    tbody.innerHTML = emptyRow(10, "Unable to load sensor readings.");
  }
}

// ════════════════════════════════════════════════════════════════════════
// ALERTS
// ════════════════════════════════════════════════════════════════════════
async function loadAlerts(status = "all", containerId = "alerts-list", isPreview = false) {
  const el = document.getElementById(containerId);
  if (!el) return;

  try {
    const limit = isPreview ? "&limit=5" : "";
    const rows = await apiGet(`/api/alerts?status=${status}${limit}`);
    if (!rows) return;

    if (rows.length === 0) {
      el.innerHTML = emptyPanelMessage(
        status === "active" ? "No active alerts. All systems normal." : "No alerts recorded yet."
      );
      return;
    }

    el.innerHTML = rows.map(a => {
      const level = a.alert_level || "medium";
      const resolved = a.is_resolved;
      const icon = resolved
        ? `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

      return `
        <div class="alert-item" ${resolved ? 'style="opacity:.55;"' : ''}>
          <div class="alert-dot-wrap ${level}">${icon}</div>
          <div class="alert-info">
            <div class="alert-title">${a.message || a.alert_type}</div>
            <div class="alert-meta">${a.building_name || ''} ${a.esp32_uid ? '· ' + a.esp32_uid : ''} · ${timeAgo(a.created_at)}${resolved ? ' · Resolved' : ''}</div>
          </div>
          ${resolved ? '' : `<span class="alert-level ${level}">${level.charAt(0).toUpperCase() + level.slice(1)}</span>`}
        </div>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadAlerts error:", err);
    el.innerHTML = emptyPanelMessage("Unable to load alerts.");
  }
}

// ════════════════════════════════════════════════════════════════════════
// DEVICES VIEW
// ════════════════════════════════════════════════════════════════════════
async function loadDevices() {
  const tbody = document.getElementById("devices-tbody");
  const statsEl = document.getElementById("devices-stats");

  try {
    const rows = await apiGet("/api/devices");
    if (!rows) return;

    if (statsEl) {
      const online = rows.filter(d => d.status === "online").length;
      const offline = rows.filter(d => d.status === "offline").length;
      const maintenance = rows.filter(d => d.status === "maintenance").length;

      statsEl.innerHTML = `
        <div class="stat-card safe"><div class="stat-header"><div class="stat-icon-wrap safe"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><span class="stat-badge safe">Online</span></div><div class="stat-value">${online}</div><div class="stat-label">Online Devices</div></div>
        <div class="stat-card danger"><div class="stat-header"><div class="stat-icon-wrap danger"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><span class="stat-badge danger">Offline</span></div><div class="stat-value">${offline}</div><div class="stat-label">Offline Devices</div></div>
        <div class="stat-card navy"><div class="stat-header"><div class="stat-icon-wrap navy"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/></svg></div><span class="stat-badge navy">Total</span></div><div class="stat-value">${rows.length}</div><div class="stat-label">Total Devices</div></div>
        <div class="stat-card warn"><div class="stat-header"><div class="stat-icon-wrap warn"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><span class="stat-badge warn">Pending</span></div><div class="stat-value">${maintenance}</div><div class="stat-label">In Maintenance</div></div>
      `;
    }

    if (!tbody) return;

    if (rows.length === 0) {
      tbody.innerHTML = emptyRow(6, "No devices registered yet.");
      return;
    }

    tbody.innerHTML = rows.map(d => `
      <tr>
        <td><strong>DEV-${String(d.device_id).padStart(3, '0')}</strong></td>
        <td style="font-family:monospace;font-size:12px">${d.esp32_uid || '—'}</td>
        <td>${d.building_name || '—'}</td>
        <td>${d.installed_date ? new Date(d.installed_date).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '—'}</td>
        <td>${timeAgo(d.last_reading_at)}</td>
        <td><span class="device-badge ${d.status}"><span class="device-badge-dot"></span>${d.status.charAt(0).toUpperCase() + d.status.slice(1)}</span></td>
      </tr>`).join("");
  } catch (err) {
    console.error("[AquaSense] loadDevices error:", err);
    if (tbody) tbody.innerHTML = emptyRow(6, "Unable to load devices.");
  }
}

// ════════════════════════════════════════════════════════════════════════
// LOCATIONS (used as "Monitored Buildings" preview on dashboard too)
// ════════════════════════════════════════════════════════════════════════
async function loadLocations(containerId = "locations-tbody", isPreview = false) {
  const el = document.getElementById(containerId);
  if (!el) return;

  try {
    const rows = await apiGet("/api/locations");
    if (!rows) return;

    if (rows.length === 0) {
      el.innerHTML = isPreview
        ? emptyPanelMessage("No locations configured yet.")
        : emptyRow(6, "No locations configured yet.");
      return;
    }

    if (isPreview) {
      el.innerHTML = rows.slice(0, 5).map((l, i) => `
        <div class="building-item">
          <div class="building-num">${String(i + 1).padStart(2, '0')}</div>
          <div class="building-info">
            <div class="building-name">${l.building_name || 'Unnamed'}</div>
            <div class="building-area">${l.area_name || '—'}</div>
          </div>
          <div class="building-status safe"><div class="b-dot safe"></div>${l.device_count} device${l.device_count == 1 ? '' : 's'}</div>
        </div>`).join("");
    } else {
      el.innerHTML = rows.map((l, i) => `
        <tr>
          <td>${String(i + 1).padStart(2, '0')}</td>
          <td><strong>${l.building_name || 'Unnamed'}</strong></td>
          <td>${l.area_name || '—'}</td>
          <td>${l.description || '—'}</td>
          <td>${l.device_count} device${l.device_count == 1 ? '' : 's'}</td>
          <td><span class="r-status ${l.device_count > 0 ? 'safe' : 'offline'}">${l.device_count > 0 ? 'Monitored' : 'No Devices'}</span></td>
        </tr>`).join("");
    }
  } catch (err) {
    console.error("[AquaSense] loadLocations error:", err);
  }
}

// ════════════════════════════════════════════════════════════════════════
// INIT — wire into navigate() and auto-refresh
// ════════════════════════════════════════════════════════════════════════
const viewLoaders = {
  dashboard: loadDashboard,
  live:      loadLiveMonitoring,
  readings:  loadSensorReadingsLog,
  alerts:    () => loadAlerts("all", "alerts-full-list"),
  devices:   loadDevices,
  locations: () => loadLocations("locations-tbody", false),
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

// Hook into existing navigate() — called after page load
document.addEventListener("DOMContentLoaded", () => {
  const originalNavigate = window.navigate;
  window.navigate = function(viewKey) {
    originalNavigate(viewKey);
    if (viewLoaders[viewKey]) viewLoaders[viewKey]();
    startAutoRefresh(viewKey);
  };

  // Initial load for dashboard (active view on page load)
  loadDashboard();
  startAutoRefresh("dashboard");

  // Manual refresh button
  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      const activeView = document.querySelector(".view.active");
      if (activeView) {
        const key = activeView.id.replace("view-", "");
        if (viewLoaders[key]) viewLoaders[key]();
      }
    });
  }
});