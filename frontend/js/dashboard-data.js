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
  if (res.status === 404) {
    try {
      const data = await res.clone().json();
      if (data && (data.message === "Account no longer exists." || data.message === "User not found.")) {
        if (typeof handleDeletedUser === "function") {
          handleDeletedUser();
        } else if (typeof logoutWithDeletedError === "function") {
          logoutWithDeletedError();
        } else {
          logout();
        }
        return null;
      }
    } catch (e) {}
  }
  if (res.status === 401 || res.status === 403) {
    logout();
    return null;
  }
  if (!res.ok) throw new Error(`Request failed: ${path} (${res.status})`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body)
  });
  if (res.status === 401 || res.status === 403) {
    logout();
    return null;
  }
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.message || `Request failed: ${path} (${res.status})`);
  }
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body)
  });
  if (res.status === 401 || res.status === 403) {
    logout();
    return null;
  }
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.message || `Request failed: ${path} (${res.status})`);
  }
  return res.json();
}

async function updateTopBarStatusPill() {
  const dot = document.getElementById("systemStatusDot");
  const text = document.getElementById("systemStatusText");
  if (!dot || !text) return;

  try {
    const devices = await apiGet("/api/devices");
    if (!devices || devices.length === 0) {
      dot.className = "status-dot offline";
      text.textContent = "Offline · 0 Connected";
      return;
    }

    const onlineDevices = devices.filter(d => d.status === "online");
    const onlineCount = onlineDevices.length;
    const totalCount = devices.length;

    if (onlineCount > 0) {
      dot.className = "status-dot live";
      text.textContent = `Online · ${onlineCount}/${totalCount} Connected`;
    } else {
      dot.className = "status-dot offline";
      text.textContent = `Offline · 0/${totalCount} Connected`;
    }
  } catch (err) {
    console.warn("[AquaSense] Could not update system status pill:", err);
  }
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
  if (r && r.classification && r.classification.water_status) {
    return r.classification.water_status;
  }
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

function statusLabel(s, r) {
  if (r && r.classification && r.classification.label) {
    return r.classification.label;
  }
  if (s === "danger" || s === "critical" || s === "unsafe") return "Warning"; // fallback or custom map
  if (s === "warn" || s === "warning")   return "Warning";
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
// ── HSU-Specific Dashboard Panel renderer ─────────────────────────────────────
function renderHsuDashboard(r) {
  const block = document.getElementById("hsu-dashboard-block");
  if (!block) return;

  if (!currentUserIsHsuOrAdmin()) {
    block.style.display = "none";
    return;
  }

  block.style.display = "block";

  if (!r || !r.classification) {
    document.getElementById("hsuScoreNum").textContent = "—";
    document.getElementById("hsuClassificationLabel").textContent = "—";
    document.getElementById("hsuAllowedUses").textContent = "No data";
    document.getElementById("hsuNotRecommendedUses").textContent = "No data";
    document.getElementById("hsuScoreExplanation").textContent = "No sensor data available.";
    document.getElementById("hsuDraggingParamsList").innerHTML = "";
    return;
  }

  const cls = r.classification;
  const score = cls.score ?? 0;
  const label = cls.label || "—";
  const color = cls.color || "var(--success)";
  const allowed = r.allowed_use || cls.recommended_use || "—";
  const notRec = cls.not_recommended || "—";
  const expl = cls.explanation || "—";

  // Circular gauge logic
  const circle = document.getElementById("hsuScoreCircle");
  if (circle) {
    const circumference = 289;
    const offset = circumference - (score / 100) * circumference;
    circle.style.strokeDashoffset = offset;
    circle.style.stroke = color;
  }

  document.getElementById("hsuScoreNum").textContent = score;
  
  const labelEl = document.getElementById("hsuClassificationLabel");
  if (labelEl) {
    labelEl.textContent = label;
    labelEl.style.color = color;
  }

  document.getElementById("hsuLastUpdated").textContent = `Reported: ${timeAgo(r.recorded_at)}`;
  document.getElementById("hsuAllowedUses").textContent = allowed;
  document.getElementById("hsuNotRecommendedUses").textContent = notRec;
  document.getElementById("hsuScoreExplanation").textContent = expl;

  // Render parameters dragging the score down
  const listEl = document.getElementById("hsuDraggingParamsList");
  if (listEl) {
    let html = "";
    let count = 0;
    if (cls.per_param) {
      for (const [key, param] of Object.entries(cls.per_param)) {
        if (param.level && param.level !== "safe") {
          count++;
          const name = key.toUpperCase();
          const val = param.value !== null && param.value !== undefined ? Number(param.value).toFixed(2) : "—";
          const unit = param.unit || "";
          const level = param.level ? param.level.toUpperCase() : "WARNING";

          let badgeColor = "var(--warn)";
          let badgeBg = "rgba(212,160,23,0.12)";
          if (param.level === "unsafe" || param.level === "danger") {
            badgeColor = "#EF4444";
            badgeBg = "rgba(239,68,68,0.12)";
          } else if (param.level === "critical") {
            badgeColor = "#7C3AED";
            badgeBg = "rgba(124,58,237,0.12)";
          }

          html += `
            <div style="display: flex; align-items: center; justify-content: space-between; background: var(--off-white); border: 1px solid var(--border); padding: 8px 12px; border-radius: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="width: 6px; height: 6px; border-radius: 50%; background: ${badgeColor};"></span>
                <span style="font-size: 12.5px; font-weight: 600; color: var(--text-dark);">${name}</span>
                <span style="font-size: 11.5px; color: var(--text-mid);">${val} ${unit}</span>
              </div>
              <span style="font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; padding: 2px 7px; border-radius: 12px; color: ${badgeColor}; background: ${badgeBg};">${level}</span>
            </div>`;
        }
      }
    }

    if (count === 0) {
      html = `
        <div style="display: flex; align-items: center; gap: 8px; background: rgba(61,214,140,0.06); border: 1px solid rgba(61,214,140,0.2); padding: 10px 14px; border-radius: 8px; color: #0F7050; font-size: 12px; font-weight: 500;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; stroke: #0F7050;"><polyline points="20 6 9 17 4 12"/></svg>
          All parameters are within optimal PNSDW limits.
        </div>`;
    }
    listEl.innerHTML = html;
  }
}

async function populateDeviceDropdowns() {
  const dashboardSel = document.getElementById("dashboardFilterDevice");
  const liveSel = document.getElementById("liveFilterDevice");
  const complianceSel = document.getElementById("complianceFilterDevice");

  // Check if we need to load devices
  if ((dashboardSel && dashboardSel.children.length <= 1) ||
      (liveSel && liveSel.children.length <= 1) ||
      (complianceSel && complianceSel.children.length <= 1)) {
    try {
      const devices = await apiGet("/api/devices");
      if (devices) {
        // Clear except first option
        if (dashboardSel) dashboardSel.innerHTML = '<option value="">All Devices (Latest)</option>';
        if (liveSel) liveSel.innerHTML = '<option value="">All Devices (Latest)</option>';
        if (complianceSel) complianceSel.innerHTML = '<option value="">All Devices (Average)</option>';

        const onlineDevices = devices.filter(d => d.status === "online");
        onlineDevices.forEach(d => {
          const optText = `${d.device_name} (ID: ${d.device_id})`;
          
          if (dashboardSel) {
            const opt = document.createElement("option");
            opt.value = d.device_id;
            opt.textContent = optText;
            dashboardSel.appendChild(opt);
          }
          if (liveSel) {
            const opt = document.createElement("option");
            opt.value = d.device_id;
            opt.textContent = optText;
            liveSel.appendChild(opt);
          }
          if (complianceSel) {
            const opt = document.createElement("option");
            opt.value = d.device_id;
            opt.textContent = optText;
            complianceSel.appendChild(opt);
          }
        });
      }
    } catch (err) {
      console.warn("[AquaSense] Failed to populate device dropdowns:", err);
    }
  }
}

window.loadDashboardFiltered = async function() {
  const sel = document.getElementById("dashboardFilterDevice");
  const deviceId = sel ? sel.value : "";

  try {
    const summary = await apiGet("/api/dashboard/summary");
    if (!summary) return;

    buildThresholdMap(summary.thresholds);

    if (deviceId) {
      // Fetch latest reading for this specific device
      const latestReadings = await apiGet("/api/sensors/latest");
      const deviceReading = latestReadings ? latestReadings.find(r => String(r.device_id) === String(deviceId)) : null;

      // Update the dashboard summary with this device's reading
      summary.latestReading = deviceReading || null;
    }

    renderDashboardStats(summary);
    renderLiveParams(summary.latestReading, "dashboard-params");
    renderHsuDashboard(summary.latestReading);
  } catch (err) {
    console.error("[AquaSense] loadDashboardFiltered error:", err);
  }
};

async function loadDashboard() {
  await populateDeviceDropdowns();
  await loadDashboardFiltered();

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
    if (!rows) return;

    let userId = "default";
    try {
      const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
      if (raw) {
        const user = JSON.parse(raw);
        userId = user.id || user.user_id || "default";
      }
    } catch(e) {}
    
    let readAlerts = [];
    try {
      const readRaw = localStorage.getItem(`read_alerts_${userId}`);
      if (readRaw) readAlerts = JSON.parse(readRaw);
    } catch(e) {}

    const unreadCount = rows.filter(a => !readAlerts.includes(a.id)).length;
    updateAlertBadges(rows.length, unreadCount);
  } catch (err) {
    console.error("[AquaSense] refreshAlertBadgeCounts error:", err);
  }
}

function updateAlertBadges(count, unreadCount = null) {
  const displayUnread = unreadCount !== null ? unreadCount : count;

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

  const notifDot = document.getElementById("topbarNotifDot");
  if (notifDot) {
    notifDot.style.display = displayUnread > 0 ? "block" : "none";
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
        : `<span class="r-status ${status}">${statusLabel(status, r)}</span>`;

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
window.loadLiveMonitoringFiltered = async function() {
  const sel = document.getElementById("liveFilterDevice");
  const deviceId = sel ? sel.value : "";

  try {
    const summary = await apiGet("/api/dashboard/summary");
    if (!summary) return;

    buildThresholdMap(summary.thresholds);

    let targetReading = summary.latestReading;

    if (deviceId) {
      // Fetch latest reading for this specific device
      const latestReadings = await apiGet("/api/sensors/latest");
      targetReading = latestReadings ? latestReadings.find(r => String(r.device_id) === String(deviceId)) : null;
    }

    renderLiveStats(targetReading);
    renderLiveParams(targetReading, "live-params");
  } catch (err) {
    console.error("[AquaSense] loadLiveMonitoringFiltered error:", err);
  }
};

async function loadLiveMonitoring() {
  await populateDeviceDropdowns();
  await loadLiveMonitoringFiltered();
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
window.readingsCurrentPage = 1;

window.readingsNextPage = function() {
  window.readingsCurrentPage = (window.readingsCurrentPage || 1) + 1;
  loadSensorReadingsLog();
};

window.readingsPrevPage = function() {
  const currentPage = window.readingsCurrentPage || 1;
  if (currentPage > 1) {
    window.readingsCurrentPage = currentPage - 1;
    loadSensorReadingsLog();
  }
};

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
  const currentPage = window.readingsCurrentPage || 1;
  params.set("limit", "50");
  params.set("page", currentPage.toString());
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

    // Update pagination controls
    const pagination = result.pagination || { page: 1, limit: 50, total: rows.length, totalPages: 1 };
    
    const totalCountEl = document.getElementById("readingsTotalCount");
    const pageNumEl = document.getElementById("readingsPageNum");
    const pageStartEl = document.getElementById("readingsPageStart");
    const pageEndEl = document.getElementById("readingsPageEnd");
    const prevBtn = document.getElementById("readingsPrevBtn");
    const nextBtn = document.getElementById("readingsNextBtn");

    if (totalCountEl) totalCountEl.textContent = pagination.total;
    if (pageNumEl) pageNumEl.textContent = `Page ${pagination.page} of ${pagination.totalPages || 1}`;
    if (pageStartEl) pageStartEl.textContent = pagination.total > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
    if (pageEndEl) pageEndEl.textContent = Math.min(pagination.page * pagination.limit, pagination.total);

    if (prevBtn) prevBtn.disabled = (pagination.page <= 1);
    if (nextBtn) nextBtn.disabled = (pagination.page >= pagination.totalPages || pagination.totalPages === 0);

    const colCount = isAdmin ? 11 : 10;

    if (rows.length === 0) {
      tbody.innerHTML = emptyRow(colCount, "No sensor readings match your filters.");
      return;
    }

    window.lastLoadedReadings = rows;

    tbody.innerHTML = rows.map((r, index) => {
      const status = overallStatus(r);
      const checkboxCell = isAdmin
        ? `<td class="row-checkbox-cell"><input type="checkbox" class="reading-row-checkbox" value="${r.id}"/></td>`
        : "";

      return `<tr class="reading-clickable-row" data-index="${index}" style="cursor: pointer;">
        ${checkboxCell}
        <td>#${r.id}</td>
        <td><strong>${r.device_id}</strong> / ${r.building_name || "—"}</td>
        <td>${fmt(r.ph_level)}</td>
        <td>${fmt(r.turbidity)} NTU</td>
        <td>${fmt(r.tds, 0)} ppm</td>
        <td>${fmt(r.temperature)}°C</td>
        <td>${fmt(r.ammonia, 2)} mg/L</td>
        <td>${fmt(r.flow_rate)} L/m</td>
        <td><span class="r-status ${status}">${statusLabel(status, r)}</span></td>
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

window.exportReadingsToCsv = async function() {
  const filters = (typeof readingsActiveFilters !== "undefined") ? readingsActiveFilters : {};
  const params = new URLSearchParams();
  if (filters.device_id) params.set("device_id", filters.device_id);
  if (filters.range)     params.set("range", filters.range);

  try {
    const rows = await apiGet(`/api/sensors/export?${params.toString()}`);
    if (!rows) return;

    let filteredRows = rows;
    if (filters.status) {
      filteredRows = rows.filter(r => overallStatus(r) === filters.status);
    }

    if (filteredRows.length === 0) {
      alert("No data available to export matching the current filters.");
      return;
    }

    const headers = [
      "Reading ID",
      "Device Name",
      "Building",
      "pH Level",
      "Turbidity (NTU)",
      "TDS (ppm)",
      "Temperature (°C)",
      "Ammonia (mg/L)",
      "Flow Rate (L/min)",
      "Water Consumed (L)",
      "Safety Score",
      "Classification",
      "Allowed Use",
      "Recorded At"
    ];

    const csvRows = [headers.join(",")];

    filteredRows.forEach(r => {
      const line = [
        r.id,
        `"${(r.device_name || r.device_id || '').replace(/"/g, '""')}"`,
        `"${(r.building_name || '—').replace(/"/g, '""')}"`,
        r.ph_level ?? "",
        r.turbidity ?? "",
        r.tds ?? "",
        r.temperature ?? "",
        r.ammonia ?? "",
        r.flow_rate ?? "",
        r.water_consumed ?? "",
        r.score ?? "",
        r.safety_classification || "",
        `"${(r.allowed_use || "").replace(/"/g, '""')}"`,
        r.recorded_at ? new Date(r.recorded_at).toLocaleString() : ""
      ];
      csvRows.push(line.join(","));
    });

    const csvString = csvRows.join("\n");
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `aquasense_readings_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    console.error("Failed to export CSV:", err);
    alert("An error occurred while exporting the data to CSV.");
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ALERTS VIEW  ← NOW FULLY CONNECTED TO DATABASE
// ═════════════════════════════════════════════════════════════════════════════

window.alertsCurrentPage = 1;

window.alertsNextPage = function() {
  window.alertsCurrentPage = (window.alertsCurrentPage || 1) + 1;
  loadAlertsView();
};

window.alertsPrevPage = function() {
  const currentPage = window.alertsCurrentPage || 1;
  if (currentPage > 1) {
    window.alertsCurrentPage = currentPage - 1;
    loadAlertsView();
  }
};

// loadAlerts: shared helper used by dashboard preview + full alerts view
async function loadAlerts(status = "all", containerId = "alerts-full-list", isPreview = false) {
  const el = document.getElementById(containerId);
  if (!el) return;

  try {
    const apiStatus  = status === "active" ? "unresolved" : status;
    let rows = [];
    let pagination = null;

    if (isPreview) {
      rows = await apiGet(`/api/alerts?status=${apiStatus}&limit=5`);
    } else {
      const page = window.alertsCurrentPage || 1;
      const result = await apiGet(`/api/alerts?status=${apiStatus}&limit=7&page=${page}`);
      if (result && result.data) {
        rows = result.data;
        pagination = result.pagination;
      } else {
        rows = result || [];
      }
    }

    if (!rows) return;

    if (currentUserIsHsu()) {
      rows = rows.filter(a => a.parameter && ["ph", "turbidity", "ammonia"].includes(a.parameter.toLowerCase()));
    }

    if (!isPreview) {
      const totalCountEl = document.getElementById("alertsTotalCount");
      const pageNumEl = document.getElementById("alertsPageNum");
      const pageStartEl = document.getElementById("alertsPageStart");
      const pageEndEl = document.getElementById("alertsPageEnd");
      const prevBtn = document.getElementById("alertsPrevBtn");
      const nextBtn = document.getElementById("alertsNextBtn");
      const pagContainer = document.getElementById("alertsPaginationContainer");

      if (pagination) {
        if (pagContainer) pagContainer.style.display = "flex";
        if (totalCountEl) totalCountEl.textContent = pagination.total;
        if (pageNumEl) pageNumEl.textContent = `Page ${pagination.page} of ${pagination.totalPages || 1}`;
        if (pageStartEl) pageStartEl.textContent = pagination.total > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
        if (pageEndEl) pageEndEl.textContent = Math.min(pagination.page * pagination.limit, pagination.total);

        if (prevBtn) prevBtn.disabled = (pagination.page <= 1);
        if (nextBtn) nextBtn.disabled = (pagination.page >= pagination.totalPages || pagination.totalPages === 0);
      } else {
        if (pagContainer) pagContainer.style.display = "none";
      }
    }

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

      const alertId = a.alert_id ?? a.id;
      
      const checkbox = (!isPreview && isAdmin && alertId != null) ? `
        <input type="checkbox" class="alert-row-checkbox" value="${alertId}" style="margin-right: 12px; width: 16px; height: 16px; accent-color: var(--navy); cursor: pointer;" />
      ` : "";

      const deleteBtn = (!isPreview && isAdmin && alertId != null) ? `
            <button class="alert-delete-btn delete-alert-btn" data-id="${alertId}" data-name="${escapeHtml(a.message || a.parameter || 'Alert')}" title="Delete alert" aria-label="Delete alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>` : "";

      return `
        <div class="alert-item" ${isResolved ? 'style="opacity:.55;"' : ""} style="display: flex; align-items: center;">
          ${checkbox}
          <div class="alert-dot-wrap ${dotClass}">${alertIcon}</div>
          <div class="alert-info" style="margin-left: 10px;">
            <div class="alert-title">${a.message || a.parameter || "Alert"}</div>
            <div class="alert-meta">${a.building_name || a.device_id || "—"}${paramInfo} · ${timeAgo(a.created_at)}${isResolved ? " · Resolved" : ""}</div>
          </div>
          ${isResolved
            ? `<span class="alert-level resolved">Resolved</span>`
            : `<span class="alert-level ${level}">${a.level ? a.level.charAt(0).toUpperCase() + a.level.slice(1) : "Alert"}</span>`
          }${deleteBtn}
        </div>`;
    }).join("");

    if (!isPreview) {
      if (typeof window.updateAlertsSelection === "function") {
        window.updateAlertsSelection();
      } else if (typeof updateAlertsSelection === "function") {
        updateAlertsSelection();
      }
    }
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

    let allFiltered = allAlerts;
    let unresolvedFiltered = unresolvedAlerts || [];

    if (currentUserIsHsu()) {
      const isHsuAlert = a => a.parameter && ["ph", "turbidity", "ammonia"].includes(a.parameter.toLowerCase());
      allFiltered = allAlerts.filter(isHsuAlert);
      unresolvedFiltered = unresolvedFiltered.filter(isHsuAlert);
    }

    const total      = allFiltered.length;
    const unresolved = unresolvedFiltered.length;
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

    // ── Show/hide Select All checkbox ─────────────────────────────────────
    const isAdmin = currentUserIsAdmin();
    const selectAllEl = document.getElementById("alertsSelectAll");
    if (selectAllEl) {
      selectAllEl.style.display = isAdmin ? "inline-block" : "none";
    }

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
    <line x1="${leftPad}" y1="${yPositions[i]}" x2="${svgW - 5}" y2="${yPositions[i]}" stroke="var(--border, #DDE3EE)" stroke-width="1.2" stroke-dasharray="4,4"/>
    <text x="${leftPad - 5}" y="${yPositions[i] + 4}" font-size="10" fill="var(--text-light, #8292B0)" text-anchor="end">${val}L</text>
  `).join("");

  const baseLine = `<line x1="${leftPad}" y1="${20 + chartH}" x2="${svgW - 5}" y2="${20 + chartH}" stroke="var(--border, #DDE3EE)" stroke-width="1.5" stroke-linecap="round"/>`;

  // Compute 2D coordinate points for the line graph
  const coords = dailyTotals.map((d, i) => {
    const x = leftPad + i * slotW + slotW / 2;
    const val = Number(d.consumed) || 0;
    const y = 20 + chartH - (val / maxVal) * chartH;
    const dayName = d.day_name ? d.day_name.slice(0, 3) : `D${i + 1}`;
    return { x, y, val, dayName };
  });

  const polyPoints = coords.map(c => `${c.x},${c.y}`).join(" ");
  const areaPath = `M ${coords[0].x},${20 + chartH} ` + coords.map(c => `L ${c.x},${c.y}`).join(" ") + ` L ${coords[coords.length - 1].x},${20 + chartH} Z`;

  const dots = coords.map(c => `
    <circle cx="${c.x}" cy="${c.y}" r="5" fill="#FFFFFF" stroke="var(--water-2, #2C9AD1)" stroke-width="3" />
    ${c.val > 0 ? `<text x="${c.x}" y="${c.y - 10}" font-size="9" fill="var(--text-mid, #4A5878)" text-anchor="middle" font-weight="600">${Math.round(c.val)}L</text>` : ""}
    <text x="${c.x}" y="${svgH - 25}" font-size="10" fill="var(--text-light, #8292B0)" text-anchor="middle">${c.dayName}</text>
  `).join("");

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;height:${svgH}px;overflow:visible;">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2C9AD1" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#1A6FA8" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      ${baseLine}
      <path d="${areaPath}" fill="url(#areaGrad)" />
      <polyline fill="none" stroke="var(--water-2, #2C9AD1)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${polyPoints}" />
      ${dots}
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
// COMPLIANCE TREND VIEW
// ═════════════════════════════════════════════════════════════════════════════
window.loadComplianceTrendData = async function() {
  const sel = document.getElementById("complianceFilterDevice");
  const deviceId = sel ? sel.value : "";
  
  try {
    const data = await apiGet(`/api/analytics/compliance-trend?device_id=${deviceId}`);
    if (!data) return;

    renderComplianceCharts(data);
  } catch (err) {
    console.error("[AquaSense] loadComplianceTrendData error:", err);
  }
};

async function loadComplianceTrend() {
  const sel = document.getElementById("complianceFilterDevice");
  if (sel && sel.children.length <= 1) {
    try {
      const devices = await apiGet("/api/devices");
      if (devices) {
        devices.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.device_id;
          opt.textContent = `${d.device_name} (ID: ${d.device_id})`;
          sel.appendChild(opt);
        });
      }
    } catch (err) {
      console.warn("[AquaSense] Error loading devices for compliance dropdown:", err);
    }
  }

  await window.loadComplianceTrendData();
}

function renderComplianceCharts(data) {
  // 1. pH
  const refPh = [
    { val: 6.5, label: "PNSDW Min (6.5)", color: "#DC2626" },
    { val: 8.5, label: "PNSDW Max (8.5)", color: "#DC2626" }
  ];
  drawComplianceChart("phComplianceChart", data, "avg_ph", 5.5, 9.5, refPh, "");

  // 2. Turbidity
  const refTurb = [
    { val: 5.0, label: "PNSDW Max (5.0 NTU)", color: "#DC2626" }
  ];
  drawComplianceChart("turbidityComplianceChart", data, "avg_turbidity", 0.0, 10.0, refTurb, " NTU");

  // 3. Ammonia
  const refAmm = [
    { val: 0.5, label: "PNSDW Max (0.5 mg/L)", color: "#DC2626" }
  ];
  drawComplianceChart("ammoniaComplianceChart", data, "avg_ammonia", 0.0, 1.5, refAmm, " mg/L");

  // Evaluate latest status badges
  const latest = data[data.length - 1] || {};
  
  // pH status
  const phStatusText = document.getElementById("phComplianceStatus");
  if (phStatusText) {
    if (latest.avg_ph === null) {
      phStatusText.className = "device-badge offline";
      phStatusText.innerHTML = `<span class="device-badge-dot"></span>No Data`;
    } else if (latest.avg_ph >= 6.5 && latest.avg_ph <= 8.5) {
      phStatusText.className = "device-badge online";
      phStatusText.innerHTML = `<span class="device-badge-dot" style="background:#3DD68C;"></span>Normal`;
    } else {
      phStatusText.className = "device-badge offline";
      phStatusText.innerHTML = `<span class="device-badge-dot" style="background:#EF4444;"></span>Out of Range`;
    }
  }

  // Turbidity status
  const turbStatusText = document.getElementById("turbidityComplianceStatus");
  if (turbStatusText) {
    if (latest.avg_turbidity === null) {
      turbStatusText.className = "device-badge offline";
      turbStatusText.innerHTML = `<span class="device-badge-dot"></span>No Data`;
    } else if (latest.avg_turbidity <= 5.0) {
      turbStatusText.className = "device-badge online";
      turbStatusText.innerHTML = `<span class="device-badge-dot" style="background:#3DD68C;"></span>Normal`;
    } else {
      turbStatusText.className = "device-badge offline";
      turbStatusText.innerHTML = `<span class="device-badge-dot" style="background:#EF4444;"></span>High Turbidity`;
    }
  }

  // Ammonia status
  const ammStatusText = document.getElementById("ammoniaComplianceStatus");
  if (ammStatusText) {
    if (latest.avg_ammonia === null) {
      ammStatusText.className = "device-badge offline";
      ammStatusText.innerHTML = `<span class="device-badge-dot"></span>No Data`;
    } else if (latest.avg_ammonia <= 0.5) {
      ammStatusText.className = "device-badge online";
      ammStatusText.innerHTML = `<span class="device-badge-dot" style="background:#3DD68C;"></span>Normal`;
    } else {
      ammStatusText.className = "device-badge offline";
      ammStatusText.innerHTML = `<span class="device-badge-dot" style="background:#EF4444;"></span>High Ammonia`;
    }
  }
}

function drawComplianceChart(containerId, data, key, yMin, yMax, refLines, unit) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = emptyPanel("No compliance data available.");
    return;
  }

  const svgW = 600;
  const svgH = 160;
  const chartH = 110;
  const leftPad = 50;
  const rightPad = 20;
  const topPad = 20;
  const slotW = (svgW - leftPad - rightPad) / Math.max(data.length - 1, 1);

  // Y-axis labels
  const steps = 4;
  let yLabels = [];
  for (let i = 0; i <= steps; i++) {
    const val = yMin + ((yMax - yMin) / steps) * i;
    yLabels.push(val);
  }

  // Draw grid lines
  let gridLines = yLabels.map(val => {
    const y = topPad + chartH - ((val - yMin) / (yMax - yMin)) * chartH;
    return `
      <line x1="${leftPad}" y1="${y}" x2="${svgW - rightPad}" y2="${y}" stroke="var(--border, #DDE3EE)" stroke-width="1.2" stroke-dasharray="4,4"/>
      <text x="${leftPad - 8}" y="${y + 4}" font-size="9.5" fill="var(--text-light, #8292B0)" text-anchor="end">${val.toFixed(1)}${unit}</text>
    `;
  }).join("");

  // Draw reference standard threshold lines
  let refLinesHtml = (refLines || []).map(line => {
    const y = topPad + chartH - ((line.val - yMin) / (yMax - yMin)) * chartH;
    if (y < topPad || y > topPad + chartH) return "";
    return `
      <line x1="${leftPad}" y1="${y}" x2="${svgW - rightPad}" y2="${y}" stroke="${line.color || '#EF4444'}" stroke-width="1.8" stroke-dasharray="6,4" opacity="0.85"/>
      <text x="${svgW - rightPad - 4}" y="${y - 4}" font-size="9" fill="${line.color || '#EF4444'}" font-weight="700" text-anchor="end">${line.label}</text>
    `;
  }).join("");

  // Base X axis line
  const baseLine = `<line x1="${leftPad}" y1="${topPad + chartH}" x2="${svgW - rightPad}" y2="${topPad + chartH}" stroke="var(--border, #DDE3EE)" stroke-width="1.5" stroke-linecap="round"/>`;

  // Compute coordinates for data
  const coords = data.map((d, i) => {
    const x = leftPad + i * slotW;
    const rawVal = d[key];
    const val = rawVal !== null && rawVal !== undefined ? rawVal : null;
    const y = val !== null ? (topPad + chartH - ((val - yMin) / (yMax - yMin)) * chartH) : null;
    const dayName = d.day_name ? d.day_name.slice(0, 3) : `D${i + 1}`;
    return { x, y, val, dayName };
  });

  const validCoords = coords.filter(c => c.y !== null);

  let pathHtml = "";
  let dotsHtml = "";
  if (validCoords.length > 0) {
    const polyPoints = validCoords.map(c => `${c.x},${c.y}`).join(" ");
    const areaPath = `M ${validCoords[0].x},${topPad + chartH} ` + validCoords.map(c => `L ${c.x},${c.y}`).join(" ") + ` L ${validCoords[validCoords.length - 1].x},${topPad + chartH} Z`;
    
    pathHtml = `
      <path d="${areaPath}" fill="url(#complianceGrad_${containerId})" />
      <polyline fill="none" stroke="var(--water-2, #2C9AD1)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${polyPoints}" />
    `;

    dotsHtml = coords.map(c => {
      if (c.y === null) return `
        <text x="${c.x}" y="${topPad + chartH - 20}" font-size="9.5" fill="var(--text-light)" text-anchor="middle" font-style="italic">No data</text>
        <text x="${c.x}" y="${svgH - 12}" font-size="9.5" fill="var(--text-light, #8292B0)" text-anchor="middle">${c.dayName}</text>
      `;
      return `
        <circle cx="${c.x}" cy="${c.y}" r="4" fill="#FFFFFF" stroke="var(--water-2, #2C9AD1)" stroke-width="2" />
        <text x="${c.x}" y="${c.y - 8}" font-size="9" fill="var(--text-dark, #0D1B3E)" font-weight="600" text-anchor="middle">${c.val.toFixed(2)}</text>
        <text x="${c.x}" y="${svgH - 12}" font-size="9.5" fill="var(--text-light, #8292B0)" text-anchor="middle">${c.dayName}</text>
      `;
    }).join("");
  } else {
    pathHtml = `<text x="${svgW / 2}" y="${svgH / 2}" font-size="13" fill="var(--text-light)" text-anchor="middle">No readings recorded in the last 7 days</text>`;
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%; height:${svgH}px; overflow:visible;">
      <defs>
        <linearGradient id="complianceGrad_${containerId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2C9AD1" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#1A6FA8" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      ${refLinesHtml}
      ${baseLine}
      ${pathHtml}
      ${dotsHtml}
    </svg>
  `;
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

function currentUserIsGsu() {
  try {
    const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
    if (!raw) return false;
    const user = JSON.parse(raw);
    return (user.role || "").toLowerCase() === "gsu";
  } catch (e) {
    return false;
  }
}

function currentUserIsGsuOrAdmin() {
  try {
    const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
    if (!raw) return false;
    const user = JSON.parse(raw);
    const role = (user.role || "").toLowerCase();
    return role === "gsu" || role === "admin";
  } catch (e) {
    return false;
  }
}

function currentUserIsHsu() {
  try {
    const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
    if (!raw) return false;
    const user = JSON.parse(raw);
    return (user.role || "").toLowerCase() === "hsu";
  } catch (e) {
    return false;
  }
}

function currentUserIsHsuOrAdmin() {
  try {
    const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
    if (!raw) return false;
    const user = JSON.parse(raw);
    const role = (user.role || "").toLowerCase();
    return role === "hsu" || role === "admin";
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

  try {
    const filters = (typeof maintActiveFilters !== "undefined") ? maintActiveFilters : {};

    const params = new URLSearchParams();
    if (filters.search)    params.set("search", filters.search);
    if (filters.device_id) params.set("device_id", filters.device_id);
    if (filters.range)     params.set("range", filters.range);

    const queryString = params.toString() ? `?${params.toString()}` : "";
    const logs = await apiGet(`/api/maintenance${queryString}`);
    if (!logs) return;

    window.lastLoadedMaintenanceLogs = logs;

    const isFiltered = !!(filters.search || filters.device_id || filters.range);
    if (logs.length === 0) {
      el.innerHTML = emptyPanel(isFiltered ? "No maintenance logs match the selected filters." : "No maintenance records logged yet.");
      return;
    }

    el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Device</th>
            <th>Location</th>
            <th>Title</th>
            <th>Details</th>
            <th>Tags</th>
            <th>Repaired By</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(log => {
            const dateStr = log.logged_date ? new Date(log.logged_date).toLocaleDateString() : "—";
            const tagsHtml = log.tags
              ? log.tags.split(",").map(t => `<span class="device-badge" style="background:rgba(44,154,209,0.1);color:#1A6FA8;margin:2px;font-size:10px;">${escapeHtml(t.trim())}</span>`).join("")
              : "—";
            const locationText = log.building_name ? `${log.building_name} (${log.area_name || 'General'})` : "—";

            return `
              <tr class="maintenance-clickable-row" data-log-id="${log.id}" style="cursor: pointer;">
                <td>${dateStr}</td>
                <td><strong>${escapeHtml(log.device_name || 'Unknown')}</strong> <span style="font-size:10px;color:var(--text-mid);">ID: ${log.device_id}</span></td>
                <td>${escapeHtml(locationText)}</td>
                <td><strong>${escapeHtml(log.title)}</strong></td>
                <td><span style="font-size:12px;color:var(--text-mid);">${escapeHtml(log.detail || '—')}</span></td>
                <td><div style="display:flex;flex-wrap:wrap;gap:4px;">${tagsHtml}</div></td>
                <td><span style="font-weight:600;">${escapeHtml(log.repaired_by || '—')}</span></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    console.error("[AquaSense] loadMaintenanceLogs error:", err);
    el.innerHTML = emptyPanel("Failed to load maintenance logs.");
  }
}

async function openAddMaintModal() {
  const modal = document.getElementById("addMaintenanceModal");
  if (!modal) return;

  // Clear previous form fields
  document.getElementById("maintTitle").value = "";
  document.getElementById("maintDetail").value = "";
  document.getElementById("maintTags").value = "";
  
  // Set default repaired_by to current user's name
  let defaultOperator = "";
  try {
    const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
    if (raw) {
      const user = JSON.parse(raw);
      defaultOperator = user.fullname || "";
    }
  } catch (e) {}
  document.getElementById("maintRepairedBy").value = defaultOperator;

  // Set default date to today
  document.getElementById("maintDate").value = new Date().toISOString().slice(0, 10);

  // Clear error
  const errDiv = document.getElementById("maintModalError");
  if (errDiv) errDiv.style.display = "none";

  // Populate devices dropdown
  const select = document.getElementById("maintDeviceId");
  if (select) {
    select.innerHTML = '<option value="" disabled selected>Select a device…</option>';
    try {
      const devices = await apiGet("/api/devices");
      if (devices && devices.length > 0) {
        devices.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.device_id;
          opt.textContent = `${d.device_name} (${d.building_name || 'No Location'})`;
          select.appendChild(opt);
        });
      }
    } catch (err) {
      console.error("Failed to populate devices in maintenance modal", err);
    }
  }

  modal.style.display = "flex";
}

function closeAddMaintModal() {
  const modal = document.getElementById("addMaintenanceModal");
  if (modal) modal.style.display = "none";
}

function handleMaintModalBackdrop(event) {
  if (event.target === event.currentTarget) {
    closeAddMaintModal();
  }
}

async function submitAddMaint() {
  const deviceId = document.getElementById("maintDeviceId").value;
  const title = document.getElementById("maintTitle").value;
  const detail = document.getElementById("maintDetail").value;
  const tags = document.getElementById("maintTags").value;
  const repairedBy = document.getElementById("maintRepairedBy").value;
  const loggedDate = document.getElementById("maintDate").value;

  const errDiv = document.getElementById("maintModalError");
  const errText = document.getElementById("maintModalErrorText");

  if (!deviceId) {
    if (errDiv && errText) {
      errText.textContent = "Please select a target device.";
      errDiv.style.display = "flex";
    }
    return;
  }
  if (!title || !title.trim()) {
    if (errDiv && errText) {
      errText.textContent = "Please enter a log title.";
      errDiv.style.display = "flex";
    }
    return;
  }

  try {
    const payload = {
      device_id: Number(deviceId),
      title: title.trim(),
      detail: detail.trim(),
      tags: tags.trim(),
      repaired_by: repairedBy.trim(),
      logged_date: loggedDate || null
    };

    const res = await apiPost("/api/maintenance", payload);
    if (res) {
      closeAddMaintModal();
      // Reload the maintenance logs view to reflect changes
      loadMaintenanceLogs();
    }
  } catch (err) {
    console.error("submitAddMaint error:", err);
    if (errDiv && errText) {
      errText.textContent = err.message || "Failed to submit maintenance log.";
      errDiv.style.display = "flex";
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FLOW RATE ANOMALIES VIEW (GSU ONLY)
// ═════════════════════════════════════════════════════════════════════════════
async function loadFlowAnomalies() {
  const el = document.getElementById("flow-anomalies-list");
  if (!el) return;

  try {
    const devices = await apiGet("/api/devices");
    const readingsResp = await apiGet("/api/sensors?limit=150");

    if (!devices || !readingsResp) return;
    const readings = Array.isArray(readingsResp) ? readingsResp : (readingsResp.data || []);

    if (devices.length === 0) {
      el.innerHTML = emptyPanel("No registered devices to monitor flow rate.");
      return;
    }

    el.innerHTML = devices.map(dev => {
      const devReadings = readings
        .filter(r => r.device_id === dev.device_id)
        .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));

      if (devReadings.length === 0) {
        return `
          <div class="stat-card info">
            <div class="stat-header">
              <span class="stat-label"><strong>${escapeHtml(dev.device_name)}</strong></span>
              <span class="stat-badge info">No Data</span>
            </div>
            <div style="font-size: 13px; color: var(--text-mid); margin-top: 8px;">
              No flow rate readings recorded yet.
            </div>
          </div>
        `;
      }

      const latestReading = devReadings[devReadings.length - 1];
      const currentFlow = Number(latestReading.flow_rate) || 0;

      const flowHistory = devReadings.map(r => Number(r.flow_rate) || 0).slice(-15);
      const previousReadings = flowHistory.slice(0, -1);
      const avgFlow = previousReadings.length > 0
        ? previousReadings.reduce((sum, val) => sum + val, 0) / previousReadings.length
        : currentFlow;

      let statusText = "Normal";
      let statusClass = "safe";
      if (avgFlow > 1.0) {
        if (currentFlow > avgFlow * 1.5) {
          statusText = "Spike (Leak)";
          statusClass = "danger";
        } else if (currentFlow < avgFlow * 0.5 && currentFlow < 2.0) {
          statusText = "Drop (Blockage)";
          statusClass = "warn";
        }
      }

      const sparklineHtml = generateSparkline(flowHistory, 160, 40);
      const buildingInfo = dev.building_name
        ? `${dev.building_name} — ${dev.area_name || 'General'}`
        : "Unassigned building";

      return `
        <div class="stat-card ${statusClass}" style="display:flex;flex-direction:column;justify-content:space-between;padding:16px;min-height:160px;cursor:pointer;" onclick="showFlowAnomalyDetails('${encodeURIComponent(JSON.stringify(dev))}', ${currentFlow}, ${avgFlow}, '${statusText}', '${statusClass}')">
          <div>
            <div class="stat-header" style="margin-bottom:8px;">
              <div>
                <strong style="font-size:15px;color:var(--text);">${escapeHtml(dev.device_name)}</strong>
                <div style="font-size:11px;color:var(--text-mid);margin-top:2px;">${escapeHtml(buildingInfo)}</div>
              </div>
              <span class="stat-badge ${statusClass}">${statusText}</span>
            </div>
            
            <div style="display:flex;align-items:baseline;gap:6px;margin:12px 0;">
              <span style="font-size:24px;font-weight:700;color:var(--text);">${currentFlow.toFixed(1)}</span>
              <span style="font-size:12px;color:var(--text-mid);">L/min</span>
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(0,0,0,0.05);padding-top:10px;margin-top:auto;">
            <div style="font-size:11px;color:var(--text-mid);">
              Avg: ${avgFlow.toFixed(1)} L/min
            </div>
            <div style="display:flex;align-items:center;">
              ${sparklineHtml}
            </div>
          </div>
        </div>
      `;
    }).join("");

  } catch (err) {
    console.error("[AquaSense] loadFlowAnomalies error:", err);
    el.innerHTML = emptyPanel("Error loading flow rate anomaly data.");
  }
}

function generateSparkline(values, width = 120, height = 30) {
  if (!values || values.length < 2) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const points = values.map((val, idx) => {
    const x = (idx / (values.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');
  return `
    <svg width="${width}" height="${height}" style="overflow:visible;">
      <polyline fill="none" stroke="var(--water-1)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
    </svg>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// DEVICE HEALTH TRACKER VIEW (GSU ONLY)
// ═════════════════════════════════════════════════════════════════════════════
async function loadDevicesHealthTracker() {
  const tbody = document.getElementById("health-tracker-tbody");
  if (!tbody) return;

  try {
    const devices = await apiGet("/api/devices/health");
    if (!devices) return;

    window.lastLoadedDevicesHealth = devices;

    if (devices.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No devices found.</td></tr>`;
      return;
    }

    tbody.innerHTML = devices.map(d => {
      const isOnline = d.status === "online";
      const statusBadge = `<span class="r-status ${isOnline ? "safe" : "offline"}">${d.status.toUpperCase()}</span>`;
      const lastOnlineDate = d.last_online ? new Date(d.last_online).toLocaleString() : "Never";
      
      const uptimeVal = d.uptime_percent != null ? d.uptime_percent : 100;
      const uptimeClass = uptimeVal >= 90 ? "safe" : uptimeVal >= 75 ? "warn" : "offline";
      const uptimeBadge = `<span class="r-status ${uptimeClass}">${uptimeVal}%</span>`;

      const locationText = d.building_name ? `${d.building_name} (${d.area_name || 'General'})` : "Unassigned";

      let actionHtml = "—";
      if (!isOnline) {
        actionHtml = `<span style="color:var(--danger);font-weight:600;display:inline-flex;align-items:center;gap:4px;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          needs physical inspection at ${escapeHtml(d.building_name || 'device location')}
        </span>`;
      }

      return `
        <tr class="device-clickable-row" data-device-id="${d.device_id}" style="cursor: pointer;">
          <td><strong>${escapeHtml(d.device_name)}</strong> <span style="font-size:10px;color:var(--text-mid);">ID: ${d.device_id}</span></td>
          <td>${escapeHtml(locationText)}</td>
          <td>${statusBadge}</td>
          <td>${lastOnlineDate}</td>
          <td>${uptimeBadge}</td>
          <td>${actionHtml}</td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    console.error("[AquaSense] loadDevicesHealthTracker error:", err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger);">Error loading health tracker data.</td></tr>`;
  }
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
// SYSTEM SETTINGS VIEW
// ═════════════════════════════════════════════════════════════════════════════
async function loadSettingsView() {
  try {
    const settings = await apiGet("/api/system-settings");
    if (!settings) return;

    const mappings = {
      sms_alerts:             "smsAlertsToggle",
      critical_alerts_only:   "critAlertsToggle",
      device_offline_alerts:  "offlineAlertsToggle",
      daily_summary_report:   "dailySummaryToggle",
      auto_refresh_dashboard: "autoRefreshToggle",
      data_logging:           "dataLoggingToggle",
      maintenance_mode:       "maintModeToggle",
      google_oauth_login:     "googleOauthToggle"
    };

    let currentUser = {};
    try {
      currentUser = JSON.parse(localStorage.getItem("user") || sessionStorage.getItem("user") || "{}");
    } catch(e) {}
    const isAdmin = currentUser.role === "admin";

    // Show/hide System Settings panel based on admin role
    const systemPanel = document.getElementById("systemSettingsPanel");
    const grid = document.getElementById("settingsGrid");
    if (systemPanel && grid) {
      if (isAdmin) {
        systemPanel.style.display = "";
        grid.style.gridTemplateColumns = "1fr 1fr";
      } else {
        systemPanel.style.display = "none";
        grid.style.gridTemplateColumns = "1fr";
      }
    }

    const userKeys = ["sms_alerts", "critical_alerts_only", "device_offline_alerts", "daily_summary_report", "auto_refresh_dashboard"];
    for (const [dbKey, elId] of Object.entries(mappings)) {
      const checkbox = document.getElementById(elId);
      if (checkbox) {
        checkbox.checked = settings[dbKey] === 1 || settings[dbKey] === "1";
        if (userKeys.includes(dbKey)) {
          checkbox.disabled = false;
        } else {
          checkbox.disabled = !isAdmin;
        }

        // Save setting on change
        checkbox.onchange = async () => {
          try {
            const payload = {};
            payload[dbKey] = checkbox.checked ? "1" : "0";
            await apiPut("/api/system-settings", payload);
            
            // Update local cache
            if (!window.systemSettings) window.systemSettings = {};
            window.systemSettings[dbKey] = checkbox.checked ? "1" : "0";

            showToast("Settings updated", `Saved change for ${dbKey.replace(/_/g, ' ')}`);

            // Apply auto refresh toggling instantly in browser
            if (dbKey === "auto_refresh_dashboard") {
              const active = document.querySelector(".view.active");
              if (active) {
                const key = active.id.replace("view-", "");
                startAutoRefresh(key);
              }
            }
          } catch (err) {
            console.error("Failed to update setting:", err);
            checkbox.checked = !checkbox.checked; // Revert switch state
            showToast("Update failed", err.message || "Could not update setting.");
          }
        };
      }
    }

    // Bind custom report template settings
    const reportTextInputs = {
      report_header_title: "reportHeaderTitleInput",
      report_header_subtitle: "reportHeaderSubtitleInput",
      report_header_address: "reportHeaderAddressInput"
    };

    for (const [dbKey, elId] of Object.entries(reportTextInputs)) {
      const input = document.getElementById(elId);
      if (input) {
        input.value = settings[dbKey] || "";
        input.disabled = !isAdmin;
        input.onchange = async () => {
          try {
            const payload = {};
            payload[dbKey] = input.value;
            await apiPut("/api/system-settings", payload);
            
            if (!window.systemSettings) window.systemSettings = {};
            window.systemSettings[dbKey] = input.value;
            showToast("Settings updated", `Saved change for ${dbKey.replace(/_/g, ' ')}`);
          } catch (err) {
            console.error("Failed to update template setting:", err);
            showToast("Update failed", err.message || "Could not update setting.");
          }
        };
      }
    }

    const logoInput = document.getElementById("reportHeaderLogoInput");
    const logoPreview = document.getElementById("reportHeaderLogoPreview");
    const noLogoText = document.getElementById("reportHeaderNoLogoText");
    
    if (logoPreview && noLogoText) {
      if (settings.report_logo_base64) {
        logoPreview.src = settings.report_logo_base64;
        logoPreview.style.display = "block";
        noLogoText.style.display = "none";
      } else {
        logoPreview.style.display = "none";
        noLogoText.style.display = "block";
      }
    }

    if (logoInput) {
      logoInput.disabled = !isAdmin;
      logoInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64String = reader.result;
          try {
            const payload = { report_logo_base64: base64String };
            await apiPut("/api/system-settings", payload);
            
            if (!window.systemSettings) window.systemSettings = {};
            window.systemSettings.report_logo_base64 = base64String;
            
            if (logoPreview && noLogoText) {
              logoPreview.src = base64String;
              logoPreview.style.display = "block";
              noLogoText.style.display = "none";
            }
            showToast("Settings updated", "Saved report logo successfully.");
          } catch (err) {
            console.error("Failed to upload logo:", err);
            showToast("Upload failed", err.message || "Could not save report logo.");
          }
        };
        reader.readAsDataURL(file);
      };
    }
  } catch (err) {
    console.error("[AquaSense] loadSettingsView error:", err);
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
  dashboard:        loadDashboard,
  live:             loadLiveMonitoring,
  readings:         loadSensorReadingsLog,
  analytics:        loadAnalytics,                             // ← NOW CONNECTED
  alerts:           loadAlertsView,                            // ← NOW CONNECTED
  devices:          loadDevices,
  locations:        () => loadLocations("locations-tbody"),
  maintenance:      loadMaintenanceLogs,
  'flow-anomalies': loadFlowAnomalies,
  'health-tracker': loadDevicesHealthTracker,
  sms:              loadSmsLogs,
  users:            loadUsers,
  'system-logs':    loadAuditLogs,
  'compliance-trend': loadComplianceTrend,
  settings:         loadSettingsView,
  reports:          loadReportsView,
};
const viewLoaders = window.viewLoaders;

let refreshInterval = null;

// Views that should keep polling the backend while the user is looking at
// them. "devices" and "alerts" are included so a device the health-check
// marks offline (and the alert it raises) shows up here on its own —
// no manual reload needed.
const AUTO_REFRESH_VIEWS = ["dashboard", "live", "devices", "alerts", "flow-anomalies", "health-tracker", "compliance-trend"];

function startAutoRefresh(viewKey) {
  if (refreshInterval) clearInterval(refreshInterval);
  if (window.systemSettings && (window.systemSettings.auto_refresh_dashboard === 0 || window.systemSettings.auto_refresh_dashboard === "0")) {
    return; // Auto-refresh is disabled
  }
  if (AUTO_REFRESH_VIEWS.includes(viewKey)) {
    refreshInterval = setInterval(() => {
      if (viewLoaders[viewKey]) viewLoaders[viewKey]();
      updateTopBarStatusPill();
    }, 10000);
  }
}

// ── Wire into dashboard.html's navigate() ────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const _originalNavigate = window.navigate;
  window.navigate = function (viewKey) {
    if (typeof _originalNavigate === "function") _originalNavigate(viewKey);
    if (viewLoaders[viewKey]) viewLoaders[viewKey]();
    updateTopBarStatusPill();
    startAutoRefresh(viewKey);
  };

  document.querySelectorAll(".nav-item[data-view]").forEach(item => {
    const clone = item.cloneNode(true);
    item.parentNode.replaceChild(clone, item);
    clone.addEventListener("click", () => navigate(clone.dataset.view));
  });

  const initApp = async () => {
    try {
      window.systemSettings = await apiGet("/api/system-settings");
    } catch (e) {
      console.warn("Failed to load system settings on init:", e);
    }
    loadDashboard();
    updateTopBarStatusPill();
    startAutoRefresh("dashboard");
    // Automatically poll status pill every 10 seconds globally
    setInterval(updateTopBarStatusPill, 10000);
  };

  if (window.authCompleted) {
    initApp();
  } else {
    window.addEventListener("auth-ready", initApp);
  }

  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    const active = document.querySelector(".view.active");
    if (active) {
      const key = active.id.replace("view-", "");
      if (viewLoaders[key]) viewLoaders[key]();
      updateTopBarStatusPill();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT VIEW (ADMIN ONLY)
// ─────────────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const tbody = document.getElementById("users-tbody");
  if (!tbody) return;

  try {
    const users = await apiGet("/api/auth/users");
    if (!users) return;

    if (users.length === 0) {
      tbody.innerHTML = emptyRow(6, "No users registered yet.");
      return;
    }

    tbody.innerHTML = users.map(u => {
      const initial = u.fullname ? u.fullname.charAt(0).toUpperCase() : "?";
      const statusClass = (u.status || "active").toLowerCase() === "active" ? "safe" : "offline";
      const statusLabelText = (u.status || "active").toLowerCase() === "active" ? "Active" : "Inactive";
      const roleLabelText = u.role ? u.role.toUpperCase() : "—";
      const createdDate = u.created_at 
        ? new Date(u.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) 
        : "—";

      let avatarContent = initial;
      if (u.avatar) {
        avatarContent = `<img src="${u.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.textContent = '${initial}';"/>`;
      }

      return `
        <tr class="user-row" style="cursor: pointer;" title="Click to edit user role and status">
          <td>
            <div style="display:flex;align-items:center;gap:10px">
              <div class="user-row-avatar">${avatarContent}</div>
              <div><strong>${escapeHtml(u.fullname)}</strong></div>
            </div>
          </td>
          <td style="color:var(--text-mid)">${escapeHtml(u.email)}</td>
          <td style="color:var(--text-mid)">${escapeHtml(u.phone_number || "—")}</td>
          <td><span class="role-badge ${u.role ? u.role.toLowerCase() : ""}">${roleLabelText}</span></td>
          <td><span class="r-status ${statusClass}">${statusLabelText}</span></td>
          <td style="color:var(--text-light);font-size:12px">${createdDate}</td>
        </tr>`;
    }).join("");

    // Attach click listeners programmatically to avoid HTML escaping issues
    tbody.querySelectorAll(".user-row").forEach((row, index) => {
      row.addEventListener("click", () => {
        const userObj = users[index];
        if (typeof window.openEditUserModal === "function") {
          window.openEditUserModal(userObj);
        } else if (typeof openEditUserModal === "function") {
          openEditUserModal(userObj);
        }
      });
    });

  } catch (err) {
    console.error("[AquaSense] loadUsers error:", err);
    tbody.innerHTML = emptyRow(6, "Unable to load system users.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP BAR NOTIFICATION DROPDOWN (ONLY SHOWS NEW/UNRESOLVED ALERTS)
// ─────────────────────────────────────────────────────────────────────────────
window.toggleNotifDropdown = function(event) {
  if (event) event.stopPropagation();
  const dropdown = document.getElementById("notifDropdown");
  if (!dropdown) return;
  const isHidden = dropdown.style.display === "none";
  dropdown.style.display = isHidden ? "flex" : "none";
  if (isHidden) {
    loadDropdownAlerts();
    markAllAlertsAsRead();
    
    // Instantly hide the red dot in UI for zero lag
    const notifDot = document.getElementById("topbarNotifDot");
    if (notifDot) notifDot.style.display = "none";
  }
};

async function markAllAlertsAsRead() {
  try {
    const rows = await apiGet("/api/alerts?status=unresolved&limit=200");
    if (!rows) return;

    let userId = "default";
    try {
      const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
      if (raw) {
        const user = JSON.parse(raw);
        userId = user.id || user.user_id || "default";
      }
    } catch(e) {}

    let readAlerts = [];
    try {
      const readRaw = localStorage.getItem(`read_alerts_${userId}`);
      if (readRaw) readAlerts = JSON.parse(readRaw);
    } catch(e) {}

    let changed = false;
    rows.forEach(a => {
      if (!readAlerts.includes(a.id)) {
        readAlerts.push(a.id);
        changed = true;
      }
    });

    if (changed) {
      localStorage.setItem(`read_alerts_${userId}`, JSON.stringify(readAlerts));
      refreshAlertBadgeCounts();
    }
  } catch (err) {
    console.error("[AquaSense] markAllAlertsAsRead error:", err);
  }
}

async function loadDropdownAlerts() {
  const body = document.getElementById("notifDropdownBody");
  if (!body) return;

  body.innerHTML = `<div style="padding:16px;text-align:center;font-size:12px;color:var(--text-light)">Loading notifications...</div>`;

  try {
    const unresolved = await apiGet("/api/alerts?status=unresolved&limit=5");
    if (!unresolved) return;

    if (unresolved.length === 0) {
      body.innerHTML = `<div style="padding:24px 16px;text-align:center;font-size:12px;color:var(--text-light)">No new notifications. All systems clear.</div>`;
      return;
    }

    body.innerHTML = unresolved.map(a => {
      const level = alertClass(a.level);
      const isResolved = a.status === "resolved";
      const alertIcon = isResolved
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

      const dotClass = isResolved ? "low" : level;

      return `
        <div class="notif-dropdown-item" onclick="navigate('alerts'); document.getElementById('notifDropdown').style.display='none';">
          <div class="notif-dropdown-icon ${dotClass}">${alertIcon}</div>
          <div class="notif-dropdown-info">
            <div class="notif-dropdown-title">${escapeHtml(a.message || a.parameter || "Alert")}</div>
            <div class="notif-dropdown-meta">${escapeHtml(a.building_name || a.device_id || "—")} · ${timeAgo(a.created_at)}</div>
          </div>
        </div>`;
    }).join("");
  } catch (err) {
    console.error("[AquaSense] loadDropdownAlerts error:", err);
    body.innerHTML = `<div style="padding:16px;text-align:center;font-size:12px;color:var(--error)">Failed to load.</div>`;
  }
}

// Click outside dropdown to close it
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("notifDropdown");
  const bellBtn = document.getElementById("notifBellBtn");
  if (dropdown && dropdown.style.display !== "none") {
    if (!dropdown.contains(e.target) && !bellBtn.contains(e.target)) {
      dropdown.style.display = "none";
    }
  }
});

// ════════════════════════ SYSTEM AUDIT LOGS ════════════════════════
let rawAuditLogs = [];
window.auditCurrentPage = 1;
const AUDIT_LIMIT = 15;

async function loadAuditLogs() {
  const tbody = document.getElementById("audit-logs-tbody");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-light)">Loading audit logs...</td></tr>`;

  try {
    const searchVal = document.getElementById("auditLogSearch")?.value || "";
    const roleVal = document.getElementById("auditLogRoleFilter")?.value || "";
    const currentPage = window.auditCurrentPage || 1;

    const params = new URLSearchParams();
    params.set("page", currentPage.toString());
    params.set("limit", AUDIT_LIMIT.toString());
    if (searchVal) params.set("search", searchVal);
    if (roleVal) params.set("role", roleVal);

    const result = await apiGet(`/api/audit-logs?${params.toString()}`);
    if (!result) return;

    rawAuditLogs = result.data || [];
    const pagination = result.pagination || { page: 1, limit: AUDIT_LIMIT, total: rawAuditLogs.length, totalPages: 1 };

    // Update pagination controls
    const totalCountEl = document.getElementById("auditTotalCount");
    const pageNumEl = document.getElementById("auditPageNum");
    const pageStartEl = document.getElementById("auditPageStart");
    const pageEndEl = document.getElementById("auditPageEnd");
    const prevBtn = document.getElementById("auditPrevBtn");
    const nextBtn = document.getElementById("auditNextBtn");

    if (totalCountEl) totalCountEl.textContent = pagination.total;
    if (pageNumEl) pageNumEl.textContent = `Page ${pagination.page} of ${pagination.totalPages || 1}`;
    if (pageStartEl) pageStartEl.textContent = pagination.total > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
    if (pageEndEl) pageEndEl.textContent = Math.min(pagination.page * pagination.limit, pagination.total);

    if (prevBtn) prevBtn.disabled = (pagination.page <= 1);
    if (nextBtn) nextBtn.disabled = (pagination.page >= pagination.totalPages || pagination.totalPages === 0);

    renderFilteredAuditLogs();
  } catch (err) {
    console.error("[AquaSense] loadAuditLogs error:", err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--error)">Failed to load audit logs. Only administrators have access.</td></tr>`;
  }
}

function renderFilteredAuditLogs() {
  const tbody = document.getElementById("audit-logs-tbody");
  if (!tbody) return;

  if (rawAuditLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-light)">No audit logs found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rawAuditLogs.map((log, index) => {
    const date = new Date(log.created_at);
    const dateFormatted = date.toLocaleDateString("en-US", { year: 'numeric', month: 'short', day: 'numeric' });
    const timeFormatted = date.toLocaleTimeString("en-US", { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Role badges styling consistent with User Management
    const roleLower = (log.role || "").toLowerCase();
    const roleLabelText = log.role ? log.role.toUpperCase() : "—";
    
    let roleClass = roleLower;
    if (roleLower !== "admin" && roleLower !== "gsu" && roleLower !== "hsu") {
      roleClass = ""; // Fallback standard badge style
    }

    return `
      <tr class="audit-row" data-index="${index}" style="cursor: pointer;">
        <td class="row-checkbox-cell" onclick="event.stopPropagation();"><input type="checkbox" class="audit-row-checkbox" value="${log.id}"/></td>
        <td style="white-space:nowrap;color:var(--text-mid);font-size:13px;">
          <strong>${dateFormatted}</strong>
          <div style="font-size:11px;color:var(--text-light);margin-top:2px;">${timeFormatted}</div>
        </td>
        <td>
          <div style="font-weight:600;font-size:13px;color:var(--text);">${escapeHtml(log.username || "—")}</div>
        </td>
        <td><span class="role-badge ${roleClass}">${roleLabelText}</span></td>
        <td><span style="font-family:monospace;font-weight:600;font-size:12px;color:var(--text);">${escapeHtml(log.action || "—")}</span></td>
        <td>
          <div style="font-size:13px;color:var(--text-mid);max-width:320px;word-wrap:break-word;white-space:normal;line-height:1.4;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(log.details || "—")}</div>
        </td>
        <td style="text-align: center;" onclick="event.stopPropagation();">
          <button class="delete-audit-btn" data-id="${log.id}" data-name="${escapeHtml(log.action)}" title="Delete Log" style="background:transparent;border:none;color:var(--danger);cursor:pointer;padding:4px;display:inline-flex;align-items:center;justify-content:center;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </td>
      </tr>
    `;
  }).join("");

  // Attach click listeners to rows programmatically to open details modal
  tbody.querySelectorAll(".audit-row").forEach(row => {
    row.addEventListener("click", () => {
      const idx = parseInt(row.dataset.index, 10);
      const log = rawAuditLogs[idx];
      if (log && typeof window.openAuditDetailsModal === "function") {
        window.openAuditDetailsModal(log);
      }
    });
  });

  // Attach click listener for delete buttons
  tbody.querySelectorAll(".delete-audit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (typeof window.openDeleteConfirmModal === "function") {
        window.openDeleteConfirmModal("audit", btn.dataset.id, btn.dataset.name);
      }
    });
  });

  // Attach checkboxes event listeners to trigger UI updates for bulk action
  tbody.querySelectorAll(".audit-row-checkbox").forEach(cb => {
    cb.addEventListener("change", updateAuditsSelection);
  });
  
  // Uncheck select-all checkbox on load/render
  const selectAllCb = document.getElementById("auditSelectAll");
  if (selectAllCb) selectAllCb.checked = false;
  updateAuditsSelection();
}

window.auditPrevPage = function() {
  if (window.auditCurrentPage > 1) {
    window.auditCurrentPage--;
    loadAuditLogs();
  }
};

window.auditNextPage = function() {
  window.auditCurrentPage++;
  loadAuditLogs();
};

window.updateAuditsSelection = function() {
  const checkboxes = Array.from(document.querySelectorAll(".audit-row-checkbox"));
  const checked = checkboxes.filter(cb => cb.checked);
  const deleteBtn = document.getElementById("bulkDeleteAuditsBtn");
  const countEl = document.getElementById("selectedAuditsCount");

  if (deleteBtn && countEl) {
    if (checked.length > 0) {
      deleteBtn.style.display = "flex";
      countEl.textContent = checked.length;
    } else {
      deleteBtn.style.display = "none";
    }
  }
};

window.toggleSelectAllAudits = function(source) {
  const checkboxes = document.querySelectorAll(".audit-row-checkbox");
  checkboxes.forEach(cb => cb.checked = source.checked);
  updateAuditsSelection();
};

window.clearAuditsSelection = function() {
  const selectAll = document.getElementById("auditSelectAll");
  if (selectAll) selectAll.checked = false;
  document.querySelectorAll(".audit-row-checkbox").forEach(cb => cb.checked = false);
  updateAuditsSelection();
};

window.openBulkDeleteAuditsModal = function() {
  const ids = Array.from(document.querySelectorAll(".audit-row-checkbox:checked")).map(cb => cb.value);
  if (ids.length === 0) return;
  const label = ids.length === 1 ? "1 audit log" : `${ids.length} audit logs`;
  if (typeof window.openDeleteConfirmModal === "function") {
    window.openDeleteConfirmModal("audits", ids, label);
  }
};

// Wire search and filter inputs on DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  const setupListeners = () => {
    const searchInput = document.getElementById("auditLogSearch");
    const roleFilterSelect = document.getElementById("auditLogRoleFilter");

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        window.auditCurrentPage = 1;
        loadAuditLogs();
      });
    }
    if (roleFilterSelect) {
      roleFilterSelect.addEventListener("change", () => {
        window.auditCurrentPage = 1;
        loadAuditLogs();
      });
    }
    
    // Pre-fill Report Metadata with logged in user data
    const authorNameInput = document.getElementById("reportAuthorName");
    const authorRoleInput = document.getElementById("reportAuthorRole");
    if (authorNameInput && authorRoleInput) {
      const userStr = localStorage.getItem("user") || sessionStorage.getItem("user");
      if (userStr) {
        try {
          const user = JSON.parse(userStr);
          authorNameInput.value = user.fullname || "System Operator";
          const labels = { admin: "Administrator", gsu: "GSU Personnel", hsu: "HSU Personnel" };
          authorRoleInput.value = labels[(user.role || "").toLowerCase()] || "Staff";
        } catch(e){}
      }
    }
  };

  setupListeners();
  // Safe fallback in case DOM structure re-rendered
  window.addEventListener("auth-ready", setupListeners);
});

// ════════════════════════ FLOW ANOMALY MODAL HELPERS ════════════════════════
window.showFlowAnomalyDetails = function(devDataEncoded, currentFlow, avgFlow, statusText, statusClass) {
  const dev = JSON.parse(decodeURIComponent(devDataEncoded));
  
  const modal = document.getElementById("flowAnomalyModal");
  if (!modal) return;

  document.getElementById("flowAnomalyModalBuilding").textContent = dev.building_name || "Unassigned Building";
  document.getElementById("flowAnomalyModalZone").textContent = "Pipe Zone: " + (dev.area_name || "General Zone");
  document.getElementById("flowAnomalyModalDevice").textContent = dev.device_name;
  
  // Status label
  const statusEl = document.getElementById("flowAnomalyModalStatus");
  const deviceStatus = (dev.status || "offline").toLowerCase();
  let statusBadgeClass = "offline";
  if (deviceStatus === "online") statusBadgeClass = "safe";
  else if (deviceStatus === "maintenance") statusBadgeClass = "warn";
  statusEl.innerHTML = `<span class="r-status ${statusBadgeClass}">${dev.status ? dev.status.toUpperCase() : "OFFLINE"}</span>`;

  document.getElementById("flowAnomalyModalRate").textContent = Number(currentFlow).toFixed(1);
  document.getElementById("flowAnomalyModalAvg").textContent = Number(avgFlow).toFixed(1);

  // Status Analysis Description
  const descEl = document.getElementById("flowAnomalyModalDescription");
  let analysis = "";
  if (statusClass === "danger") {
    analysis = `<strong>⚠️ Warning: Sudden Flow Spike Detected</strong><br>
    The current flow rate of <strong>${Number(currentFlow).toFixed(1)} L/min</strong> is significantly higher than the baseline average of <strong>${Number(avgFlow).toFixed(1)} L/min</strong>. This typically indicates a pipe burst, structural leak, or unauthorized usage in the <strong>${escapeHtml(dev.area_name || 'General Zone')}</strong> of <strong>${escapeHtml(dev.building_name || 'the building')}</strong>. Urgent inspection is recommended.`;
    descEl.style.borderLeft = "4px solid var(--error)";
  } else if (statusClass === "warn") {
    analysis = `<strong>⚠️ Notice: Flow Rate Drop Detected</strong><br>
    The current flow rate of <strong>${Number(currentFlow).toFixed(1)} L/min</strong> has dropped significantly below the baseline average of <strong>${Number(avgFlow).toFixed(1)} L/min</strong>. This might indicate a pipe blockage, valve restriction, pump malfunction, or zero consumption in the <strong>${escapeHtml(dev.area_name || 'General Zone')}</strong> of <strong>${escapeHtml(dev.building_name || 'the building')}</strong>.`;
    descEl.style.borderLeft = "4px solid var(--warning)";
  } else {
    analysis = `<strong>✅ Normal Flow Conditions</strong><br>
    The flow rate of <strong>${Number(currentFlow).toFixed(1)} L/min</strong> is well within normal parameters compared to the historical baseline average of <strong>${Number(avgFlow).toFixed(1)} L/min</strong>. No operational anomalies detected.`;
    descEl.style.borderLeft = "4px solid var(--success)";
  }
  descEl.innerHTML = analysis;

  // File maintenance log action button
  const maintBtn = document.getElementById("flowAnomalyReportBtn");
  if (maintBtn) {
    maintBtn.onclick = () => {
      closeFlowAnomalyModal();
      // Prefill the device select and other fields
      const devSelect = document.getElementById("maintDeviceId");
      if (devSelect) {
        devSelect.value = dev.device_id;
      }
      const titleInput = document.getElementById("maintTitle");
      if (titleInput) {
        titleInput.value = `Anomaly Report: ${statusText} on ${dev.device_name}`;
      }
      const descInput = document.getElementById("maintDetail");
      if (descInput) {
        descInput.value = `Automated flow analysis reports a ${statusText.toLowerCase()} at ${dev.building_name} (${dev.area_name || 'General Zone'}).\nCurrent flow: ${Number(currentFlow).toFixed(1)} L/min. Baseline avg: ${Number(avgFlow).toFixed(1)} L/min.`;
      }
      const tagsInput = document.getElementById("maintTags");
      if (tagsInput) {
        tagsInput.value = statusClass === "danger" ? "leak, anomaly" : "blockage, anomaly";
      }
      
      // Open maintenance modal
      const maintModal = document.getElementById("addMaintenanceModal");
      if (maintModal) {
        maintModal.style.display = "flex";
      }
    };
  }

  modal.style.display = "flex";
};

window.closeFlowAnomalyModal = function() {
  const modal = document.getElementById("flowAnomalyModal");
  if (modal) modal.style.display = "none";
};

window.handleFlowAnomalyModalBackdrop = function(e) {
  if (e.target.id === "flowAnomalyModal") {
    closeFlowAnomalyModal();
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ANALYTICS REPORTS VIEW
// ═════════════════════════════════════════════════════════════════════════════
window.lastGeneratedReportData = null;

async function loadReportsView() {
  const startDateInput = document.getElementById("reportStartDate");
  const endDateInput = document.getElementById("reportEndDate");
  
  if (startDateInput && !startDateInput.value) {
    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 7);
    
    startDateInput.value = weekAgo.toISOString().slice(0, 10);
    endDateInput.value = today.toISOString().slice(0, 10);
  }

  // Populate locations dropdown
  const locSelect = document.getElementById("reportLocationFilter");
  if (locSelect && locSelect.options.length <= 1) {
    try {
      const locations = await apiGet("/api/locations");
      if (locations && Array.isArray(locations)) {
        locations.forEach(loc => {
          const opt = document.createElement("option");
          opt.value = loc.location_id;
          opt.textContent = `${loc.building_name} (${loc.area_name || 'General'})`;
          locSelect.appendChild(opt);
        });
      }
    } catch (err) {
      console.warn("[AquaSense] Error loading locations for report filter:", err);
    }
  }

  // Hide preview initially
  const previewContainer = document.getElementById("reportPreviewContainer");
  const placeholder = document.getElementById("reportPreviewPlaceholder");
  const content = document.getElementById("reportPreviewContent");
  if (previewContainer) previewContainer.style.display = "none";
  if (placeholder) {
    placeholder.style.display = "block";
    placeholder.textContent = 'Click "Preview Report" to generate summary metrics';
  }
  if (content) content.innerHTML = "";
}

async function fetchReportPreview() {
  const startDate = document.getElementById("reportStartDate").value;
  const endDate = document.getElementById("reportEndDate").value;
  const buildingId = document.getElementById("reportLocationFilter").value;

  if (!startDate || !endDate) {
    showToast("Invalid Dates", "Please select both start and end dates.");
    return;
  }

  const placeholder = document.getElementById("reportPreviewPlaceholder");
  const content = document.getElementById("reportPreviewContent");
  const previewContainer = document.getElementById("reportPreviewContainer");

  if (placeholder) placeholder.textContent = "Generating preview data...";
  if (content) content.innerHTML = "";
  if (previewContainer) previewContainer.style.display = "block";

  try {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    if (buildingId) params.set("building_id", buildingId);

    const data = await apiGet(`/api/reports/summary?${params.toString()}`);
    if (!data) throw new Error("Failed to load report summary data.");

    window.lastGeneratedReportData = data;
    if (placeholder) placeholder.style.display = "none";

    let currentUser = {};
    try {
      currentUser = JSON.parse(localStorage.getItem("user") || sessionStorage.getItem("user") || "{}");
    } catch(e) {}
    const role = (currentUser.role || "").toLowerCase();

    let previewHtml = `
      <div style="font-family: 'DM Sans', sans-serif; display: flex; flex-direction: column; gap: 20px;">
        <div style="font-size: 16px; font-weight: 700; color: var(--text-dark); border-bottom: 2px solid var(--border); padding-bottom: 8px;">
          Report Preview Summary
        </div>
    `;

    // 1. Water Quality Preview
    if (role === "hsu" || role === "admin") {
      const q = data.waterQuality || {};
      previewHtml += `
        <div>
          <h4 style="font-size: 13.5px; font-weight: 700; color: var(--water-1); margin-bottom: 10px;">Water Quality Analytics (HSU)</h4>
          <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 12px;">
            <div class="stat-card" style="padding: 12px; margin-bottom: 0;">
              <div class="stat-label">Avg pH</div>
              <div class="stat-value" style="font-size: 18px;">${q.avg_ph !== null && q.avg_ph !== undefined ? Number(q.avg_ph).toFixed(2) : "—"}</div>
            </div>
            <div class="stat-card" style="padding: 12px; margin-bottom: 0;">
              <div class="stat-label">Avg Turbidity</div>
              <div class="stat-value" style="font-size: 18px;">${q.avg_turbidity !== null && q.avg_turbidity !== undefined ? Number(q.avg_turbidity).toFixed(2) + " NTU" : "—"}</div>
            </div>
            <div class="stat-card" style="padding: 12px; margin-bottom: 0;">
              <div class="stat-label">Avg TDS</div>
              <div class="stat-value" style="font-size: 18px;">${q.avg_tds !== null && q.avg_tds !== undefined ? Number(q.avg_tds).toFixed(0) + " ppm" : "—"}</div>
            </div>
            <div class="stat-card" style="padding: 12px; margin-bottom: 0;">
              <div class="stat-label">Avg Ammonia</div>
              <div class="stat-value" style="font-size: 18px;">${q.avg_ammonia !== null && q.avg_ammonia !== undefined ? Number(q.avg_ammonia).toFixed(3) + " mg/L" : "—"}</div>
            </div>
          </div>
          <div style="font-size:12.5px; color: var(--text-mid); display:flex; flex-direction:column; gap:4px; background: rgba(0,0,0,0.02); padding: 10px; border-radius: 6px;">
            <div>• Total Water Samples Evaluated: <strong>${q.total_readings || 0}</strong></div>
            <div>• pH Standard Violations: <strong style="${q.ph_violations > 0 ? 'color:#EF4444;' : ''}">${q.ph_violations || 0}</strong></div>
            <div>• Turbidity Standard Violations: <strong style="${q.turbidity_violations > 0 ? 'color:#EF4444;' : ''}">${q.turbidity_violations || 0}</strong></div>
            <div>• Ammonia Standard Violations: <strong style="${q.ammonia_violations > 0 ? 'color:#EF4444;' : ''}">${q.ammonia_violations || 0}</strong></div>
          </div>
        </div>
      `;
    }

    // 2. Consumption & Maintenance Preview
    if (role === "gsu" || role === "admin") {
      const c = data.consumption || {};
      const m = data.maintenance || {};
      previewHtml += `
        <div>
          <h4 style="font-size: 13.5px; font-weight: 700; color: var(--water-2); margin-bottom: 10px;">Consumption & Operation Health (GSU)</h4>
          <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 12px;">
            <div class="stat-card" style="padding: 12px; margin-bottom: 0;">
              <div class="stat-label">Total Consumption</div>
              <div class="stat-value" style="font-size: 18px;">${c.total_consumed !== null && c.total_consumed !== undefined ? Number(c.total_consumed).toLocaleString() + " L" : "0 L"}</div>
            </div>
            <div class="stat-card" style="padding: 12px; margin-bottom: 0;">
              <div class="stat-label">Avg Flow Rate</div>
              <div class="stat-value" style="font-size: 18px;">${c.avg_flow_rate !== null && c.avg_flow_rate !== undefined ? Number(c.avg_flow_rate).toFixed(2) + " L/min" : "—"}</div>
            </div>
            <div class="stat-card" style="padding: 12px; margin-bottom: 0;">
              <div class="stat-label">Maintenance Interventions</div>
              <div class="stat-value" style="font-size: 18px;">${m.total_maintenance_logs || 0}</div>
            </div>
          </div>
        </div>
      `;
    }

    previewHtml += `</div>`;
    content.innerHTML = previewHtml;

  } catch (err) {
    console.error(err);
    if (placeholder) placeholder.textContent = "Failed to load preview. Please check settings or try again.";
  }
}

async function exportReportPDF() {
  const startDate = document.getElementById("reportStartDate").value;
  const endDate = document.getElementById("reportEndDate").value;
  if (!startDate || !endDate) {
    showToast("Invalid Dates", "Please select dates first.");
    return;
  }

  if (!window.lastGeneratedReportData) {
    await fetchReportPreview();
  }
  const data = window.lastGeneratedReportData;
  if (!data) return;

  // Load custom template settings
  let settings = {};
  try {
    settings = await apiGet("/api/system-settings") || {};
  } catch(e) {}

  let currentUser = {};
  try {
    currentUser = JSON.parse(localStorage.getItem("user") || sessionStorage.getItem("user") || "{}");
  } catch(e) {}
  const role = (currentUser.role || "").toLowerCase();

  // Populate letterhead settings
  document.getElementById("tplReportTitle").textContent = settings.report_header_title || "AquaSense Water Analytics";
  document.getElementById("tplReportSubtitle").textContent = settings.report_header_subtitle || "Camarines Sur Polytechnic Colleges";
  document.getElementById("tplReportAddress").textContent = settings.report_header_address || "Nabua, Camarines Sur, Philippines";

  const logoImg = document.getElementById("tplReportLogo");
  const fallbackLogo = document.getElementById("tplReportLogoFallback");
  if (settings.report_logo_base64) {
    logoImg.src = settings.report_logo_base64;
    logoImg.style.display = "block";
    fallbackLogo.style.display = "none";
  } else {
    logoImg.style.display = "none";
    fallbackLogo.style.display = "flex";
  }

  // Populate metadata
  document.getElementById("tplRecipientRole").textContent = currentUser.role ? currentUser.role.toUpperCase() : "—";
  document.getElementById("tplReportPeriod").textContent = `${startDate} to ${endDate}`;
  document.getElementById("tplReportGeneratedDate").textContent = `Generated: ${new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const inputAuthorName = document.getElementById("reportAuthorName").value.trim();
  const inputAuthorRole = document.getElementById("reportAuthorRole").value.trim();
  const inputRemarks = document.getElementById("reportRemarks").value.trim();

  document.getElementById("tplAuthorName").textContent = inputAuthorName || currentUser.fullname || "System Operator";
  document.getElementById("tplAuthorRole").textContent = inputAuthorRole || roleLabels[role] || "Staff";

  if (inputRemarks) {
    document.getElementById("tplRemarksText").textContent = inputRemarks;
    document.getElementById("tplRemarksContainer").style.display = "block";
  } else {
    document.getElementById("tplRemarksContainer").style.display = "none";
  }

  // Build report body HTML formatted for paper print
  let bodyHtml = `
    <div style="font-family: 'Inter', sans-serif;">
      <p style="font-size: 13px; color: #475569; line-height: 1.5; margin-bottom: 24px;">
        This document contains the consolidated water quality analytics and operation metrics monitored by the AquaSense system during the reporting period from <strong>${startDate}</strong> to <strong>${endDate}</strong>.
      </p>
  `;

  if (role === "hsu" || role === "admin") {
    const q = data.waterQuality || {};
    bodyHtml += `
      <div style="margin-bottom: 30px;">
        <h3 style="font-size: 13.5px; font-weight: 700; color: #1E3A8A; margin-bottom: 12px; text-transform: uppercase; border-bottom: 1.5px solid #E2E8F0; padding-bottom: 4px;">I. Water Quality Monitoring Metrics</h3>
        <table style="width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px;">
          <thead>
            <tr style="background: #F8FAFC;">
              <th style="border: 1px solid #E2E8F0; padding: 10px; text-align: left;">Quality Parameter</th>
              <th style="border: 1px solid #E2E8F0; padding: 10px; text-align: right;">Average Observed Value</th>
              <th style="border: 1px solid #E2E8F0; padding: 10px; text-align: right;">Regulatory Threshold Breaches</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">pH Level</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${q.avg_ph !== null && q.avg_ph !== undefined ? Number(q.avg_ph).toFixed(2) : "—"}</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; color: ${q.ph_violations > 0 ? '#EF4444' : '#1E293B'}; font-weight: 600;">${q.ph_violations || 0}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">Turbidity</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${q.avg_turbidity !== null && q.avg_turbidity !== undefined ? Number(q.avg_turbidity).toFixed(2) + " NTU" : "—"}</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; color: ${q.turbidity_violations > 0 ? '#EF4444' : '#1E293B'}; font-weight: 600;">${q.turbidity_violations || 0}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">Total Dissolved Solids (TDS)</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${q.avg_tds !== null && q.avg_tds !== undefined ? Number(q.avg_tds).toFixed(0) + " ppm" : "—"}</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">0</td>
            </tr>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">Ammonia</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${q.avg_ammonia !== null && q.avg_ammonia !== undefined ? Number(q.avg_ammonia).toFixed(3) + " mg/L" : "—"}</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; color: ${q.ammonia_violations > 0 ? '#EF4444' : '#1E293B'}; font-weight: 600;">${q.ammonia_violations || 0}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">Temperature</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${q.avg_temperature !== null && q.avg_temperature !== undefined ? Number(q.avg_temperature).toFixed(2) + " °C" : "—"}</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; color: ${q.temperature_violations > 0 ? '#EF4444' : '#1E293B'}; font-weight: 600;">${q.temperature_violations || 0}</td>
            </tr>
          </tbody>
        </table>
        <div style="font-size: 11px; color: #64748B; margin-top: 8px; font-style: italic;">
          * Total recorded samples analyzed during this period: <strong>${q.total_readings || 0}</strong>. Standards referenced from the Philippine National Standards for Drinking Water (PNSDW 2017).
        </div>
      </div>
    `;
  }

  if (role === "gsu" || role === "admin") {
    const c = data.consumption || {};
    const m = data.maintenance || {};
    bodyHtml += `
      <div>
        <h3 style="font-size: 13.5px; font-weight: 700; color: #0284C7; margin-bottom: 12px; text-transform: uppercase; border-bottom: 1.5px solid #E2E8F0; padding-bottom: 4px;">II. Consumption and Operations Summary</h3>
        <table style="width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px;">
          <thead>
            <tr style="background: #F8FAFC;">
              <th style="border: 1px solid #E2E8F0; padding: 10px; text-align: left;">Operational Parameter</th>
              <th style="border: 1px solid #E2E8F0; padding: 10px; text-align: right;">Consolidated Total / Average</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">Total Water Consumption (Liters)</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${c.total_consumed !== null && c.total_consumed !== undefined ? Number(c.total_consumed).toLocaleString() + " L" : "0 L"}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">Average Campus Flow Rate</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${c.avg_flow_rate !== null && c.avg_flow_rate !== undefined ? Number(c.avg_flow_rate).toFixed(2) + " L/min" : "—"}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #E2E8F0; padding: 10px;">Completed Maintenance Activities</td>
              <td style="border: 1px solid #E2E8F0; padding: 10px; text-align: right; font-weight: 600;">${m.total_maintenance_logs || 0} repairs</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  bodyHtml += `</div>`;
  document.getElementById("tplReportBody").innerHTML = bodyHtml;

  const formatRadio = document.querySelector('input[name="reportFormat"]:checked');
  const reportFormat = formatRadio ? formatRadio.value : "average";
  const locFilter = document.getElementById("reportLocationFilter").value;

  if (reportFormat === "detailed") {
    document.getElementById("tplReportBody").style.display = "none";
    document.getElementById("detailedReportChartsContainer").style.display = "block";
    
    try {
      showToast("Preparing Details", "Fetching timeline data...");
      let url = `/api/sensors?limit=5000&startDate=${startDate}&endDate=${endDate}`;
      if (locFilter) url += `&buildingId=${locFilter}`;
      
      const res = await apiGet(url);
      const readings = res.data || [];
      // reverse so it's chronological (oldest to newest)
      readings.reverse();
      
      let chartsHtml = "";
      chartsHtml += drawDetailedSvgChartString(readings, "ph_level", 0, 14, "pH Level Over Time", "");
      chartsHtml += drawDetailedSvgChartString(readings, "tds", 0, 1000, "TDS Over Time", " ppm");
      chartsHtml += drawDetailedSvgChartString(readings, "turbidity", 0, 20, "Turbidity Over Time", " NTU");
      chartsHtml += drawDetailedSvgChartString(readings, "ammonia", 0, 5, "Ammonia Over Time", " mg/L");
      chartsHtml += drawDetailedSvgChartString(readings, "temperature", 15, 40, "Temperature Over Time", " °C");
      
      document.getElementById("detailedChartsContent").innerHTML = chartsHtml;
    } catch(err) {
      console.error(err);
      showToast("Error", "Could not fetch detailed data.");
      return;
    }
  } else {
    document.getElementById("tplReportBody").style.display = "block";
    document.getElementById("detailedReportChartsContainer").style.display = "none";
    document.getElementById("detailedChartsContent").innerHTML = "";
  }


  // Run PDF download using html2pdf.js
  const tplWrapper = document.getElementById("printableReportTemplate");
  const outerWrapper = tplWrapper.parentElement;
  outerWrapper.style.display = "block";
  
  const opt = {
    margin:       15,
    filename:     `AquaSense_${role.toUpperCase()}_Report_${startDate}_to_${endDate}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true },
    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  try {
    await html2pdf().set(opt).from(tplWrapper).save();
    try {
      await apiPost("/api/audit-logs/export", { action: "EXPORT_PDF", details: `Exported Analytics Report PDF (${startDate} to ${endDate})` });
    } catch(e) { console.error(e); }
  } catch (err) {
    showToast("Export failed", "Could not generate PDF report.");
    console.error(err);
  } finally {
    outerWrapper.style.display = "none";
  }
}

function drawDetailedSvgChartString(data, key, yMin, yMax, title, unit) {
  if (!data || data.length === 0) {
    return `<div style="padding: 15px; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 20px;">
      <h4 style="font-size: 13px; font-weight: 700; color: #1E3A8A; margin: 0 0 10px 0;">${title}</h4>
      <p style="font-size: 12px; color: #64748B;">No data available for this parameter.</p>
    </div>`;
  }

  const svgW = 680; 
  const svgH = 120;
  const chartH = 80;
  const leftPad = 65;
  const rightPad = 20;
  const topPad = 15;
  const slotW = (svgW - leftPad - rightPad) / Math.max(data.length - 1, 1);

  // Y-axis grid
  const steps = 4;
  let gridLines = "";
  for (let i = 0; i <= steps; i++) {
    const val = yMin + ((yMax - yMin) / steps) * i;
    const y = topPad + chartH - ((val - yMin) / (yMax - yMin)) * chartH;
    gridLines += `
      <line x1="${leftPad}" y1="${y}" x2="${svgW - rightPad}" y2="${y}" stroke="#E2E8F0" stroke-width="1.2" stroke-dasharray="4,4"/>
      <text x="${leftPad - 8}" y="${y + 4}" font-size="9.5" fill="#64748B" text-anchor="end">${val.toFixed(1)}${unit}</text>
    `;
  }

  const baseLine = `<line x1="${leftPad}" y1="${topPad + chartH}" x2="${svgW - rightPad}" y2="${topPad + chartH}" stroke="#94A3B8" stroke-width="1.5" stroke-linecap="round"/>`;

  const coords = data.map((d, i) => {
    const x = leftPad + i * slotW;
    const rawVal = d[key];
    const val = (rawVal !== null && rawVal !== undefined && rawVal !== "") ? Number(rawVal) : null;
    const y = (val !== null && !isNaN(val)) ? (topPad + chartH - ((val - yMin) / (yMax - yMin)) * chartH) : null;
    // Format date as "Jun 24 10:00"
    const dObj = new Date(d.recorded_at);
    const dateStr = d.recorded_at ? dObj.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }) + ' ' + dObj.getHours().toString().padStart(2, '0') + ':00' : "";
    return { x, y, val, dateStr };
  });

  const validCoords = coords.filter(c => c.y !== null);
  let pathHtml = "";
  let dotsHtml = "";
  
  if (validCoords.length > 0) {
    const polyPoints = validCoords.map(c => `${c.x},${c.y}`).join(" ");
    const areaPath = `M ${validCoords[0].x},${topPad + chartH} ` + validCoords.map(c => `L ${c.x},${c.y}`).join(" ") + ` L ${validCoords[validCoords.length - 1].x},${topPad + chartH} Z`;
    
    pathHtml = `
      <path d="${areaPath}" fill="url(#detailGrad_${key})" />
      <polyline fill="none" stroke="#2C9AD1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${polyPoints}" />
    `;

    if (data.length <= 50) {
      dotsHtml = validCoords.map(c => `
        <circle cx="${c.x}" cy="${c.y}" r="1.5" fill="#FFFFFF" stroke="#1A6FA8" stroke-width="1.0" />
      `).join("");
      
      // X-axis labels for max 10 points
      const labelStep = Math.ceil(validCoords.length / 8);
      dotsHtml += validCoords.filter((_, i) => i % labelStep === 0).map(c => `
        <text x="${c.x}" y="${svgH - 5}" font-size="8.5" fill="#64748B" text-anchor="middle">${c.dateStr.split(' ')[0]}</text>
      `).join("");
    } else {
      // Just draw start and end dates
      const first = validCoords[0];
      const last = validCoords[validCoords.length - 1];
      dotsHtml = `
        <text x="${first.x}" y="${svgH - 5}" font-size="9" fill="#64748B" text-anchor="start">${first.dateStr.split(' ')[0]}</text>
        <text x="${last.x}" y="${svgH - 5}" font-size="9" fill="#64748B" text-anchor="end">${last.dateStr.split(' ')[0]}</text>
      `;
    }
  }

  return `
    <div style="border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; background: white; page-break-inside: avoid; margin-bottom: 20px;">
      <h4 style="font-size: 13px; font-weight: 700; color: #1E3A8A; margin: 0 0 10px 0;">${title}</h4>
      <svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="width:100%; height:${svgH}px; overflow:hidden;">
        <defs>
          <linearGradient id="detailGrad_${key}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2C9AD1" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#1A6FA8" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        ${gridLines}
        ${baseLine}
        ${pathHtml}
        ${dotsHtml}
      </svg>
    </div>
  `;
}

async function exportReportCSV() {
  const startDate = document.getElementById("reportStartDate").value;
  const endDate = document.getElementById("reportEndDate").value;
  if (!startDate || !endDate) {
    showToast("Invalid Dates", "Please select dates first.");
    return;
  }
  
  const formatRadio = document.querySelector('input[name="reportFormat"]:checked');
  const reportFormat = formatRadio ? formatRadio.value : "average";
  const locFilter = document.getElementById("reportLocationFilter").value;
  
  let currentUser = {};
  try {
    currentUser = JSON.parse(localStorage.getItem("user") || sessionStorage.getItem("user") || "{}");
  } catch(e) {}
  const role = (currentUser.role || "").toLowerCase();

  let htmlContent = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <style>
        table { border-collapse: collapse; font-family: 'Inter', Arial, sans-serif; width: 100%; margin-bottom: 20px; }
        th { background-color: #1A6FA8; color: #ffffff; padding: 12px; border: 1px solid #E2E8F0; text-align: left; font-size: 14px; font-weight: bold; }
        td { padding: 10px; border: 1px solid #E2E8F0; color: #334155; font-size: 13px; }
        .section-header { background-color: #F8FAFC; color: #1E3A8A; font-weight: bold; font-size: 16px; text-transform: uppercase; border-bottom: 2px solid #1A6FA8; padding: 15px; }
        .title-row td { background-color: #ffffff; padding: 20px 0; border: none; }
        .title { font-size: 24px; font-weight: bold; color: #1E3A8A; }
        .subtitle { font-size: 14px; color: #64748B; margin-top: 5px; }
      </style>
    </head>
    <body>
      <table>
        <tr class="title-row">
          <td colspan="6">
            <div class="title">AquaSense Water Analytics Report ${reportFormat === 'detailed' ? '(Detailed Timeline)' : ''}</div>
            <div class="subtitle">Generated: ${new Date().toLocaleString('en-PH')}</div>
            <div class="subtitle">Reporting Period: ${startDate} to ${endDate}</div>
          </td>
        </tr>
  `;

  if (reportFormat === "detailed") {
    try {
      showToast("Preparing Details", "Fetching timeline data...");
      let url = `/api/sensors?limit=10000&startDate=${startDate}&endDate=${endDate}`;
      if (locFilter) url += `&buildingId=${locFilter}`;
      
      const res = await apiGet(url);
      const readings = res.data || [];
      readings.reverse();
      
      htmlContent += `
        <tr><td colspan="6" class="section-header">DETAILED SENSOR TIMELINE</td></tr>
        <tr>
          <th>Timestamp</th>
          <th>pH Level</th>
          <th>Turbidity (NTU)</th>
          <th>TDS (ppm)</th>
          <th>Ammonia (mg/L)</th>
          <th>Temperature (°C)</th>
        </tr>
      `;
      
      readings.forEach(r => {
        const timeStr = r.recorded_at ? new Date(r.recorded_at).toLocaleString('en-PH') : "—";
        htmlContent += `
          <tr>
            <td>${timeStr}</td>
            <td>${r.ph_level !== null && r.ph_level !== undefined ? Number(r.ph_level).toFixed(2) : "—"}</td>
            <td>${r.turbidity !== null && r.turbidity !== undefined ? Number(r.turbidity).toFixed(2) : "—"}</td>
            <td>${r.tds !== null && r.tds !== undefined ? Number(r.tds).toFixed(0) : "—"}</td>
            <td>${r.ammonia !== null && r.ammonia !== undefined ? Number(r.ammonia).toFixed(3) : "—"}</td>
            <td>${r.temperature !== null && r.temperature !== undefined ? Number(r.temperature).toFixed(2) : "—"}</td>
          </tr>
        `;
      });
      
    } catch(err) {
      console.error(err);
      showToast("Error", "Could not fetch detailed data.");
      return;
    }
  } else {
    // AVERAGE SUMMARY
    const data = window.lastGeneratedReportData;
    if (!data) {
      showToast("No Data", "Please generate a preview before exporting.");
      return;
    }
    
    if (role === "hsu" || role === "admin") {
      const q = data.waterQuality || {};
      htmlContent += `
          <tr><td colspan="3" class="section-header">WATER QUALITY SUMMARY (HSU)</td></tr>
          <tr><th>Quality Parameter</th><th>Average Observed Value</th><th>Regulatory Breaches</th></tr>
          <tr><td>pH Level</td><td>${q.avg_ph !== null && q.avg_ph !== undefined ? Number(q.avg_ph).toFixed(2) : "—"}</td><td style="color:${q.ph_violations > 0 ? '#EF4444' : '#10B981'}; font-weight:bold;">${q.ph_violations || 0}</td></tr>
          <tr><td>Turbidity (NTU)</td><td>${q.avg_turbidity !== null && q.avg_turbidity !== undefined ? Number(q.avg_turbidity).toFixed(2) : "—"}</td><td style="color:${q.turbidity_violations > 0 ? '#EF4444' : '#10B981'}; font-weight:bold;">${q.turbidity_violations || 0}</td></tr>
          <tr><td>TDS (ppm)</td><td>${q.avg_tds !== null && q.avg_tds !== undefined ? Number(q.avg_tds).toFixed(0) : "—"}</td><td style="color:#10B981; font-weight:bold;">0</td></tr>
          <tr><td>Ammonia (mg/L)</td><td>${q.avg_ammonia !== null && q.avg_ammonia !== undefined ? Number(q.avg_ammonia).toFixed(3) : "—"}</td><td style="color:${q.ammonia_violations > 0 ? '#EF4444' : '#10B981'}; font-weight:bold;">${q.ammonia_violations || 0}</td></tr>
          <tr><td>Temperature (°C)</td><td>${q.avg_temperature !== null && q.avg_temperature !== undefined ? Number(q.avg_temperature).toFixed(2) : "—"}</td><td style="color:${q.temperature_violations > 0 ? '#EF4444' : '#10B981'}; font-weight:bold;">${q.temperature_violations || 0}</td></tr>
          <tr><td>Total Water Samples Analyzed</td><td><b>${q.total_readings || 0}</b></td><td></td></tr>
          <tr><td colspan="3" style="border:none; padding:15px;"></td></tr>
      `;
    }

    if (role === "gsu" || role === "admin") {
      const c = data.consumption || {};
      const m = data.maintenance || {};
      htmlContent += `
          <tr><td colspan="2" class="section-header">CONSUMPTION & OPERATIONS SUMMARY (GSU)</td></tr>
          <tr><th>Operational Metric</th><th>Consolidated Total / Average</th></tr>
          <tr><td>Total Water Consumption (Liters)</td><td><b>${c.total_consumed !== null && c.total_consumed !== undefined ? Number(c.total_consumed).toLocaleString() + " L" : "0 L"}</b></td></tr>
          <tr><td>Average Campus Flow Rate</td><td><b>${c.avg_flow_rate !== null && c.avg_flow_rate !== undefined ? Number(c.avg_flow_rate).toFixed(2) + " L/min" : "—"}</b></td></tr>
          <tr><td>Completed Maintenance Activities</td><td><b>${m.total_maintenance_logs || 0} repairs</b></td></tr>
      `;
    }
  }

  htmlContent += `
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([htmlContent], { type: 'application/vnd.ms-excel' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `AquaSense_Report_${startDate}_to_${endDate}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

window.loadReportsView = loadReportsView;
window.fetchReportPreview = fetchReportPreview;
window.exportReportPDF = exportReportPDF;
window.exportReportCSV = exportReportCSV;

async function generateReadingReport() {
  if (!window.currentReadingForReport) {
    alert("No reading selected.");
    return;
  }
  const reading = window.currentReadingForReport;
  const timeStr = reading.recorded_at ? new Date(reading.recorded_at).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
  const cls = reading.classification || {};
  const overrides = cls.triggered_overrides || [];
  
  let overrideHtml = '';
  if (overrides.length > 0) {
    overrideHtml = `<div style="background: #FEF2F2; border: 1.5px solid #FECACA; border-radius: 9px; padding: 10px 12px; font-size: 12px; color: #DC2626; margin-top: 15px;">
      <div style="font-weight: 700; margin-bottom: 2px;">⚠️ Safety Override Triggered</div>
      <div>${overrides.map(o => `• <strong>${o.label} Out of Range:</strong> ${o.reason} (Forced to: <span style="text-transform: capitalize;">${o.forced_level}</span>)`).join('<br/>')}</div>
    </div>`;
  }

  const preparedBy = document.getElementById("readingReportPreparedBy")?.value || "—";
  const notes = document.getElementById("readingReportNotes")?.value || "—";
  const generatedDate = new Date().toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

  const html = `
    <div style="font-family: 'Inter', sans-serif; color: #1E293B; width: 680px; box-sizing: border-box; padding: 30px; background: white;">
      
      <!-- Top Letterhead -->
      <div style="display: grid; grid-template-columns: 80px 1fr; gap: 20px; align-items: center; border-bottom: 2.5px solid #1A6FA8; padding-bottom: 20px; margin-bottom: 24px;">
        <div>
          <div style="width: 75px; height: 75px; border-radius: 8px; background: #1A6FA8; color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px;">
            CSPC
          </div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: flex-end;">
          <div>
            <h3 style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748B; margin: 0 0 4px 0; font-weight: 700;">
              Camarines Sur Polytechnic Colleges
            </h3>
            <h1 style="font-size: 22px; color: #111827; margin: 0; font-weight: 800; line-height: 1.2;">
              AquaSense Water Analytics
            </h1>
            <p style="font-size: 11px; color: #64748B; margin: 4px 0 0 0;">
              Nabua, Camarines Sur, Philippines
            </p>
          </div>
          <div style="text-align: right;">
            <span style="display: inline-block; background: rgba(44,154,209,0.1); color: #1A6FA8; font-size: 10px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase;">
              Reading Report
            </span>
            <p style="font-size: 11px; color: #64748B; margin: 8px 0 0 0;">
              Generated: ${generatedDate}
            </p>
          </div>
        </div>
      </div>

      <!-- Metadata -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; background: #F8FAFC; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
        <div>
          <div style="font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 700; margin-bottom: 4px;">Reading Details</div>
          <div style="font-size: 14px; font-weight: 600; color: #0F172A;">ID #${reading.id} — Device: ${reading.device_id}</div>
          <div style="font-size: 13px; color: #475569; margin-top: 2px;">${reading.building_name || 'No location'}</div>
        </div>
        <div>
          <div style="font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 700; margin-bottom: 4px;">Report Metadata</div>
          <div style="font-size: 13px; color: #475569; margin-bottom: 2px;"><strong>Recorded Time:</strong> ${timeStr}</div>
          <div style="font-size: 13px; color: #475569;"><strong>Prepared By:</strong> ${preparedBy}</div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
        <div style="border: 1px solid #E2E8F0; padding: 15px; border-radius: 8px;">
          <h4 style="margin: 0 0 10px 0; font-size: 14px; color: #475569; border-bottom: 1px solid #E2E8F0; padding-bottom: 6px;">Parameters</h4>
          <div style="display: flex; justify-content: space-between; margin: 6px 0;"><span style="color:#64748B;">pH Level</span> <strong>${Number(reading.ph_level).toFixed(2)} pH</strong></div>
          <div style="display: flex; justify-content: space-between; margin: 6px 0;"><span style="color:#64748B;">TDS (Solids)</span> <strong>${Number(reading.tds).toFixed(0)} ppm</strong></div>
          <div style="display: flex; justify-content: space-between; margin: 6px 0;"><span style="color:#64748B;">Ammonia</span> <strong>${Number(reading.ammonia).toFixed(2)} mg/L</strong></div>
          <div style="display: flex; justify-content: space-between; margin: 6px 0;"><span style="color:#64748B;">Turbidity</span> <strong>${Number(reading.turbidity).toFixed(2)} NTU</strong></div>
          <div style="display: flex; justify-content: space-between; margin: 6px 0;"><span style="color:#64748B;">Temperature</span> <strong>${Number(reading.temperature).toFixed(2)} °C</strong></div>
          <div style="display: flex; justify-content: space-between; margin: 6px 0;"><span style="color:#64748B;">Flow Rate</span> <strong>${Number(reading.flow_rate).toFixed(1)} L/min</strong></div>
        </div>
        <div style="border: 1px solid #E2E8F0; padding: 15px; border-radius: 8px;">
          <h4 style="margin: 0 0 10px 0; font-size: 14px; color: #475569; border-bottom: 1px solid #E2E8F0; padding-bottom: 6px;">Classification: <span style="text-transform: capitalize; color: #0F172A;">${cls.label || 'Safe'}</span></h4>
          <p style="margin: 6px 0; font-size: 13px;"><strong>Score:</strong> ${cls.score !== undefined ? cls.score + '/100' : '—'}</p>
          <p style="margin: 6px 0; font-size: 13px;"><strong>Recommended Uses:</strong><br/>${cls.recommended_use || '—'}</p>
          <p style="margin: 6px 0; font-size: 13px; color: #DC2626;"><strong>Not Recommended:</strong><br/>${cls.not_recommended || '—'}</p>
          <p style="margin: 6px 0; font-size: 13px;"><strong>Explanation:</strong><br/>${cls.explanation || '—'}</p>
        </div>
      </div>
      
      ${overrideHtml}

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #E2E8F0;">
        <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; color: #94A3B8; font-weight: 700;">Remarks & Notes</h4>
        <p style="margin: 0; font-size: 13px; color: #475569; white-space: pre-wrap;">${notes}</p>
      </div>
    </div>
  `;

  const opt = {
    margin: [0.5, 0.5],
    filename: `Reading_Report_${reading.id}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
  };
  await html2pdf().set(opt).from(html).save();
  try {
    await apiPost("/api/audit-logs/export", { action: "EXPORT_PDF", details: `Exported Reading Report PDF (ID: ${reading.id})` });
  } catch(e) { console.error(e); }
}

window.generateReadingReport = generateReadingReport;

