// /frontend/js/help_others.js
// Page logic for /pages/help_others.html (Submit audit page renamed "Help Others!")
// - Uses getIdToken(), getStoredUser() from /js/auth.js
// - Uses initSubmitMap from /js/map.js if available
// - Adds address autocomplete (Nominatim) and geocoding
// - Backwards-compatible with raw "lat, lng" entries

import { getIdToken, getStoredUser } from '/js/auth.js';

const $ = (s) => document.querySelector(s);
let mapObj = null;
let suggestionsVisible = false;
let autocompleteDebounceTimer = null;

// ------------------- helpers -------------------
function setFeedback(msg, color = 'var(--muted)') {
  const el = $('#formFeedback');
  if (!el) return;
  el.style.color = color;
  el.textContent = msg || '';
}

function clearForm() {
  $('#lat').value = '';
  $('#lng').value = '';
  $('#address').value = '';
  $('#notes').value = '';
  $('#lighting').value = '2';
  $('#visibility').value = '2';
  $('#cctv').value = 'false';
  $('#crowd').value = 'low';
  $('#crime').value = 'none';
  $('#security').value = 'false';
  $('#anonymous').value = 'false';
  $('#posText').textContent = 'not set';
  setFeedback('');
  if (mapObj && mapObj.clearMarker) mapObj.clearMarker();
  hideSuggestions();
}

function validatePayload(payload) {
  if (!payload.lat || !payload.lng) return 'Please set a location on the map.';
  const lat = Number(payload.lat), lng = Number(payload.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return 'Invalid coordinates.';
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return 'Coordinates out of range.';
  return null;
}

// parse "lat, lng" style input; returns [lat,lng] or null
function parseLatLngPair(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split(',').map(p => p.trim());
  if (parts.length !== 2) return null;
  const a = Number(parts[0]), b = Number(parts[1]);
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return [a, b];
  }
  return null;
}

// ------------------- Nominatim calls -------------------
async function suggestAddresses(q, limit = 5) {
  if (!q || q.trim().length < 2) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=${limit}&q=${encodeURIComponent(q)}`;
  try {
    const resp = await fetch(url, {
      headers: {
        // Nominatim requests a valid User-Agent; browsers usually set one.
        // Keep this minimal — do NOT include personal tokens here.
      }
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data || []).map(item => ({
      display_name: item.display_name,
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon)
    }));
  } catch (e) {
    console.warn('suggestAddresses error', e);
    return [];
  }
}

async function geocodeAddress(address) {
  // Return first match [lat, lng] or null
  const res = await suggestAddresses(address, 1);
  if (!res || !res.length) return null;
  return [res[0].lat, res[0].lon];
}

// ------------------- Autocomplete UI -------------------
function ensureSuggestionsContainer() {
  let el = document.getElementById('addressSuggestions');
  if (!el) {
    el = document.createElement('div');
    el.id = 'addressSuggestions';
    el.style.position = 'absolute';
    el.style.zIndex = 1200;
    el.style.width = '100%';
    el.style.maxHeight = '220px';
    el.style.overflow = 'auto';
    el.style.background = 'var(--card-bg)';
    el.style.border = '1px solid rgba(255,255,255,0.04)';
    el.style.borderRadius = '6px';
    el.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
    el.style.padding = '6px';
    el.className = 'suggestions-panel';
    const input = $('#address');
    if (input && input.parentNode) {
      input.parentNode.style.position = 'relative';
      input.parentNode.appendChild(el);
    } else {
      document.body.appendChild(el);
    }
  }
  return el;
}

function showSuggestions(list) {
  const container = ensureSuggestionsContainer();
  container.innerHTML = '';
  if (!list || !list.length) {
    hideSuggestions();
    return;
  }
  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'suggestion-row';
    row.style.padding = '8px';
    row.style.cursor = 'pointer';
    row.style.fontSize = '0.95rem';
    row.textContent = it.display_name;
    row.addEventListener('click', () => {
      onAddressSelected(it.display_name, [it.lat, it.lon]);
      hideSuggestions();
    });
    container.appendChild(row);
  }
  container.style.display = 'block';
  suggestionsVisible = true;
}

function hideSuggestions() {
  const container = document.getElementById('addressSuggestions');
  if (container) container.style.display = 'none';
  suggestionsVisible = false;
}

function attachAutocompleteToInput() {
  const input = $('#address');
  if (!input) return;

  input.addEventListener('input', async (ev) => {
    const v = input.value;
    // If user typed coordinates, don't call nominatim
    const coords = parseLatLngPair(v);
    if (coords) {
      // Hide suggestions and directly place marker
      hideSuggestions();
      setMarkerFromCoords(coords);
      return;
    }

    // debounce queries
    if (autocompleteDebounceTimer) clearTimeout(autocompleteDebounceTimer);
    autocompleteDebounceTimer = setTimeout(async () => {
      if (!input.value || input.value.trim().length < 2) {
        hideSuggestions();
        return;
      }
      const results = await suggestAddresses(input.value.trim(), 6);
      showSuggestions(results);
    }, 280);
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hideSuggestions();
  });

  // click outside => hide
  document.addEventListener('click', (ev) => {
    const container = document.getElementById('addressSuggestions');
    if (!container) return;
    if (!container.contains(ev.target) && ev.target !== input) {
      hideSuggestions();
    }
  });
}

// ------------------- Map + marker integration -------------------
function setMarkerFromCoords([lat, lng]) {
  if (mapObj && typeof mapObj.setMarker === 'function') {
    mapObj.setMarker([lat, lng]);
  } else if (mapObj && mapObj.map && typeof mapObj.map.setView === 'function') {
    // best-effort fallback
    try { mapObj.map.setView([lat, lng], 15); } catch(e){}
  }
  // set inputs (six decimals)
  $('#lat').value = Number(lat).toFixed(6);
  $('#lng').value = Number(lng).toFixed(6);
  $('#posText').textContent = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
  $('#btnSubmit').disabled = false;
  setFeedback('Location set. Fill the rest and submit.', 'var(--muted)');
}

async function onAddressSelected(displayName, [lat, lon]) {
  // fill address field
  const input = $('#address');
  if (input) input.value = displayName;
  setMarkerFromCoords([lat, lon]);
}

// ------------------- Map init -------------------
async function tryInitMap() {
  try {
    const mod = await import('/js/map.js');
    if (mod && typeof mod.initSubmitMap === 'function') {
      // When initSubmitMap calls onSelect([lat,lng]) we should set fields
      mapObj = mod.initSubmitMap('auditMap', ([lat, lng]) => {
        // ensure numeric and set to fields
        $('#lat').value = Number(lat).toFixed(6);
        $('#lng').value = Number(lng).toFixed(6);
        $('#posText').textContent = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
        $('#btnSubmit').disabled = false;
        setFeedback('Location set. Fill the rest and submit.', 'var(--muted)');
        // optionally prefill address via reverse geocode? skipped to avoid extra requests
      });
    } else {
      $('#auditMap').textContent = 'Map helper not available.';
    }
  } catch (err) {
    console.warn('map.js not available or failed to load', err);
    $('#auditMap').textContent = 'Map not loaded — add /js/map.js or ensure Leaflet is available.';
  }
}

// ------------------- Button handlers -------------------
async function useCurrentLocation() {
  setFeedback('Detecting location…', 'var(--muted)');
  try {
    const pos = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation unsupported'));
      navigator.geolocation.getCurrentPosition(p => resolve([p.coords.latitude, p.coords.longitude]), err => reject(err), { timeout: 8000 });
    });
    setMarkerFromCoords(pos);
    // attempt a reverse geocode to show an address? (skipped — could be added)
  } catch (e) {
    console.warn('useCurrentLocation failed', e);
    setFeedback('Could not get current location.', 'var(--danger)');
  }
}

// When user clicks submit:
async function submitAudit() {
  setFeedback('');
  const payload = {
    lat: Number($('#lat').value || null),
    lng: Number($('#lng').value || null),
    lighting: Number($('#lighting').value),
    visibility: Number($('#visibility').value),
    cctv: $('#cctv').value === 'true',
    crowd_density: $('#crowd').value,
    crime_observed: $('#crime').value,
    security_present: $('#security').value === 'true',
    notes: $('#notes').value.trim() || null,
    timestamp: Math.floor(Date.now() / 1000)
  };

  const anonymous = ($('#anonymous').value === 'true');

  const v = validatePayload(payload);
  if (v) { setFeedback(v, 'var(--danger)'); return; }

  // if user wants to link to account, ensure they are signed in
  if (!anonymous) {
    const stored = getStoredUser();
    if (!stored) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/auth.html?mode=signup&next=${next}`;
      return;
    }
  }

  // send to backend
  try {
    setFeedback('Submitting…', 'var(--muted)');
    const headers = { 'Content-Type': 'application/json' };
    if (!anonymous) {
      const token = await getIdToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch('http://127.0.0.1:5000/api/submit_audit', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=>null);
      throw new Error(txt || `Server error ${res.status}`);
    }
    setFeedback('Thanks — your audit was submitted!', 'var(--success)');
    setTimeout(() => clearForm(), 900);
  } catch (err) {
    console.error('submit error', err);
    setFeedback('Submit failed: ' + (err.message || 'unknown'), 'var(--danger)');
  }
}

// ------------------- DOM wiring -------------------
document.addEventListener('DOMContentLoaded', async () => {
  // Wire buttons
  const btnSubmit = $('#btnSubmit');
  const btnClear = $('#btnClear');
  const btnUseCurr = $('#btnUseCurrentLocation');

  if (btnSubmit) btnSubmit.addEventListener('click', submitAudit);
  if (btnClear) btnClear.addEventListener('click', clearForm);
  if (btnUseCurr) btnUseCurr.addEventListener('click', useCurrentLocation);

  // Disable submit until location selected
  if (btnSubmit) btnSubmit.disabled = true;

  // initialize map helper (if present)
  await tryInitMap();

  // wire address autocomplete
  attachAutocompleteToInput();

  // If latitude/longitude are already filled (e.g. from server or query params), enable submit
  const latVal = $('#lat')?.value;
  const lngVal = $('#lng')?.value;
  if (latVal && lngVal && !Number.isNaN(Number(latVal)) && !Number.isNaN(Number(lngVal))) {
    $('#btnSubmit').disabled = false;
  }
});
