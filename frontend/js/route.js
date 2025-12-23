// /js/route.js
// Map + safe-route UI. Uses /js/api.js for backend calls and Nominatim for geocoding.
// Updated: cleaned, small toggle animation added.

import api from './api.js';

const DEFAULT_CENTER = [12.97, 77.59];
const DEFAULT_ZOOM = 13;
const MAP_ID = 'map';

/* -------------------------
   Small helpers
   ------------------------- */

const debounce = (fn, wait = 220) => {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
};

const parseLatLngPair = (str) => {
  if (!str) return null;
  const parts = String(str).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const lat = Number(parts[0]), lng = Number(parts[1]);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return [lat, lng];
};

const getCurrentTimeBand = () => {
  const h = new Date().getHours();
  if (h >= 0 && h <= 3) return 'midnight';
  if (h >= 4 && h <= 11) return 'morning';
  if (h >= 12 && h <= 16) return 'afternoon';
  if (h >= 17 && h <= 20) return 'evening';
  return 'night';
};

/* -------------------------
   Geocoding & suggestions (Nominatim)
   ------------------------- */

async function geocodeAddress(address, { limit = 1 } = {}) {
  if (!address) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=${limit}&q=${encodeURIComponent(address)}`;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }});
    const data = await r.json();
    if (!data || data.length === 0) return null;
    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  } catch (e) {
    console.warn('geocodeAddress error', e);
    return null;
  }
}

async function suggestAddresses(query, { limit = 5 } = {}) {
  if (!query || query.trim().length < 1) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=${limit}&q=${encodeURIComponent(query)}`;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }});
    const data = await r.json();
    return (data || []).map(item => ({ name: item.display_name, lat: item.lat, lon: item.lon }));
  } catch (e) {
    console.warn('suggestAddresses error', e);
    return [];
  }
}

/* -------------------------
   Autocomplete UI
   ------------------------- */

window._sarthi_open_suggestions = window._sarthi_open_suggestions || [];

function attachAutocompleteToInput(inputEl, suggestionsElId, onSelect) {
  if (!inputEl) return null;
  const parent = inputEl.parentElement || document.body;
  let suggestionsEl = document.getElementById(suggestionsElId);
  if (!suggestionsEl) {
    suggestionsEl = document.createElement('div');
    suggestionsEl.id = suggestionsElId;
    suggestionsEl.className = 'suggestions';
    parent.appendChild(suggestionsEl);
  }

  // base styles (kept here to ensure position/width match even if CSS missing)
  Object.assign(suggestionsEl.style, {
    position: 'absolute',
    zIndex: 60,
    display: 'none',
    maxHeight: '220px',
    overflow: 'auto',
    minWidth: Math.max(280, inputEl.offsetWidth) + 'px'
  });

  const render = (items) => {
    suggestionsEl.innerHTML = '';
    if (!items || items.length === 0) { suggestionsEl.style.display = 'none'; return; }
    items.forEach(it => {
      const d = document.createElement('div');
      d.className = 'suggestion-item';
      d.innerText = it.name;
      d.style.padding = '8px 10px';
      d.style.cursor = 'pointer';
      d.addEventListener('click', () => {
        inputEl.value = it.name;
        suggestionsEl.style.display = 'none';
        if (typeof onSelect === 'function') onSelect(it.name, [parseFloat(it.lat), parseFloat(it.lon)]);
      });
      suggestionsEl.appendChild(d);
    });
    suggestionsEl.style.display = 'block';
  };

  const doSuggest = debounce(async (q) => {
    if (!q || q.trim().length < 2) { render([]); return; }
    const list = await suggestAddresses(q);
    render(list);
  }, 180);

  inputEl.addEventListener('input', (ev) => doSuggest(ev.target.value));
  inputEl.addEventListener('focus', () => { if (suggestionsEl.innerHTML.trim()) suggestionsEl.style.display = 'block'; });
  inputEl.addEventListener('blur', () => setTimeout(() => suggestionsEl.style.display = 'none', 180));

  // register globally for closing
  window._sarthi_open_suggestions.push(suggestionsEl);

  return { container: suggestionsEl, close: () => { suggestionsEl.style.display = 'none'; } };
}

function closeAllSuggestionDropdowns() {
  if (!window._sarthi_open_suggestions) return;
  window._sarthi_open_suggestions.forEach(el => { try { el.style.display = 'none'; } catch(e) {} });
}

/* -------------------------
   Map & UI initialization
   ------------------------- */

export async function initRoutePage() {
  if (!document.getElementById(MAP_ID)) {
    console.error(`#${MAP_ID} not found in DOM`);
    return;
  }
  if (typeof L === 'undefined') {
    console.error('Leaflet not loaded');
    document.getElementById(MAP_ID).innerText = 'Map initialization failed (Leaflet missing). Check console.';
    return;
  }
  if (window._sarthi_route_controller) return window._sarthi_route_controller;

  const map = L.map(MAP_ID, { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

  const layers = {
    startMarker: null,
    endMarker: null,
    candidates: L.layerGroup().addTo(map),
    best: L.layerGroup().addTo(map),
  };
  let picking = null;

  // DOM
  const startInput = document.getElementById('startInput');
  const endInput = document.getElementById('endInput');
  const pickStartBtn = document.getElementById('pickStart');
  const pickEndBtn = document.getElementById('pickEnd');
  const routeBtn = document.getElementById('routeBtn');
  const routeInfo = document.getElementById('routeInfo') || null;
  const feedback = document.getElementById('routeFeedback') || null;
  const bandSelect = document.getElementById('bandSelect');
  const useCurrentBtn = document.getElementById('useCurrentBtn');

  const setFeedback = (msg) => { if (feedback) feedback.innerText = msg; else console.log('route feedback:', msg); };
  const setRouteInfo = (html) => { if (routeInfo) routeInfo.innerHTML = html; else console.log('routeInfo:', html); };

  const addStartMarker = (latlng) => { if (layers.startMarker) map.removeLayer(layers.startMarker); layers.startMarker = L.marker(latlng, { title: 'Start' }).addTo(map); };
  const addEndMarker = (latlng) => { if (layers.endMarker) map.removeLayer(layers.endMarker); layers.endMarker = L.marker(latlng, { title: 'End' }).addTo(map); };
  const clearRoutes = () => { layers.candidates.clearLayers(); layers.best.clearLayers(); };

  // preselect time band if present
  try { if (bandSelect) { const cur = getCurrentTimeBand(); if ([...bandSelect.options].some(o => o.value === cur)) bandSelect.value = cur; } } catch (e) { /* ignore */ }

  // autocomplete attachments
  attachAutocompleteToInput(startInput, 'startSuggestions', (name, coords) => { if (coords) { addStartMarker(coords); map.setView(coords, 15); } });
  attachAutocompleteToInput(endInput, 'endSuggestions', (name, coords) => { if (coords) { addEndMarker(coords); map.setView(coords, 15); } });

  // handle ?query=... prefill
  (async () => {
    try {
      const url = new URL(window.location.href);
      const q = url.searchParams.get('query') || '';
      if (!q) return;
      if (endInput) endInput.value = decodeURIComponent(q);
      const coords = await geocodeAddress(q);
      if (coords) { addEndMarker(coords); map.setView(coords, 15); }
    } catch (e) { /* ignore */ }
  })();

  // use current location
  if (useCurrentBtn) {
    useCurrentBtn.addEventListener('click', () => {
      setFeedback('Obtaining current location…');
      if (!navigator.geolocation) return setFeedback('Geolocation not supported by your browser.');
      navigator.geolocation.getCurrentPosition((pos) => {
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        if (startInput) startInput.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        addStartMarker([lat, lon]);
        map.setView([lat, lon], 15);
        setFeedback('');
      }, (err) => setFeedback('Unable to get current location: ' + (err.message || err.code)), { enableHighAccuracy: true, timeout: 10000 });
    });
  }

  /* Evaluate routes — uses api.get('/safe_route', { params }) */
  async function evaluateRoutes(start, end, opts = {}) {
    setFeedback('Evaluating routes...');
    clearRoutes();

    const params = {
      start_lat: String(start[0]),
      start_lng: String(start[1]),
      end_lat: String(end[0]),
      end_lng: String(end[1]),
      band: opts.band || (bandSelect?.value || getCurrentTimeBand()),
      step_m: opts.step_m || 50
    };

    try {
      const res = await api.get('/safe_route', { params });

      // --------- Directions rendering (DOM-based, safe) ----------
      const steps = res.best_steps || [];
      // find/create panel
      let container = document.getElementById('routeSteps');
      if (!container) {
        container = document.createElement('div');
        container.id = 'routeSteps';
        container.className = 'route-steps card';
        const left = document.querySelector('.left-panel') || document.querySelector('.route-left-panel') || document.querySelector('aside') || document.body;
        left.appendChild(container);
      }
      // reset
      container.innerHTML = '';

      // header
      const header = document.createElement('div');
      header.className = 'route-steps-header';
      const title = document.createElement('h3'); title.innerText = 'Directions';
      header.appendChild(title);
      const meta = document.createElement('div'); meta.className = 'route-steps-meta';
      if (res.best_distance != null) {
        const d = document.createElement('span'); d.innerText = `Distance: ${Math.round(res.best_distance)} m`; meta.appendChild(d);
      }
      if (res.best_duration != null) {
        const dur = document.createElement('span'); dur.style.marginLeft = '10px';
        dur.innerText = `Duration: ${Math.round((res.best_duration || 0) / 60)} min`; meta.appendChild(dur);
      }
      header.appendChild(meta);
      container.appendChild(header);

      // steps content
      if (!steps || steps.length === 0) {
        const noSteps = document.createElement('div');
        noSteps.style.padding = '8px';
        noSteps.innerText = 'No directions available.';
        container.appendChild(noSteps);
      } else {
        // enhancement: toggle, build list
        (function enhanceRouteStepsUI() {
          // scoped toggle element (id used for single global toggle)
          let toggle = document.getElementById('routeStepsToggle');
          if (!toggle) {
            toggle = document.createElement('button');
            toggle.id = 'routeStepsToggle';
            toggle.type = 'button';
            toggle.innerText = 'Collapse';
            toggle.style.marginLeft = '8px';
            toggle.style.cursor = 'pointer';
            const hdr = container.querySelector('.route-steps-header');
            if (hdr) hdr.appendChild(toggle);
          }

          // animation helper (tiny scale + color flash)
          const animateToggle = (el, expanding) => {
            try {
              // scale pulse
              el.animate(
                [{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }, { transform: 'scale(1)' }],
                { duration: 180, easing: 'ease-out' }
              );
              // short background flash (non-intrusive)
              const origBg = el.style.backgroundColor;
              el.style.transition = 'background-color 220ms ease';
              el.style.backgroundColor = expanding ? 'rgba(124,92,255,0.06)' : 'rgba(124,92,255,0.03)';
              setTimeout(() => { el.style.backgroundColor = origBg || 'transparent'; }, 220);
            } catch (err) { /* ignore */ }
          };

          toggle.addEventListener('click', () => {
            const isCollapsed = container.classList.toggle('collapsed');
            toggle.innerText = isCollapsed ? 'Expand' : 'Collapse';
            animateToggle(toggle, !isCollapsed);
            if (!isCollapsed) container.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });

          // build list
          const list = document.createElement('ol');
          list.className = 'route-steps-list';
          list.style.listStyle = 'none';
          list.style.margin = '0';
          list.style.padding = '0';

          steps.forEach((s, i) => {
            const li = document.createElement('li');
            li.className = 'route-step-item';

            const num = document.createElement('div');
            num.className = 'route-step-num'; num.innerText = (i + 1);

            const textWrap = document.createElement('div');
            textWrap.style.display = 'flex'; textWrap.style.flexDirection = 'column';

            const text = document.createElement('div');
            text.className = 'route-step-text';
            let instr = '';
            if (s.instruction && String(s.instruction).trim()) instr = String(s.instruction).trim();
            else {
              const m = s.maneuver || {};
              instr = (m.type ? String(m.type) : '') + (m.modifier ? ' ' + String(m.modifier) : '');
              if (s.name) instr += (instr ? ' onto ' : '') + String(s.name);
            }
            text.innerText = instr || '(continue)';

            if (s.name) {
              const road = document.createElement('span');
              road.className = 'route-step-road';
              road.innerText = s.name;
              textWrap.appendChild(text);
              textWrap.appendChild(road);
            } else {
              textWrap.appendChild(text);
            }

            const metaDiv = document.createElement('div'); metaDiv.className = 'route-step-meta';
            const dist = document.createElement('div'); dist.innerText = s.distance ? `${Math.round(s.distance)} m` : '';
            metaDiv.appendChild(dist);

            li.appendChild(num); li.appendChild(textWrap); li.appendChild(metaDiv);

            li.addEventListener('click', () => {
              const maneuver = s.maneuver || {};
              const loc = maneuver.location || null;
              if (Array.isArray(loc) && loc.length >= 2) {
                const latlng = [loc[1], loc[0]];
                try { window._sarthi_route_controller?.map.setView(latlng, 17); } catch (e) {}
              }
            });

            list.appendChild(li);
          });

          const old = container.querySelector('.route-steps-list');
          if (old) old.replaceWith(list); else container.appendChild(list);

          let footer = container.querySelector('.route-steps-footer');
          if (!footer) {
            footer = document.createElement('div');
            footer.className = 'route-steps-footer';
            container.appendChild(footer);
          }
          footer.innerText = `Showing ${steps.length} steps`;

          // default collapsed for long lists
          if (steps.length > 6) {
            container.classList.add('collapsed');
            toggle.innerText = 'Expand';
          } else {
            container.classList.remove('collapsed');
            toggle.innerText = 'Collapse';
          }
        })();
      }

      // --------- draw routes on map ----------
      const evals = res.all_evaluations || [];
      const bestRoute = res.best_route || null;

      evals.forEach((ev) => {
        const pts = ev.route;
        if (!Array.isArray(pts) || pts.length === 0) return;
        const latlngs = pts.map(p => Array.isArray(p) ? p : [p.lat, p.lng]);
        const poly = L.polyline(latlngs, {
          weight: 5,
          opacity: 0.9,
          color: (ev.eval?.avg_score ?? 0) >= 0.66 ? 'var(--success)' : ((ev.eval?.avg_score ?? 0) >= 0.33 ? '#ffbf00' : 'var(--danger)')
        });
        layers.candidates.addLayer(poly);
      });

      if (bestRoute && Array.isArray(bestRoute) && bestRoute.length) {
        const latlngs = bestRoute.map(p => Array.isArray(p) ? p : [p.lat, p.lng]);
        const bestPoly = L.polyline(latlngs, {
          weight: 8,
          opacity: 1,
          color: getComputedStyle(document.documentElement).getPropertyValue('--primary') || '#4ea8ff'
        });
        bestPoly.bindPopup('<strong>Best route</strong>');
        layers.best.addLayer(bestPoly);
        try { map.fitBounds(L.latLngBounds(latlngs).pad(0.1)); } catch (e) {}
        setRouteInfo(`<strong>Best route</strong><br>Score: ${res.best_eval?.avg_score ?? 'N/A'}`);
      } else {
        try { map.fitBounds([start, end]); } catch (e) {}
        setRouteInfo('No best route returned');
      }

      setFeedback('Route evaluation complete.');
      return res;
    } catch (err) {
      console.error('safe_route error', err);
      setFeedback('Failed to compute route: ' + (err.message || err));
      throw err;
    }
  }

  // map click handler for picking
  map.on('click', (e) => {
    if (!picking) return;
    const latlng = [e.latlng.lat, e.latlng.lng];
    if (picking === 'start') {
      if (startInput) startInput.value = `${latlng[0].toFixed(6)}, ${latlng[1].toFixed(6)}`;
      addStartMarker(latlng);
    } else if (picking === 'end') {
      if (endInput) endInput.value = `${latlng[0].toFixed(6)}, ${latlng[1].toFixed(6)}`;
      addEndMarker(latlng);
    }
    picking = null;
    if (pickStartBtn) pickStartBtn.setAttribute('aria-pressed', 'false');
    if (pickEndBtn) pickEndBtn.setAttribute('aria-pressed', 'false');
  });

  if (pickStartBtn) pickStartBtn.addEventListener('click', () => { picking = 'start'; pickStartBtn.setAttribute('aria-pressed', 'true'); setFeedback('Click on the map to pick START point.'); });
  if (pickEndBtn) pickEndBtn.addEventListener('click', () => { picking = 'end'; pickEndBtn.setAttribute('aria-pressed', 'true'); setFeedback('Click on the map to pick END point.'); });

  if (routeBtn) {
    routeBtn.addEventListener('click', async () => {
      closeAllSuggestionDropdowns();
      const startStr = startInput?.value?.trim();
      const endStr = endInput?.value?.trim();
      if (!startStr || !endStr) { setFeedback('Please provide both start and end (address or coordinates).'); return; }

      let start = parseLatLngPair(startStr);
      let end = parseLatLngPair(endStr);

      try {
        if (!start) {
          setFeedback('Resolving start address...');
          const s = await geocodeAddress(startStr);
          if (!s) { setFeedback('Start address not found.'); return; }
          start = s; addStartMarker(start);
        } else addStartMarker(start);

        if (!end) {
          setFeedback('Resolving destination address...');
          const e = await geocodeAddress(endStr);
          if (!e) { setFeedback('End address not found.'); return; }
          end = e; addEndMarker(end);
        } else addEndMarker(end);

        await evaluateRoutes(start, end, { band: bandSelect?.value });
      } catch (e) {
        // evaluateRoutes handles logging/feedback
      }
    });
  }

  // populate markers from initial inputs if present
  (async () => {
    try {
      const maybeStart = startInput?.value?.trim();
      const maybeEnd = endInput?.value?.trim();
      if (maybeStart) {
        const s = parseLatLngPair(maybeStart) || await geocodeAddress(maybeStart);
        if (s) addStartMarker(s);
      }
      if (maybeEnd) {
        const e = parseLatLngPair(maybeEnd) || await geocodeAddress(maybeEnd);
        if (e) addEndMarker(e);
      }
    } catch (e) {}
  })();

  const controller = { map, layers, evaluateRoutes, addStartMarker, addEndMarker, clearRoutes, setFeedback };
  window._sarthi_route_controller = controller;
  return controller;
}

// close suggestions on outside click
document.addEventListener('click', (e) => {
  const isSuggestionItem = e.target.classList.contains('suggestion-item');
  const isInput = e.target.tagName === 'INPUT';
  if (!isSuggestionItem && !isInput) closeAllSuggestionDropdowns();
});

/* Auto-run */
(async () => {
  const mapEl = document.getElementById(MAP_ID);
  if (mapEl) {
    try { await initRoutePage(); } catch (e) { console.error('initRoutePage failed', e); document.getElementById(MAP_ID).innerText = 'Map initialization failed. See console.'; }
  } else console.warn(`#${MAP_ID} element not found — route module did not initialize.`);
})();
