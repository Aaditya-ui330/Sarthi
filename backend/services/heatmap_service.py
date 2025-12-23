# services/heatmap_service.py
import math, datetime
from services.geospatial import decay_weight, latlng_to_cell, haversine_m, get_time_band
from config import K_CONF
from services.audit_service import audits_db

def compute_aggregates(audits, band_filter=None, min_samples=1):
    """
    Build aggregates per grid cell (+ time band).
    This version is tolerant of several audit shapes:
      - latitude / longitude OR lat / lng
      - safety_score OR score OR calculated_score
      - timestamp (unix seconds) OR created_at (ISO string)
      - optional time_band; if missing it's inferred from timestamp
    """
    now = datetime.datetime.now()
    aggs = {}

    for a in audits:
        # tolerant lat/lng extraction
        lat = a.get("lat")
        if lat is None:
            lat = a.get("latitude")
        lng = a.get("lng")
        if lng is None:
            lng = a.get("longitude")

        if lat is None or lng is None:
            # skip records without coordinates
            continue

        # parse timestamp (prefer numeric unix seconds)
        ts = None
        if "timestamp" in a and a.get("timestamp") is not None:
            try:
                ts = float(a.get("timestamp"))
            except Exception:
                ts = None
        if ts is None and a.get("created_at"):
            # try parsing ISO-like created_at
            try:
                parsed = datetime.datetime.fromisoformat(a.get("created_at"))
                ts = parsed.timestamp()
            except Exception:
                # try more generic parse
                try:
                    ts = datetime.datetime.strptime(a.get("created_at"), "%Y-%m-%dT%H:%M:%S.%fZ").timestamp()
                except Exception:
                    ts = None
        if ts is None:
            # fallback: treat as now
            ts = now.timestamp()

        # time band: prefer explicit, otherwise infer from timestamp (unix seconds)
        # FIX: use synthetic 'band' field first (from audits_data.json)
        band = a.get("band") or a.get("time_band")

        # If no band provided in the audit, fall back to timestamp-based band
        if not band:
            try:
                band = get_time_band(int(ts))
            except Exception:
                band = None

        # respect band_filter (if provided, and not "all")
        if band_filter and band_filter.lower() != "all":
            if band is None or band.lower() != band_filter.lower():
                continue

        # score: support multiple field names
        score_val = None
        for k in ("safety_score", "score", "calculated_score"):
            if k in a and a.get(k) is not None:
                try:
                    score_val = float(a.get(k))
                    break
                except Exception:
                    try:
                        score_val = float(str(a.get(k)).strip())
                        break
                    except Exception:
                        score_val = None

        # If score is still None, default to 0.0 (or you can choose to skip)
        if score_val is None:
            lighting = float(a.get("lighting", 3)) / 5.0
            visibility = float(a.get("visibility", 3)) / 5.0

            crowd = a.get("crowd_density")
            if crowd == "high":
                crowd_val = 0.2
            elif crowd == "medium":
                crowd_val = 0.5
            else:
                crowd_val = 0.8

            cctv_val = 0.8 if a.get("cctv") == "yes" else 0.3

            crime_rate = float(a.get("crime_rate", 1))
            crime_val = 1.0 - (crime_rate / 5.0)

            security = a.get("security_present")
            sec_val = 0.8 if security == "yes" else 0.2

            score_val = (
                0.25 * lighting +
                0.20 * visibility +
                0.15 * crowd_val +
                0.15 * cctv_val +
                0.15 * crime_val +
                0.10 * sec_val
            )

            score_val = max(0.0, min(1.0, score_val))

        # compute cell id (reuse existing if provided)
        cell = a.get("cell_id") or latlng_to_cell(lat, lng)
        if cell is None:
            continue

        # decay weight based on timestamp
        w = decay_weight(ts, now)
        s = float(score_val)

        key = (cell, band)
        if key not in aggs:
            aggs[key] = {
                "W": w,
                "S": w * s,
                "N": 1,
                "last_ts": ts,
                "lat_sum": lat,
                "lng_sum": lng
            }
        else:
            e = aggs[key]
            e["W"] += w
            e["S"] += w * s
            e["N"] += 1
            e["last_ts"] = max(e["last_ts"], ts)
            e["lat_sum"] += lat
            e["lng_sum"] += lng

    # finalize aggregates, filter by min_samples, compute score/confidence
    out = {}
    for (cell, band), e in aggs.items():
        N, W, S = e["N"], e["W"], e["S"]
        if N < min_samples:
            continue
        score = (S / W) if W > 0 else None
        confidence = min(1.0, math.sqrt(W) / K_CONF)
        lat_mean = e["lat_sum"] / N
        lng_mean = e["lng_sum"] / N
        out.setdefault(cell, {})[band] = {
            "cell_id": cell,
            "band": band,
            "W": W,
            "S": S,
            "N": N,
            "last_ts": e["last_ts"],
            "score": score,
            "confidence": confidence,
            "lat": lat_mean,
            "lng": lng_mean
        }

    return out

# keep the OPENAPI / SWAGGER_HTML if your file included them (omitted here for brevity)

# Keep OPENAPI and SWAGGER_HTML here so app.py routes can reuse them (unchanged)
OPENAPI = {
    "openapi": "3.0.0",
    "info": {
        "title": "Flask Safety Audit API",
        "version": "1.0.0",
        "description": "API for submitting safety audits and retrieving heatmap data."
    },
    "servers": [{"url": "http://127.0.0.1:5000"}],
    "paths": {
        # minimal spec entries (kept same as before)
    }
}

SWAGGER_HTML = """
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>Swagger UI - Safety Audit API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>window.onload=function(){SwaggerUIBundle({url:"/openapi.json",dom_id:'#swagger-ui',deepLinking:true,presets:[SwaggerUIBundle.presets.apis],layout:"BaseLayout"});}</script></body></html>
"""
