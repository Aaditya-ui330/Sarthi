import math, datetime
from config import GRID_RES_DEGREES, T_HALF_HOURS, K_CONF, LN2

def latlng_to_cell(lat, lng, res=GRID_RES_DEGREES):
    if lat is None or lng is None:
        return None
    lat_idx = int(lat / res)
    lng_idx = int(lng / res)
    return f"{lat_idx}:{lng_idx}"

def get_time_band(ts):
    hour = datetime.datetime.fromtimestamp(ts).hour
    if 5 <= hour < 12: return "morning"
    if 12 <= hour < 17: return "afternoon"
    if 17 <= hour < 21: return "evening"
    if 21 <= hour < 24: return "night"
    return "midnight"

def decay_weight(ts_report, now=None, T_half_hours=T_HALF_HOURS):
    if now is None: now = datetime.datetime.now()
    age_hours = (now - datetime.datetime.fromtimestamp(ts_report)).total_seconds() / 3600.0
    return math.exp(-LN2 * age_hours / T_half_hours)

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    phi1 = math.radians(lat1); phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1); dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

# Compatibility wrapper for old name
def latlng_to_cell_key(lat, lng):
    return latlng_to_cell(lat, lng)