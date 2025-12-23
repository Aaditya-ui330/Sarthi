# heatmap_routes.py
"""
Heatmap API routes for:
  - aggregated heatmap data
  - nearby aggregates lookup
  - geocode proxy

Supports timebands:
  morning, afternoon, evening, night, midnight, overall (all)
"""

from flask import Blueprint, request, jsonify
from services.heatmap_service import compute_aggregates
from services.audit_service import audits_db
from config import K_CONF
import math


heatmap_bp = Blueprint("heatmap_bp", __name__, url_prefix="/api")


# ----------------------------------------
# BAND NORMALIZATION
# ----------------------------------------
def normalize_band_param(raw_band):
    """
    Convert request band to internal format.

    - "overall", "all", None, ""  → return None  (meaning no filter)
    - else return lowercase band name
    """
    if not raw_band:
        return None

    b = raw_band.strip().lower()
    if b in ("overall", "all", ""):
        return None  # no filter = use ALL bands

    return b


# ----------------------------------------
# MAIN HEATMAP DATA ENDPOINT
# ----------------------------------------
@heatmap_bp.route("/heatmap_data", methods=["GET"])
def heatmap_data():
    try:
        band = normalize_band_param(request.args.get("band"))
        min_samples = int(request.args.get("min_samples", 1))

        # Compute final aggregated values
        aggs = compute_aggregates(audits_db, band_filter=band, min_samples=min_samples)

        out = []
        for cell, bands in aggs.items():
            for band_name, v in bands.items():

                # Confidence calculation
                numeric_conf = min(1.0, math.sqrt(v["W"]) / K_CONF)

                if numeric_conf >= 0.8 and v["N"] >= 8:
                    conf_cat = "high"
                elif numeric_conf >= 0.4 and v["N"] >= 3:
                    conf_cat = "medium"
                else:
                    conf_cat = "low"

                out.append({
                    "cell_id": v["cell_id"],
                    "band": band_name,
                    "lat": v["lat"],
                    "lng": v["lng"],
                    "score": None if v["score"] is None else round(float(v["score"]), 4),
                    "samples": int(v["N"]),
                    "effective_weight": float(v["W"]),
                    "confidence_numeric": round(numeric_conf, 3),
                    "confidence": conf_cat,
                    "last_updated": v["last_ts"]
                })

        return jsonify(out)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ----------------------------------------
# RAW AGGREGATES DEBUG ENDPOINT
# ----------------------------------------
@heatmap_bp.route("/heatmap_aggregates", methods=["GET"])
def heatmap_aggregates():
    try:
        band = normalize_band_param(request.args.get("band"))
        min_samples = int(request.args.get("min_samples", 1))

        aggs = compute_aggregates(audits_db, band_filter=band, min_samples=min_samples)

        out = []
        for cell, bands in aggs.items():
            for band_id, v in bands.items():
                out.append({
                    "cell_id": v["cell_id"],
                    "band": v["band"],
                    "lat": v["lat"],
                    "lng": v["lng"],
                    "score": v["score"],
                    "confidence": v["confidence"],
                    "sample_count": v["N"],
                    "last_updated": v["last_ts"]
                })

        return jsonify(out)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ----------------------------------------
# AGGREGATES NEAR LOCATION
# ----------------------------------------
@heatmap_bp.route("/aggregates_near", methods=["GET"])
def aggregates_near():
    try:
        address = request.args.get("address")
        lat = request.args.get("lat")
        lng = request.args.get("lng")
        radius_m = float(request.args.get("radius_m", 500))

        band = normalize_band_param(request.args.get("band"))

        # Geocode if needed
        if address and (not lat or not lng):
            from utils.geocode import geocode_address
            geo = geocode_address(address)
            if not geo:
                return jsonify({"error": "address not found"}), 404
            lat, lng = geo

        if lat is None or lng is None:
            return jsonify({"error": "provide lat/lng or address"}), 400

        lat = float(lat)
        lng = float(lng)

        deg_radius = radius_m / 111000.0
        min_lat, max_lat = lat - deg_radius, lat + deg_radius
        min_lng, max_lng = lng - deg_radius, lng + deg_radius

        aggs = compute_aggregates(audits_db, band_filter=band)

        results = []
        from services.geospatial import haversine_m

        for cell, bands in aggs.items():
            for b, info in bands.items():
                cell_lat = info["lat"]
                cell_lng = info["lng"]

                if cell_lat is None or cell_lng is None:
                    continue

                if not (min_lat <= cell_lat <= max_lat and min_lng <= cell_lng <= max_lng):
                    continue

                dist = haversine_m(lat, lng, cell_lat, cell_lng)
                if dist <= radius_m:
                    results.append({
                        "cell_id": info["cell_id"],
                        "band": b,
                        "lat": cell_lat,
                        "lng": cell_lng,
                        "score": info["score"],
                        "confidence": info["confidence"],
                        "sample_count": info["N"],
                        "distance_m": round(dist, 1)
                    })

        results.sort(key=lambda x: x["distance_m"])

        return jsonify({"query_lat": lat, "query_lng": lng, "results": results})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ----------------------------------------
# GEOCODE PROXY
# ----------------------------------------
@heatmap_bp.route("/geocode", methods=["GET"])
def geocode_proxy():
    address = request.args.get("address")
    if not address:
        return jsonify({"error": "address required"}), 400

    from utils.geocode import geocode_address
    geo = geocode_address(address)

    if not geo:
        return jsonify({"error": "not found"}), 404

    return jsonify({"lat": geo[0], "lng": geo[1]})
