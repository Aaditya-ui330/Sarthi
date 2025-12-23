// /js/heatmap.js
// Very-bright infrared heatmap with optional spatial aggregation.
// - Uses leaflet.heat when available (include it in the page).
// - Falls back to circleMarkers if plugin missing.
// - Keeps CSV export, toggles, and UI wiring from original file.

import api from './api.js';

const DEFAULT_CENTER = [13.13, 77.57];
const DEFAULT_ZOOM = 16;
const MAP_ID = 'map';

// Toggle client-side aggregation when data is sparse.
// If true, nearby points are binned into grid cells and intensities summed.
const USE_AGGREGATION = false; // set true to enable aggregation for sparser datasets
const AGG_CELL_SIZE_DEG = 0.0015; // ~150m cell size (adjust by testing)

// Visual tuning constants (increase to get more saturated heat)
const VISUAL_AMPLIFIER = 2.0; // multiplies each point's intensity (makes colors bolder)
const MAX_INTENSITY_CLAMP = 4.0; // heat layer "max" should be >= this
const HEAT_LAYER_OPTIONS = {
  radius: 36,   // larger radius to combine points visually
  blur: 8,      // lower blur => sharper, punchier colors
  maxZoom: 17,
  max: MAX_INTENSITY_CLAMP
};

// Utility: color used in popups/markers (kept for fallback)
function scoreToColor(score) {
  const s = Math.max(0, Math.min(1, Number(score) || 0));
  const r = Math.round(Math.min(255, Math.max(0, 255 * (1 - s) * 1.6)));
  const g = Math.round(Math.min(255, Math.max(0, 255 * s * 1.2)));
  const b = 40;
  return `rgb(${r},${g},${b})`;
}

function scoreToPercentStr(score) {
  if (score === undefined || score === null || Number.isNaN(Number(score))) return '—';
  return `${(Number(score) * 100).toFixed(2)}%`;
}

function pointsToCSV(points) {
  const headers = ['lat', 'lng', 'score', 'samples', 'confidence'];
  const rows = points.map(p => [
    p.lat, p.lng, (p.score ?? ''), (p.samples ?? ''), (p.confidence ?? '')
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  return csv;
}

async function safeApiGet(path, params = {}) {
  return await api.get(path, { params });
}

function showMapScore(point) {
  const scoreEl = document.getElementById('scoreValue');
  const samplesEl = document.getElementById('scoreSamples');
  const mapScore = document.getElementById('mapScore');
  if (!mapScore) return;
  scoreEl && (scoreEl.innerText = (point.score !== undefined && point.score !== null) ? scoreToPercentStr(point.score) : '—');
  samplesEl && (samplesEl.innerText = `samples: ${point.samples ?? '—'}`);
  mapScore.style.display = 'block';
  mapScore.setAttribute('aria-hidden', 'false');
}

function hideMapScore() {
  const mapScore = document.getElementById('mapScore');
  if (!mapScore) return;
  mapScore.style.display = 'none';
  mapScore.setAttribute('aria-hidden', 'true');
}

function updateLeftFeedback(pts) {
  const feedbackEl = document.getElementById('formFeedback');
  if (!feedbackEl) return;
  const n = (pts && pts.length) || 0;
  let avg = null;
  if (n > 0) {
    const valid = pts.filter(p => p.score !== undefined && p.score !== null && !Number.isNaN(Number(p.score)));
    if (valid.length > 0) {
      const s = valid.reduce((acc, p) => acc + Number(p.score || 0), 0) / valid.length;
      avg = Number(s);
    }
  }
  feedbackEl.innerText = avg === null ? `${n} points loaded.` : `${n} points loaded. Avg score: ${scoreToPercentStr(avg)}`;
}

// Legend (brighter colors)
function addLegend(mapContainer) {
  if (!mapContainer) return;
  let legend = document.getElementById('infraLegend');
  if (legend) return;
  legend = document.createElement('div');
  legend.id = 'infraLegend';
  legend.style.position = 'absolute';
  legend.style.right = '12px';
  legend.style.bottom = '12px';
  legend.style.zIndex = 1500;
  legend.style.padding = '8px 12px';
  legend.style.borderRadius = '8px';
  legend.style.background = 'rgba(6,8,12,0.78)';
  legend.style.color = 'white';
  legend.style.fontSize = '13px';
  legend.style.boxShadow = '0 6px 20px rgba(0,0,0,0.6)';
  legend.innerHTML = `
    <div style="font-weight:600; margin-bottom:6px">Safety heat</div>
    <div style="display:flex; gap:8px; align-items:center">
      <div style="width:160px; height:12px; border-radius:6px; background: linear-gradient(90deg,
         rgba(25,30,70,0.18) 0%,
         #062e7a 15%,
         #0082a6 32%,
         #00c853 50%,
         #ffd600 68%,
         #ff6d00 85%,
         #ff1744 100%);"></div>
      <div style="min-width:70px; text-align:right; font-size:12px; opacity:0.95">hot → unsafe</div>
    </div>
  `;
  mapContainer.style.position = mapContainer.style.position || 'relative';
  mapContainer.appendChild(legend);
}

// Convert a backend row -> heat entry (lat,lng,intensity) with stronger scaling
function pointToHeatEntry(p) {
  if (!p) return null;
  const lat = Number(p.lat ?? p.latitude ?? p.lat_deg);
  const lng = Number(p.lng ?? p.longitude ?? p.lon ?? p.lng_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // invert safety score: high safety => low intensity
  const rawScore = (p.score !== undefined && p.score !== null) ? Number(p.score) : null;
  let intensity = rawScore === null ? 0.75 : Math.max(0, Math.min(1, 1.0 - rawScore));

  // amplify with samples: multi-sample locations should pop more
  const samples = Math.max(1, Number(p.samples ?? p.count ?? 1));
  const boost = Math.min(2.0, 0.45 + Math.log10(samples + 1) * 0.32); // stronger boost
  intensity = intensity * boost;

  // visual amplification: make colors bolder
  intensity = Math.max(0.01, Math.min(MAX_INTENSITY_CLAMP, intensity * VISUAL_AMPLIFIER));

  return { lat, lng, intensity, meta: { score: rawScore, samples, confidence: p.confidence ?? p.confidence_numeric ?? null } };
}

// Optional spatial aggregation (grid-based) — helps if data is sparse.
// Returns aggregated array [{lat,lng,intensity,count}, ...]
function aggregateByGrid(rows, cellSizeDeg = AGG_CELL_SIZE_DEG) {
  const cells = new Map();
  for (const r of rows) {
    const lat = Number(r.lat ?? r.latitude ?? r.lat_deg);
    const lng = Number(r.lng ?? r.longitude ?? r.lon ?? r.lng_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    // compute base intensity using same logic but without final clamp
    const rawScore = (r.score !== undefined && r.score !== null) ? Number(r.score) : null;
    let intensity = rawScore === null ? 0.75 : Math.max(0, Math.min(1, 1.0 - rawScore));
    const samples = Math.max(1, Number(r.samples ?? r.count ?? 1));
    const boost = Math.min(2.0, 0.45 + Math.log10(samples + 1) * 0.32);
    let pointIntensity = intensity * boost * VISUAL_AMPLIFIER;
    pointIntensity = Math.max(0.01, Math.min(MAX_INTENSITY_CLAMP, pointIntensity));

    const keyLat = Math.round(lat / cellSizeDeg) * cellSizeDeg;
    const keyLng = Math.round(lng / cellSizeDeg) * cellSizeDeg;
    const key = `${keyLat.toFixed(6)}:${keyLng.toFixed(6)}`;
    const cur = cells.get(key) || { latSum: 0, lngSum: 0, weightSum: 0, count: 0 };
    cur.latSum += lat * pointIntensity;
    cur.lngSum += lng * pointIntensity;
    cur.weightSum += pointIntensity;
    cur.count += 1;
    cells.set(key, cur);
  }

  const aggregated = [];
  for (const [k, v] of cells.entries()) {
    const avgLat = v.latSum / v.weightSum;
    const avgLng = v.lngSum / v.weightSum;
    const combinedIntensity = Math.min(MAX_INTENSITY_CLAMP, v.weightSum); // sum of intensities
    aggregated.push({ lat: avgLat, lng: avgLng, intensity: combinedIntensity, count: v.count });
  }
  return aggregated;
}

// Bright, saturated infrared gradient stops (0..1)
const INFRARED_GRADIENT = {
  0.0: 'rgba(25,30,70,0.18)',
  0.12: '#062e7a',
  0.28: '#0082a6',
  0.48: '#00c853',
  0.66: '#ffd600',
  0.85: '#ff6d00',
  1.0:  '#ff1744'
};

export async function initHeatmapPage({ band = 'night', min_samples = 1 } = {}) {
  const mapEl = document.getElementById(MAP_ID);
  if (!mapEl) {
    console.error(`#${MAP_ID} element not found in DOM`);
    return;
  }

  if (typeof L === 'undefined') {
    console.error('Leaflet (L) is not loaded. Include Leaflet before this module.');
    mapEl.innerText = 'Map initialization failed (Leaflet missing). Check console.';
    return;
  }

  if (window._sarthi_heatmap_controller) {
    window._sarthi_heatmap_params = { band, min_samples };
    if (window._sarthi_heatmap_controller && typeof window._sarthi_heatmap_controller.fetchAndRender === 'function') {
      await window._sarthi_heatmap_controller.fetchAndRender();
    }
    return window._sarthi_heatmap_controller;
  }

  // create map and base tiles
  const map = L.map(MAP_ID).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const markersLayer = L.layerGroup().addTo(map);
  let heatLayer = null;
  addLegend(mapEl);

  let lastFetchedPoints = [];

  function buildHeatArrayFromRows(rows) {
    if (!rows || !rows.length) return [];
    // optional aggregation
    if (USE_AGGREGATION) {
      const aggregated = aggregateByGrid(rows, AGG_CELL_SIZE_DEG);
      return aggregated.map(a => [a.lat, a.lng, a.intensity]);
    } else {
      const arr = [];
      for (const r of rows) {
        const p = pointToHeatEntry(r);
        if (!p) continue;
        arr.push([p.lat, p.lng, p.intensity]);
      }
      return arr;
    }
  }

  async function fetchAndRender({ band: b, min_samples: ms } = {}) {
    const params = { band: (b ?? band), min_samples: (ms ?? min_samples) };
    window._sarthi_heatmap_params = params;

    const bounds = map.getBounds();
    const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;

    const feedback = document.getElementById('formFeedback');
    if (feedback) feedback.innerText = 'Loading points...';

    try {
      const data = await safeApiGet('/heatmap_data', { band: params.band, min_samples: params.min_samples, bbox });
      const pts = Array.isArray(data) ? data : (data.points || data.data || []);
      lastFetchedPoints = pts;
      updateLeftFeedback(pts);

      const heatArr = buildHeatArrayFromRows(pts);

      // create/update heat layer
      if (typeof L.heatLayer === 'function') {
        if (!heatLayer) {
          heatLayer = L.heatLayer(heatArr, Object.assign({}, HEAT_LAYER_OPTIONS, { gradient: INFRARED_GRADIENT }));
          heatLayer.addTo(map);
        } else {
          if (typeof heatLayer.setLatLngs === 'function') heatLayer.setLatLngs(heatArr);
        }
        if (!map.hasLayer(heatLayer)) map.addLayer(heatLayer);
      } else {
        // fallback: draw circleMarkers
        markersLayer.clearLayers();
        pts.forEach(p => {
          if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
          const samples = Math.max(1, Number(p.samples || 1));
          const score = (p.score !== undefined && p.score !== null) ? Number(p.score) : null;
          let radius = 8 + Math.min(30, samples * 2);
          if (score !== null) radius += Math.round((score - 0.5) * 6);
          radius = Math.max(6, Math.min(40, radius));
          const color = scoreToColor(score ?? 0.5);
          const marker = L.circleMarker([p.lat, p.lng], {
            radius,
            fillColor: color,
            color: 'rgba(255,255,255,0.06)',
            weight: 1,
            fillOpacity: 0.95
          });
          const scoreTextPct = scoreToPercentStr(p.score);
          const samplesText = p.samples ?? '—';
          const confText = p.confidence ?? p.confidence_numeric ?? '—';
          const popupHtml = `<div style="min-width:160px">
            <div style="margin-bottom:6px"><strong>Safety:</strong> <span style="color:${color};font-weight:700">${scoreTextPct}</span></div>
            <div><strong>Samples:</strong> ${samplesText}</div>
            <div><strong>Confidence:</strong> ${confText}</div>
          </div>`;
          marker.bindPopup(popupHtml, { maxWidth: 260, closeButton: true });
          marker.on('click', () => showMapScore({ score: score, samples }));
          markersLayer.addLayer(marker);
        });
      }

      // Prepare compact markers for toggling/popups (always create, hidden by default if heat present)
      markersLayer.clearLayers();
      pts.forEach(p => {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
        const popupHtml = `<div style="min-width:160px">
            <div style="margin-bottom:6px"><strong>Safety:</strong> ${scoreToPercentStr(p.score)}</div>
            <div><strong>Samples:</strong> ${p.samples ?? '—'}</div>
          </div>`;
        const color = scoreToColor(p.score ?? 0.5);
        const m = L.circleMarker([p.lat, p.lng], {
          radius: 6,
          fillColor: color,
          color: 'rgba(0,0,0,0.15)',
          weight: 1,
          fillOpacity: 0.95
        });
        m.bindPopup(popupHtml);
        m.on('click', () => showMapScore({ score: p.score, samples: p.samples }));
        markersLayer.addLayer(m);
      });

      // hide markers when heat is active so map shows heat only
      if (heatLayer && map.hasLayer(markersLayer)) map.removeLayer(markersLayer);

      return pts;
    } catch (err) {
      console.error('Failed to fetch heatmap data', err);
      if (feedback) feedback.innerText = `Failed to load data: ${err.message || err}`;
      throw err;
    }
  }

  const controller = {
    map,
    markersLayer,
    get lastFetchedPoints() { return lastFetchedPoints; },

    fetchAndRender,

    toggleMarkers() {
      if (map.hasLayer(markersLayer)) map.removeLayer(markersLayer);
      else map.addLayer(markersLayer);
    },

    resetView() {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    },

    exportCSV() {
      if (!lastFetchedPoints || !lastFetchedPoints.length) {
        alert('No data to export.');
        return;
      }
      const csv = pointsToCSV(lastFetchedPoints);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `heatmap_points_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  };

  window._sarthi_heatmap_map = map;
  window._sarthi_heatmap_controller = controller;
  window._sarthi_heatmap_params = { band, min_samples };

  let fetchTimeout = null;
  map.on('moveend', () => {
    if (fetchTimeout) clearTimeout(fetchTimeout);
    fetchTimeout = setTimeout(() => controller.fetchAndRender(), 300);
  });

  // Wire DOM controls if present
  try {
    const bandSelect = document.getElementById('bandSelect');
    const samplesRange = document.getElementById('samplesRange');
    const applyBtn = document.getElementById('applyBtn');
    const toggleBtn = document.getElementById('toggleMarkers');
    const resetBtn = document.getElementById('resetView');
    const downloadBtn = document.getElementById('downloadBtn');
    const samplesValue = document.getElementById('samplesValue');

    if (samplesRange && samplesValue) {
      samplesRange.addEventListener('input', (e) => { samplesValue.innerText = e.target.value; });
    }

    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        const b = bandSelect ? bandSelect.value : band;
        const ms = samplesRange ? Number(samplesRange.value) : min_samples;
        await controller.fetchAndRender({ band: b, min_samples: ms });
      });
    }

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => controller.toggleMarkers());
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => controller.resetView());
    }

    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => controller.exportCSV());
    }

    map.on('click', () => {
      setTimeout(() => {
        const popup = document.querySelector('.leaflet-popup');
        if (!popup) hideMapScore();
      }, 10);
    });

  } catch (e) {
    console.warn('Error wiring DOM controls', e);
  }

  try {
    await controller.fetchAndRender();
  } catch (e) { /* logged */ }

  return controller;
}

// Auto-run on import if #map exists
(async () => {
  const mapEl = document.getElementById(MAP_ID);
  if (mapEl) {
    window.requestAnimationFrame(() => {
      initHeatmapPage().catch(e => console.error('initHeatmapPage failed', e));
    });
  } else {
    console.warn(`#${MAP_ID} element not found — heatmap module did not initialize.`);
  }
})();
