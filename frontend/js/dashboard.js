// /frontend/js/dashboard.js
// Dashboard logic (merged) — includes audits-per-month canvas chart
// Uses Firebase auth helpers exported from /js/auth.js

import api from '/js/api.js';
import { getIdToken, getStoredUser, logout, onAuthReady } from '/js/auth.js';

const $ = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

let map = null;
let markersLayer = null;

/* -------------------------
   Small utilities
   ------------------------- */
async function waitForHeader(timeoutMs = 2000) {
  const container = el('header');
  if (!container) return;
  const start = Date.now();
  while (!container.innerHTML && (Date.now() - start < timeoutMs)) {
    await new Promise(r => setTimeout(r, 60));
  }
}

async function authFetchJson(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  try {
    const token = await getIdToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch (e) { /* ignore token errors */ }
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (!res.ok) {
    const text = await res.text().catch(() => null);
    const err = new Error(text || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text().catch(() => null);
}

/* -------------------------
   API helpers
   ------------------------- */
async function fetchUserAudits() {
  // Now automatically uses correct headers and endpoint
  return await api.get('/user/audits');
}

/* -------------------------
   Table + Stats + Map rendering
   ------------------------- */
function renderStats(audits = []) {
  const totalEl = el('totalAudits');
  const areasEl = el('areasMapped');
  if (totalEl) totalEl.textContent = audits.length || 0;
  if (areasEl) {
    const areas = new Set((audits||[]).map(a => {
      const lat = (a.lat ?? a.latitude ?? 0);
      const lng = (a.lng ?? a.longitude ?? 0);
      return `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
    }));
    areasEl.textContent = areas.size;
  }
}

function renderAuditsTable(audits = []) {
  const tbody = document.querySelector('#auditsTable tbody');
  const auditsEmpty = el('auditsEmpty');
  const auditsTable = el('auditsTable');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!audits || audits.length === 0) {
    if (auditsEmpty) auditsEmpty.style.display = 'block';
    if (auditsTable) auditsTable.style.display = 'none';
    return;
  }
  if (auditsEmpty) auditsEmpty.style.display = 'none';
  if (auditsTable) auditsTable.style.display = 'table';

  // newest first
  audits.sort((a,b) => {
    const ta = a.timestamp ? a.timestamp : (a.created_at ? new Date(a.created_at).getTime()/1000 : 0);
    const tb = b.timestamp ? b.timestamp : (b.created_at ? new Date(b.created_at).getTime()/1000 : 0);
    return tb - ta;
  }).slice(0, 200).forEach(a => {
    const tr = document.createElement('tr');
    const when = a.timestamp ? new Date(a.timestamp * 1000).toLocaleString() :
                 (a.created_at ? new Date(a.created_at).toLocaleString() : '—');
    const lat = (typeof a.lat === 'number') ? a.lat.toFixed(5) : (a.latitude ?? '—');
    const lng = (typeof a.lng === 'number') ? a.lng.toFixed(5) : (a.longitude ?? '—');
    const score = (a.safety_score !== undefined && a.safety_score !== null)
              ? (Number(a.safety_score) * 100).toFixed(1) + '%'
              : (a.calculated_score !== undefined && a.calculated_score !== null)
                ? (Number(a.calculated_score) * 100).toFixed(1) + '%'
                : (a.score !== undefined ? (Number(a.score) * 100).toFixed(1) + '%' : '—')
    tr.innerHTML = `<td>${when}</td><td>${lat}</td><td>${lng}</td><td>${score}</td>`;
    tbody.appendChild(tr);
  });
}

function initMap() {
  const mapContainer = el('userMap');
  if (!mapContainer) return;
  if (!window.L) {
    mapContainer.textContent = 'Leaflet not loaded. Please include Leaflet library.';
    return;
  }
  map = L.map('userMap', { center: [20.5937, 78.9629], zoom: 5, scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function renderOnMap(audits = []) {
  if (!map || !markersLayer) return;
  markersLayer.clearLayers();
  const bounds = [];
  for (const a of audits) {
    const lat = (typeof a.lat === 'number') ? a.lat : (typeof a.latitude === 'number' ? a.latitude : null);
    const lng = (typeof a.lng === 'number') ? a.lng : (typeof a.longitude === 'number' ? a.longitude : null);
    if (lat === null || lng === null) continue;
    const rawVal =
      a.safety_score ??
      a.calculated_score ??
      a.score ??
      a.safety ??      // alternate field names
      a.severity ??    // your synthetic generator uses 'severity' = 1 - p_safe
      null;

    // helper: convert whatever we got into a fraction in 0..1 (or null)
    function toFraction(value) {
      if (value === undefined || value === null) return null;
      const n = Number(value);
      if (Number.isNaN(n)) return null;
      // if number looks already like a fraction (<=1.5) treat as fraction,
      // otherwise treat as percent (e.g. 49.7 -> 0.497)
      if (Math.abs(n) <= 1.5) {
        return Math.max(0, Math.min(1, n));
      }
      return Math.max(0, Math.min(1, n / 100));
    }

    const frac = toFraction(rawVal);
    // format percent string with TWO decimals (Option E)
    const displayScore = (frac === null) ? '—' : ( (frac * 100).toFixed(2) + '%' );

    // color based on fraction (fallback neutral when unknown)
    const color = (frac === null) ? '#888' : (frac > 0.66 ? '#20c997' : (frac > 0.33 ? '#ffbf00' : '#ff6b6b'));

    // you can scale radius optionally using frac or leave fixed
    const m = L.circleMarker([lat, lng], {
      radius: 7,
      fillColor: color,
      color: '#fff',
      weight: 1,
      fillOpacity: 0.9
    });

    const when = a.timestamp ? new Date(a.timestamp*1000).toLocaleString() : (a.created_at ? new Date(a.created_at).toLocaleString() : '—');
    m.bindPopup(`<strong>Score:</strong> ${displayScore}<br><strong>When:</strong> ${when}`);
    m.addTo(markersLayer);
    bounds.push([lat, lng]);
  }
  if (bounds.length) {
    try {
      map.fitBounds(bounds, { padding: [20,20], maxZoom: 15 });
    } catch (e) {
      console.warn('map.fitBounds failed', e);
    }
  }
}

/* -------------------------
   Export CSV
   ------------------------- */
async function exportCSV() {
  try {
    const audits = await fetchUserAudits();
    if (!audits || audits.length === 0) {
      alert('No audits to export');
      return;
    }
    const header = ['timestamp','lat','lng','score','notes'];
    const rows = audits.map(a => {
      const when = a.timestamp ? new Date(a.timestamp*1000).toISOString() : (a.created_at ? new Date(a.created_at).toISOString() : '');
      const lat = a.lat ?? a.latitude ?? '';
      const lng = a.lng ?? a.longitude ?? '';
      const score = a.calculated_score ?? a.score ?? '';
      const notes = (a.notes || a.comment || '').replace(/"/g,'""').replace(/\n/g,' ');
      return [when, lat, lng, score, notes];
    });
    const csv = [header.join(','), ...rows.map(r => r.map(col => `"${String(col).replace(/"/g,'""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audits_export_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Export failed: ' + (err.message || 'unknown'));
    console.error(err);
  }
}

/* -------------------------
   Chart: audits-per-month (vanilla canvas)
   ------------------------- */
function getAuditTimestamp(a) {
  if (a.timestamp && typeof a.timestamp === 'number') return a.timestamp * 1000;
  if (a.created_at) {
    const t = Date.parse(a.created_at);
    if (!isNaN(t)) return t;
  }
  return null;
}

function monthLabelsLastN(n = 12) {
  const labels = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; --i) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push({ key: `${d.getFullYear()}-${d.getMonth()+1}`, label: d.toLocaleString(undefined, {month: 'short', year: 'numeric'}) });
  }
  return labels;
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  if (typeof radius === 'undefined') radius = 5;
  if (typeof radius === 'number') radius = { tl: radius, tr: radius, br: radius, bl: radius };
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + width - radius.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
  ctx.lineTo(x + width, y + height - radius.br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
  ctx.lineTo(x + radius.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawMonthlyAuditChart(canvasId = 'auditsChart', audits = []) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  // prepare 12-month buckets
  const months = monthLabelsLastN(12); // [{key,label},...]
  const counts = new Array(months.length).fill(0);

  const now = Date.now();
  for (const a of audits) {
    const tms = getAuditTimestamp(a);
    if (!tms) continue;
    if (tms > now) continue;
    const d = new Date(tms);
    const key = `${d.getFullYear()}-${d.getMonth()+1}`;
    const idx = months.findIndex(m => m.key === key);
    if (idx >= 0) counts[idx]++;
  }

  // canvas sizing for crisp rendering on HiDPI
  const DPR = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width || 800;
  const h = canvas.clientHeight || canvas.height || 140;
  canvas.width = Math.floor(w * DPR);
  canvas.height = Math.floor(h * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // chart layout
  const padding = { left: 36, right: 12, top: 12, bottom: 28 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;
  const maxCount = Math.max(1, ...counts);
  const barGap = 8;
  const barWidth = (chartW - (counts.length - 1) * barGap) / counts.length;

  // grid lines (horizontal)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gridLines = 3;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (i / gridLines) * chartH;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartW, y);
  }
  ctx.stroke();

  // bars
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    const x = padding.left + i * (barWidth + barGap);
    const hBar = (c / maxCount) * chartH;
    const y = padding.top + chartH - hBar;

    // gradient fill using CSS variables (fallbacks)
    const root = getComputedStyle(document.documentElement);
    const primary = root.getPropertyValue('--primary') || '#5c6cff';
    const accent = root.getPropertyValue('--accent') || '#7b6cff';
    const grad = ctx.createLinearGradient(x, y, x, y + hBar || 1);
    grad.addColorStop(0, accent.trim());
    grad.addColorStop(1, primary.trim());

    const radius = 6;
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, barWidth, hBar, radius, true, false);
  }

  // X labels (month short)
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial';
  ctx.textAlign = 'center';
  for (let i = 0; i < months.length; i++) {
    const x = padding.left + i * (barWidth + barGap) + barWidth / 2;
    const label = months[i].label.split(' ')[0]; // short month
    ctx.fillText(label, x, padding.top + chartH + 16);
  }

  // small count on right top
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto';
  ctx.textAlign = 'right';
  ctx.fillText(String(maxCount), padding.left + chartW, padding.top - 2);
}

/* -------------------------
   Boot
   ------------------------- */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Wait for Firebase Auth to be fully initialized (prevents premature API calls!)
    await onAuthReady();
    let storedUser = getStoredUser();
    if (!storedUser) {
      window.location.href = '/auth.html?next=' + encodeURIComponent(window.location.pathname);
      return;
    }

    // Populate profile UI safely
    const nameEl = el('userName');
    if (nameEl) nameEl.textContent = storedUser.name || 'User';
    const emailEl = el('userEmail');
    if (emailEl) emailEl.textContent = storedUser.email || '';
    const avatarEl = el('avatarImg');
    if (avatarEl && storedUser.picture) avatarEl.src = storedUser.picture;

    // Wire profile signout button
    const btnLogout = el('btnLogout');
    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        try { await logout(); } catch (e) { /* ignore */ }
        window.location.href = '/';
      });
    }

    // Wire export button
    const btnExport = el('btnExport');
    if (btnExport) btnExport.addEventListener('click', exportCSV);

    // Init map (leaflet must be loaded in the page)
    try {
      initMap();
    } catch (e) {
      console.warn('initMap error', e);
      const um = el('userMap');
      if (um) um.textContent = 'Map cannot be initialized.';
    }

    // Fetch and render audits
    let audits = [];
    try {
      audits = await fetchUserAudits();
      if (!Array.isArray(audits)) audits = [];
      renderStats(audits);
      renderAuditsTable(audits);
      try { drawMonthlyAuditChart('auditsChart', audits); } catch (e) { console.warn('chart draw failed', e); }
      renderOnMap(audits);
    } catch (err) {
      console.error('Failed loading audits', err);
      if (err && err.status === 401) {
        window.location.href = '/auth.html?next=' + encodeURIComponent(window.location.pathname);
        return;
      }
      renderStats([]);
      renderAuditsTable([]);
      const emptyEl = el('auditsEmpty');
      if (emptyEl) {
        emptyEl.style.display = 'block';
        emptyEl.textContent = 'Could not load your audits. Try again later.';
      }
    }
  } catch (e) {
    console.error('Dashboard initialization error', e);
  }
});