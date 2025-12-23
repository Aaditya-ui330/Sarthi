# route_routes.py
from flask import Blueprint, request, jsonify
from services.routing_service import evaluate_route, sample_route_points
from services.heatmap_service import compute_aggregates
from services.audit_service import audits_db
import math
import logging
import json
import requests

route_bp = Blueprint("route_bp", __name__, url_prefix="/api")

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# --- Helpers: haversine, spatial index, nearest lookup --------------------
def haversine_m(lat1, lon1, lat2, lon2):
    """Return haversine distance in meters between two lat/lon pairs."""
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda/2.0) ** 2
    return 2 * R * math.asin(math.sqrt(a))

def build_spatial_index_from_aggs(aggs):
    pts = []
    cell_map = {}
    for cell_id, bands in aggs.items():
        any_band = None
        for b in bands.values():
            any_band = b
            break
        if not any_band:
            continue
        lat = any_band.get("lat")
        lng = any_band.get("lng")
        if lat is None or lng is None:
            continue
        try:
            lat = float(lat); lng = float(lng)
        except Exception:
            continue
        pts.append((lat, lng, cell_id, bands))
        cell_map[cell_id] = bands
    return pts, cell_map

def find_nearest_agg_cell(lat, lng, aggs_index, max_dist_m=300):
    best_cell = None
    best_bands = None
    best_d = None
    for a_lat, a_lng, cell_id, bands in aggs_index:
        d = haversine_m(lat, lng, a_lat, a_lng)
        if d <= max_dist_m and (best_d is None or d < best_d):
            best_cell = cell_id
            best_bands = bands
            best_d = d
    return best_cell, best_bands, best_d

# -------------------------
# OSRM routing helper (with steps)
# -------------------------
# Default OSRM base: public demo server. For production/self-host use your OSRM instance URL.
OSRM_BASE = "http://router.project-osrm.org"

def _map_profile_name(profile_param):
    """
    Map incoming 'profile' parameter to OSRM profile name:
      - 'foot'/'walking' -> 'walking'
      - 'bike'/'bicycle'/'cycling' -> 'cycling'
      - otherwise -> 'driving'
    Note: OSRM public server supports 'driving', 'walking', 'cycling' where available.
    """
    if not profile_param:
        return "driving"
    p = str(profile_param).lower()
    if p in ("foot", "walking", "pedestrian"):
        return "walking"
    if p in ("bike", "bicycle", "cycling"):
        return "cycling"
    return "driving"

def fetch_osrm_routes_with_steps(start, end, alternatives=3, profile="driving", timeout=8.0):
    """
    Query OSRM for route(s) with steps.
    start, end: [lat, lng]
    Returns list of route dicts:
      {
        "geometry": [[lat,lng],...],
        "distance": <meters>,
        "duration": <seconds>,
        "summary": <string>,
        "steps": [ { maneuver:..., name:..., distance:..., duration:..., instruction:... }, ... ]
      }
    Returns empty list on failure.
    """
    try:
        s_lat, s_lng = float(start[0]), float(start[1])
        e_lat, e_lng = float(end[0]), float(end[1])
    except Exception:
        return []

    coords = f"{s_lng},{s_lat};{e_lng},{e_lat}"
    url = f"{OSRM_BASE}/route/v1/{profile}/{coords}"
    params = {
        "overview": "full",
        "geometries": "geojson",
        "alternatives": "true" if alternatives and alternatives > 1 else "false",
        "steps": "true"
    }
    try:
        resp = requests.get(url, params=params, timeout=timeout)
        if resp.status_code != 200:
            logger.debug("OSRM non-200 response: %s %s", resp.status_code, resp.text[:200])
            return []
        data = resp.json()
        if "routes" not in data or not data["routes"]:
            return []
        out_routes = []
        for route in data["routes"][: max(1, alternatives) ]:
            geom = route.get("geometry") or {}
            coords_list = geom.get("coordinates") or []  # list of [lon, lat]
            latlngs = [[float(c[1]), float(c[0])] for c in coords_list] if coords_list else []
            distance = float(route.get("distance", 0.0))
            duration = float(route.get("duration", 0.0))
            summary = route.get("summary", "")
            # steps: flatten legs -> steps
            steps = []
            for leg in route.get("legs", []):
                for st in leg.get("steps", []):
                    # Build a compact instruction object
                    instr = {
                        "maneuver": st.get("maneuver", {}),
                        "name": st.get("name", ""),
                        "distance": float(st.get("distance", 0.0)),
                        "duration": float(st.get("duration", 0.0)),
                        # Many OSRM builds include a "maneuver.instruction" textual field via some tooling,
                        # but safest is to compose a simple readable instruction:
                        "instruction": st.get("maneuver", {}).get("type", "") + ((" " + st.get("maneuver", {}).get("modifier")) if st.get("maneuver", {}).get("modifier") else "") + ((" onto " + st.get("name")) if st.get("name") else "")
                    }
                    steps.append(instr)
            out_routes.append({
                "geometry": latlngs,
                "distance": distance,
                "duration": duration,
                "summary": summary,
                "steps": steps
            })
        return out_routes
    except Exception as e:
        logger.exception("OSRM request failed: %s", e)
        return []

# -------------------------------------------------------------------------

@route_bp.route("/safe_route", methods=["GET","POST"])
def safe_route():
    """
    Supports:
      - POST with JSON body: { start: [lat,lng], end: [lat,lng], profile: 'driving'|'walking'|'cycling', ... }
      - GET with query params: ?start_lat=...&start_lng=...&end_lat=...&end_lng=...&profile=walking
    Response includes:
      - best_route: list of [lat,lng]
      - best_eval: safety evaluation dict
      - all_evaluations: list of { route: [lat,lng], eval: {...}, steps: [...], distance, duration, summary }
    """
    try:
        payload = {}
        # If GET, parse query params
        if request.method == "GET":
            s_lat = request.args.get("start_lat")
            s_lng = request.args.get("start_lng")
            e_lat = request.args.get("end_lat")
            e_lng = request.args.get("end_lng")

            if not (s_lat and s_lng and e_lat and e_lng):
                return jsonify({"error": "provide start_lat, start_lng, end_lat, end_lng as query params"}), 400

            try:
                start = [float(s_lat), float(s_lng)]
                end = [float(e_lat), float(e_lng)]
            except ValueError:
                return jsonify({"error": "start/end coordinates must be numeric"}), 400

            payload["start"] = start
            payload["end"] = end

            # optional params
            profile = request.args.get("profile")
            if profile:
                payload["profile"] = profile

            if request.args.get("band") is not None:
                payload["band"] = request.args.get("band")

            if request.args.get("step_m") is not None:
                payload["step_m"] = request.args.get("step_m")

            if request.args.get("max_nearest_m") is not None:
                payload["max_nearest_m"] = request.args.get("max_nearest_m")

            cand = request.args.get("candidates")
            if cand:
                try:
                    parsed = json.loads(cand)
                    if isinstance(parsed, list):
                        payload["candidates"] = parsed
                except Exception:
                    logger.debug("Could not parse 'candidates' query param as JSON; ignoring")
        else:
            payload = request.get_json(silent=True) or {}

        start = payload.get("start"); end = payload.get("end")
        if not start or not end:
            return jsonify({"error": "provide start and end coordinates"}), 400

        # profile selection (driving/walking/cycling)
        profile_param = payload.get("profile", None)
        osrm_profile = _map_profile_name(profile_param)

        band = payload.get("band")
        try:
            step_m = float(payload.get("step_m", 50))
        except Exception:
            step_m = 50.0

        candidates = payload.get("candidates")
        try:
            max_nearest_m = float(payload.get("max_nearest_m", 300))
        except Exception:
            max_nearest_m = 300.0

        # load aggregates
        aggs = compute_aggregates(audits_db, band_filter=band, min_samples=1)
        aggs_index, aggs_map = build_spatial_index_from_aggs(aggs)

        routes = []
        route_meta = []  # parallel list storing metadata (distance,duration,steps,summary)
        # If explicit candidate routes supplied, use them (no OSRM steps available)
        if candidates and isinstance(candidates, list) and len(candidates) > 0:
            for cand in candidates:
                routes.append(cand)
                route_meta.append({"distance": None, "duration": None, "steps": [], "summary": ""})
        else:
            # try to fetch real road routes from OSRM with steps
            try:
                osrm_routes = fetch_osrm_routes_with_steps(start, end, alternatives=3, profile=osrm_profile)
                if osrm_routes:
                    for r in osrm_routes:
                        routes.append(r["geometry"])
                        route_meta.append({
                            "distance": r.get("distance"),
                            "duration": r.get("duration"),
                            "steps": r.get("steps", []),
                            "summary": r.get("summary", "")
                        })
                else:
                    # fallback to old straight/offset
                    s_lat, s_lng = float(start[0]), float(start[1])
                    e_lat, e_lng = float(end[0]), float(end[1])
                    straight = [[s_lat, s_lng], [e_lat, e_lng]]
                    def offset_point(lat, lng, meters_east=0, meters_north=0):
                        dlat = meters_north / 111111.0
                        dlon = meters_east / (111111.0 * max(1e-6, math.cos(math.radians(lat))))
                        return [lat + dlat, lng + dlon]
                    mid_lat = (s_lat + e_lat) / 2.0; mid_lng = (s_lng + e_lng) / 2.0
                    detour_m = 200
                    left_mid = offset_point(mid_lat, mid_lng, meters_east=-detour_m)
                    right_mid = offset_point(mid_lat, mid_lng, meters_east=detour_m)
                    left_route = [[s_lat, s_lng], left_mid, [e_lat, e_lng]]
                    right_route = [[s_lat, s_lng], right_mid, [e_lat, e_lng]]
                    routes = [straight, left_route, right_route]
                    route_meta = [{"distance": None, "duration": None, "steps": [], "summary": ""} for _ in routes]
            except Exception:
                logger.exception("OSRM routing failed, using fallback routes")
                try:
                    s_lat, s_lng = float(start[0]), float(start[1])
                    e_lat, e_lng = float(end[0]), float(end[1])
                    straight = [[s_lat, s_lng], [e_lat, e_lng]]
                    def offset_point(lat, lng, meters_east=0, meters_north=0):
                        dlat = meters_north / 111111.0
                        dlon = meters_east / (111111.0 * max(1e-6, math.cos(math.radians(lat))))
                        return [lat + dlat, lng + dlon]
                    mid_lat = (s_lat + e_lat) / 2.0; mid_lng = (s_lng + e_lng) / 2.0
                    detour_m = 200
                    left_mid = offset_point(mid_lat, mid_lng, meters_east=-detour_m)
                    right_mid = offset_point(mid_lat, mid_lng, meters_east=detour_m)
                    left_route = [[s_lat, s_lng], left_mid, [e_lat, e_lng]]
                    right_route = [[s_lat, s_lng], right_mid, [e_lat, e_lng]]
                    routes = [straight, left_route, right_route]
                    route_meta = [{"distance": None, "duration": None, "steps": [], "summary": ""} for _ in routes]
                except Exception:
                    routes = []
                    route_meta = []

        evaluations = []
        for idx, r in enumerate(routes):
            eval_res = None
            try:
                eval_res = evaluate_route(r, aggs, step_m=step_m)
            except Exception as ex:
                logger.exception("evaluate_route raised exception for route %s", r)
                eval_res = {"error": str(ex)}

            # If evaluate_route returned a full structure with 'per_point', attempt nearest-cell filling
            if eval_res and isinstance(eval_res, dict) and "per_point" in eval_res:
                per_point = eval_res.get("per_point") or []
                filled_any = False
                for p in per_point:
                    try:
                        score = p.get("score")
                        samples = p.get("samples", 0) or 0
                        conf = p.get("conf", 0.0) or 0.0
                        if samples == 0 or score is None:
                            lat = p.get("lat"); lng = p.get("lng")
                            if lat is None or lng is None:
                                continue
                            cell_id = p.get("cell")
                            agg_bands = None
                            if cell_id and cell_id in aggs_map:
                                agg_bands = aggs_map[cell_id]
                            else:
                                found_cell, found_bands, dist = find_nearest_agg_cell(lat, lng, aggs_index, max_dist_m=max_nearest_m)
                                if found_cell:
                                    agg_bands = found_bands
                                    logger.debug("Nearest agg for point (%s,%s) -> %s @ %dm", lat, lng, found_cell, int(dist))
                            if agg_bands:
                                selected_band_entry = None
                                if band and band in agg_bands:
                                    selected_band_entry = agg_bands[band]
                                else:
                                    try:
                                        selected_band_entry = max(agg_bands.values(), key=lambda b: (b.get("confidence", 0.0), b.get("N", 0)))
                                    except Exception:
                                        selected_band_entry = next(iter(agg_bands.values()))
                                if selected_band_entry:
                                    p["score"] = selected_band_entry.get("score")
                                    p["conf"] = selected_band_entry.get("confidence", 0.0)
                                    p["samples"] = selected_band_entry.get("N", 0)
                                    p["_matched_cell"] = selected_band_entry.get("cell_id") or p.get("cell")
                                    filled_any = True
                    except Exception:
                        logger.exception("Error while trying to fill per_point %r", p)

                # recompute summary fields
                try:
                    scores = [pt.get("score") for pt in per_point if pt.get("score") is not None]
                    confs = [float(pt.get("conf") or 0.0) for pt in per_point if pt.get("conf") is not None]
                    known_points = sum(1 for pt in per_point if (pt.get("samples") or 0) > 0)
                    sampled_points = int(eval_res.get("sampled_points", len(per_point)))
                    avg_score = (sum(scores)/len(scores)) if scores else None
                    avg_conf = (sum(confs)/len(confs)) if confs else 0.0
                    coverage = (known_points / sampled_points) if sampled_points > 0 else 0.0
                    overall_conf = avg_conf * coverage
                    eval_res["known_points"] = known_points
                    eval_res["avg_score"] = avg_score
                    eval_res["avg_conf"] = avg_conf
                    eval_res["coverage"] = coverage
                    eval_res["overall_conf"] = overall_conf
                except Exception:
                    logger.exception("Error recomputing eval summary for route %s", r)

            meta = route_meta[idx] if idx < len(route_meta) else {"distance": None, "duration": None, "steps": [], "summary": ""}

            evaluations.append({
                "route": r,
                "eval": eval_res,
                "distance": meta.get("distance"),
                "duration": meta.get("duration"),
                "steps": meta.get("steps"),
                "summary": meta.get("summary")
            })

        # scoring key
        def score_key(item):
            ev = item["eval"]
            if not ev:
                return -1
            sc = ev.get("avg_score") if ev.get("avg_score") is not None else 0.0
            return ev.get("overall_conf", 0.0) * sc

        evaluations.sort(key=score_key, reverse=True)
        best = evaluations[0] if evaluations else None

        return jsonify({
            "candidates_evaluated": len(evaluations),
            "best_route": best["route"] if best else None,
            "best_eval": best["eval"] if best else None,
            "best_distance": best.get("distance") if best else None,
            "best_duration": best.get("duration") if best else None,
            "best_steps": best.get("steps") if best else [],
            "all_evaluations": evaluations,
            "aggs_count": len(aggs_map),
            "aggs_indexed_points": len(aggs_index),
            "osrm_profile": osrm_profile
        })
    except Exception as e:
        logger.exception("safe_route top-level exception")
        return jsonify({"error": str(e)}), 500
