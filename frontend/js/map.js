// /frontend/js/map.js
// Map helpers used by multiple pages (submit, dashboard, heatmap).
// Exports: createBaseMap, initSubmitMap, initUserContribMap
// Depends on Leaflet (L) and optionally leaflet.heat plugin (L.heatLayer)

export function createBaseMap(targetId, { center = [12.9716, 77.5946], zoom = 13, minZoom = 3, maxZoom = 19 } = {}) {
  const map = L.map(targetId, {
    center,
    zoom,
    minZoom,
    maxZoom,
    zoomControl: true,
    attributionControl: false
  });

  // Basic tile layer (OpenStreetMap)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // create panes for heat & marker ordering
  if (!map.getPane('heatPane')) map.createPane('heatPane');
  if (!map.getPane('markerPane')) map.createPane('markerPane');

  // convenience - store ref
  map._baseCreated = true;
  return map;
}

/**
 * initSubmitMap(targetId, onSelect)
 * - shows a map for the "Submit audit" page
 * - onSelect([lat,lng]) called when user clicks on map or drags marker
 *
 * returns a small controller with setMarker([lat,lng]) and clearMarker()
 */
export function initSubmitMap(targetId, onSelect = () => {}) {
  const map = createBaseMap(targetId, { zoom: 15 });
  let marker = null;

  // helper to place or move marker (draggable)
  function setMarker(latlng) {
    if (!latlng || typeof latlng[0] !== 'number') return;
    if (!marker) {
      marker = L.marker(latlng, { draggable: true }).addTo(map);
      marker.on('dragend', function (ev) {
        const p = ev.target.getLatLng();
        onSelect([p.lat, p.lng]);
      });
    } else {
      marker.setLatLng(latlng);
    }
    map.setView(latlng, Math.max(map.getZoom(), 15));
  }

  function clearMarker() {
    if (marker) {
      map.removeLayer(marker);
      marker = null;
    }
  }

  // map click places marker and triggers onSelect
  map.on('click', function (ev) {
    const { lat, lng } = ev.latlng;
    setMarker([lat, lng]);
    onSelect([lat, lng]);
  });

  return {
    map,
    setMarker,
    clearMarker,
    // compatibility: allow calling setMarker with {lat,lng}
    _ensureLatLng(obj) {
      if (Array.isArray(obj)) return obj;
      if (obj && typeof obj.lat === 'number') return [obj.lat, obj.lng];
      return null;
    }
  };
}

/**
 * initUserContribMap(targetId, options)
 * - targetId: DOM id for map container
 * - options: { center, zoom, showMarkers (bool default true), heatOptions (custom gradient etc) }
 *
 * Returns controller:
 * { map, heat, markersLayer, setHeatPoints(points), toggleHeat(show), toggleMarkers(show), addMarker(marker) }
 *
 * Points format expected by setHeatPoints: [{lat, lng, intensity (0..1), meta...}, ...]
 */
export function initUserContribMap(targetId, options = {}) {
  const center = options.center || [12.9716, 77.5946];
  const zoom = options.zoom || 13;
  const map = createBaseMap(targetId, { center, zoom });

  // marker group for discrete points
  const markersLayer = L.layerGroup().addTo(map);

  // default infrared gradient (0..1)
  const INFRARED_GRADIENT = options.heatGradient || {
    0.0: 'rgba(0,0,60,0.0)',
    0.2: '#0d47a1',
    0.4: '#00bcd4',
    0.6: '#ffeb3b',
    0.8: '#ff9800',
    1.0: '#f44336'
  };

  // create heat layer if plugin present
  let heat = null;
  function createHeatLayer(heatArr = []) {
    if (typeof L.heatLayer !== 'function') {
      console.warn('leaflet.heat plugin not found — add leaflet.heat script to render heatmap.');
      return null;
    }
    const options = {
      radius: options.heatRadius || 30,
      blur: options.heatBlur || 20,
      maxZoom: options.heatMaxZoom || 17,
      max: options.heatMax || 1.0,
      gradient: INFRARED_GRADIENT
    };
    const h = L.heatLayer(heatArr, options);
    return h;
  }

  // Controller methods
  function setHeatPoints(points = []) {
    // points: [{lat,lng,intensity}, ...]
    const arr = (points || []).map(p => {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      const intensity = Math.max(0, Math.min(1, Number(p.intensity ?? p.weight ?? 0.5)));
      return [lat, lng, intensity];
    }).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]));

    if (!heat) {
      heat = createHeatLayer(arr);
      if (heat) heat.addTo(map);
    } else {
      // update
      if (typeof heat.setLatLngs === 'function') heat.setLatLngs(arr);
    }
  }

  function toggleHeat(show) {
    if (!heat) return;
    if (show === undefined) show = !map.hasLayer(heat);
    if (show) {
      map.addLayer(heat);
    } else {
      map.removeLayer(heat);
    }
  }

  function toggleMarkers(show) {
    if (show === undefined) show = !map.hasLayer(markersLayer);
    if (show) {
      map.addLayer(markersLayer);
    } else {
      map.removeLayer(markersLayer);
    }
  }

  function addPointMarker(point) {
    // point: {lat,lng, popupHtml?, markerOptions?}
    if (!point || typeof point.lat !== 'number') return null;
    const opts = Object.assign({
      radius: 6,
      fillOpacity: 0.95,
      weight: 1,
      color: 'rgba(0,0,0,0.15)'
    }, point.markerOptions || {});
    const m = L.circleMarker([point.lat, point.lng], opts);
    if (point.popupHtml) m.bindPopup(point.popupHtml);
    markersLayer.addLayer(m);
    return m;
  }

  function clearMarkers() {
    markersLayer.clearLayers();
  }

  // expose API
  const ctrl = {
    map,
    heat,
    markersLayer,
    setHeatPoints,
    toggleHeat,
    toggleMarkers,
    addPointMarker: addPointMarker,
    clearMarkers,
    // small helper to place a single marker (used by submit page pattern)
    setMarker(latlng) {
      // create a visual marker on this map (not persistent)
      if (!latlng) return;
      const m = L.circleMarker(latlng, { radius: 7, fillColor: '#4d7cff', fillOpacity: 0.95, weight: 1 }).addTo(markersLayer);
      map.setView(latlng, Math.max(map.getZoom(), 15));
      return m;
    }
  };

  return ctrl;
}
