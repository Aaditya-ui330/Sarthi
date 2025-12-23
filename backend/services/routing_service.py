import math
from services.geospatial import haversine_m, latlng_to_cell
from services.heatmap_service import compute_aggregates
from config import K_CONF
from services.audit_service import audits_db

# interpolation / sampling preserved
def interpolate_segment(p1, p2, step_m=50):
    lat1, lng1 = p1; lat2, lng2 = p2
    segment_len = haversine_m(lat1, lng1, lat2, lng2)
    if segment_len == 0:
        yield p1
        return
    steps = max(1, int(math.ceil(segment_len / step_m)))
    for i in range(steps+1):
        t = i/steps
        yield (lat1 + (lat2 - lat1)*t, lng1 + (lng2 - lng1)*t)

def sample_route_points(route_coords, step_m=50):
    pts = []
    if not route_coords or len(route_coords) < 2: return pts
    for a,b in zip(route_coords[:-1], route_coords[1:]):
        for p in interpolate_segment(tuple(a), tuple(b), step_m=step_m):
            pts.append(p)
    return pts

def evaluate_route(route_coords, aggregates, step_m=50, min_sample_for_conf=1):
    sampled = sample_route_points(route_coords, step_m=step_m)
    if not sampled:
        return None
    per_point=[]; total_len=0.0
    cell_lookup={}
    for cell, bands in aggregates.items():
        band_key = next(iter(bands))
        cell_lookup[cell] = bands[band_key]
    for i,(lat,lng) in enumerate(sampled):
        cell = latlng_to_cell(lat, lng)
        info = cell_lookup.get(cell)
        if info:
            s = info.get("score"); conf = min(1.0, math.sqrt(info.get("W",0))/K_CONF); n = info.get("N",0)
        else:
            s=None; conf=0.0; n=0
        per_point.append({"lat":lat,"lng":lng,"cell":cell,"score":s,"conf":conf,"samples":n})
        if i < len(sampled)-1:
            total_len += haversine_m(lat, lng, sampled[i+1][0], sampled[i+1][1])
    weighted_sum=0.0; weight_total=0.0; known_points=0
    for p in per_point:
        sc = p["score"]; cf = p["conf"]
        if sc is None: continue
        known_points += 1
        w = max(0.01, cf)
        weighted_sum += sc*w; weight_total += w
    avg_score = (weighted_sum/weight_total) if weight_total>0 else None
    coverage = known_points / max(1, len(per_point))
    avg_conf = (sum(p["conf"] for p in per_point)/max(1, len(per_point)))
    overall_conf = avg_conf * (0.5 + 0.5 * coverage)
    return {
        "avg_score": None if avg_score is None else float(avg_score),
        "avg_conf": float(avg_conf),
        "overall_conf": float(overall_conf),
        "coverage": coverage,
        "sampled_points": len(per_point),
        "known_points": known_points,
        "total_length_m": total_len,
        "per_point": per_point
    }
