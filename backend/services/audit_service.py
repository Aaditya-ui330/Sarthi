import json
import os
import datetime
import csv
import time
from config import AUDIT_FILE
from models.pipeline_loader import pipeline, legacy_model
from services.geospatial import latlng_to_cell, get_time_band
import numpy as np

# ----------------------------
# In-memory DB loaded from file
# ----------------------------
def load_audits_from_json():
    """Load audits list from AUDIT_FILE (JSON)."""
    if os.path.exists(AUDIT_FILE):
        try:
            with open(AUDIT_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            # corrupted file or parse error -> fallback to empty list
            return []
    return []

def save_audits():
    """Persist audits_db back to AUDIT_FILE (keep max size)."""
    MAX_AUDITS = 50000
    try:
        if len(audits_db) > MAX_AUDITS:
            # keep newest MAX_AUDITS items (assumes append-order is newest last)
            del audits_db[:-MAX_AUDITS]
        with open(AUDIT_FILE, "w", encoding="utf-8") as f:
            json.dump(audits_db, f, indent=4)
    except Exception:
        # Do not crash the startup if saving fails; just log to stdout
        print("[audit_service] Warning: failed to save audits to", AUDIT_FILE)

# initial load from json file
audits_db = load_audits_from_json()

# ----------------------------
# CSV ingestion (optional)
# ----------------------------
# We will attempt to find `historical_audits.csv` in repo root (one level up from services)
CSV_FILENAME = "historical_audits.csv"
BASE_DIR = os.path.dirname(os.path.dirname(__file__))  # project root containing historical_audits.csv
CSV_PATH = os.path.join(BASE_DIR, CSV_FILENAME)

def _coerce_float(val, default=0.0):
    try:
        return float(val)
    except Exception:
        return default

def _coerce_int(val, default=0):
    try:
        return int(float(val))
    except Exception:
        return default

def _normalize_csv_row(row):
    """
    Accepts a csv.DictReader row with flexible column names and returns
    a normalized audit dict similar to what other parts of code expect.
    """
    # Common column name variations
    lat_keys = ("lat", "latitude", "y")
    lng_keys = ("lng", "lon", "long", "longitude", "x")
    ts_keys = ("timestamp", "ts", "time", "epoch")
    severity_keys = ("severity", "sev", "score")
    crowd_keys = ("crowd_density", "crowd", "crowd_density_label")
    cctv_keys = ("cctv", "has_cctv")
    lighting_keys = ("lighting", "light")
    visibility_keys = ("visibility", "vis")
    crime_keys = ("crime_rate", "crime", "crime_score")
    poi_keys = ("poi_type", "poi")
    security_keys = ("security_present", "security", "security_flag")
    band_keys = ("band",)

    def first_value(d, keys):
        for k in keys:
            if k in d and d[k] not in (None, ""):
                return d[k]
        return None

    lat = first_value(row, lat_keys)
    lng = first_value(row, lng_keys)
    if lat is None or lng is None:
        return None  # cannot normalize without coords

    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except Exception:
        return None

    ts_val = first_value(row, ts_keys)
    if ts_val:
        try:
            ts_i = int(float(ts_val))
        except Exception:
            # try parse datetime strings
            try:
                dt = datetime.datetime.fromisoformat(str(ts_val))
                ts_i = int(dt.timestamp())
            except Exception:
                ts_i = int(time.time())
    else:
        ts_i = int(time.time())

    severity = _coerce_float(first_value(row, severity_keys), default=1.0)
    crime_rate = _coerce_float(first_value(row, crime_keys), default=0.0)
    lighting = _coerce_float(first_value(row, lighting_keys), default=0.0)
    visibility = _coerce_float(first_value(row, visibility_keys), default=0.0)
    crowd_density = first_value(row, crowd_keys) or "medium"
    cctv = first_value(row, cctv_keys) or "yes"
    poi_type = first_value(row, poi_keys) or "none"
    security_present = first_value(row, security_keys) or "not_sure"
    band = first_value(row, band_keys) or get_time_band(ts_i)

    normalized = {
        "lat": float(lat_f),
        "lng": float(lng_f),
        "ts": int(ts_i),
        "severity": float(severity),
        "crime_rate": float(crime_rate),
        "lighting": float(lighting),
        "visibility": float(visibility),
        "crowd_density": str(crowd_density),
        "cctv": str(cctv),
        "poi_type": str(poi_type),
        "security_present": str(security_present),
        "band": str(band)
    }
    return normalized

def load_audits_from_csv(csv_path):
    """
    Parse historical_audits.csv and return a list of normalized audit dicts.
    If the file is missing or unreadable, returns empty list.
    """
    if not os.path.exists(csv_path):
        return []
    parsed = []
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                norm = _normalize_csv_row(row)
                if norm:
                    parsed.append(norm)
    except Exception as e:
        print("[audit_service] Warning: failed to parse CSV", csv_path, ":", e)
        return []
    return parsed

# Attempt to ingest CSV rows (only if file exists)
_csv_rows = load_audits_from_csv(CSV_PATH)
if _csv_rows:
    # deduplicate on (lat,lng,ts) naive key to avoid re-adding same audits repeatedly
    existing_keys = set()
    for a in audits_db:
        try:
            existing_keys.add((round(float(a.get("lat", 0)), 6),
                               round(float(a.get("lng", 0)), 6),
                               int(a.get("ts", 0))))
        except Exception:
            continue

    added = 0
    for r in _csv_rows:
        key = (round(float(r["lat"]), 6), round(float(r["lng"]), 6), int(r["ts"]))
        if key in existing_keys:
            continue
        # create an audit record that matches how other code expects it
        audit_record = {
            "lat": r["lat"],
            "lng": r["lng"],
            "ts": r["ts"],
            "severity": r.get("severity", 1.0),
            "crime_rate": r.get("crime_rate", 0.0),
            "lighting": r.get("lighting", 0.0),
            "visibility": r.get("visibility", 0.0),
            "crowd_density": r.get("crowd_density", "medium"),
            "cctv": r.get("cctv", "yes"),
            "poi_type": r.get("poi_type", "none"),
            "security_present": r.get("security_present", "not_sure"),
            "band": r.get("band", get_time_band(r["ts"]))
        }
        audits_db.append(audit_record)
        existing_keys.add(key)
        added += 1

    if added:
        # persist the augmented audits_db back to AUDIT_FILE (so subsequent runs keep them)
        try:
            save_audits()
            print(f"[audit_service] Loaded {len(_csv_rows)} rows from CSV and added {added} new audits. Persisted to {AUDIT_FILE}")
        except Exception:
            print(f"[audit_service] Loaded {len(_csv_rows)} rows from CSV and added {added} new audits (save failed).")
    else:
        print(f"[audit_service] Found {len(_csv_rows)} rows in CSV but none were new (duplicates skipped).")
else:
    # nothing to ingest
    # (do not print too loudly in production; helpful during dev)
    # print(f"[audit_service] No historical CSV found at {CSV_PATH} or CSV contained no usable rows.")
    pass

# ----------------------------
# Legacy featurize (kept as-is)
# ----------------------------
def legacy_featurize(audit):
    crowd_map = {"low": 0, "medium": 1, "high": 2}
    cctv_map = {"yes": 1, "no": 0}
    lighting = audit.get("lighting", 0)
    visibility = audit.get("visibility", 0)
    try:
        lighting = float(lighting)
    except:
        lighting = 0.0
    try:
        visibility = float(visibility)
    except:
        visibility = 0.0
    crowd = crowd_map.get(str(audit.get("crowd_density", "medium")).lower(), 1)
    cctv = cctv_map.get(str(audit.get("cctv", "yes")).lower(), 1)
    crime_rate = audit.get("crime_rate", 0)
    try:
        crime_rate = float(crime_rate)
    except:
        crime_rate = 0.0
    return np.array([[lighting, visibility, crowd, cctv, crime_rate]])

# ----------------------------
# Build DataFrame for pipeline
# ----------------------------
def build_input_df(audit):
    import pandas as pd
    crowd_map = {"low": 0, "medium": 1, "high": 2}
    cctv_map = {"yes": 1, "no": 0}
    try:
        lighting = float(audit.get("lighting", 0))
    except:
        lighting = 0.0
    try:
        visibility = float(audit.get("visibility", 0))
    except:
        visibility = 0.0
    try:
        crime_rate = float(audit.get("crime_rate", 0))
    except:
        crime_rate = 0.0
    crowd = crowd_map.get(str(audit.get("crowd_density", "medium")).lower(), 1)
    cctv_flag = cctv_map.get(str(audit.get("cctv", "yes")).lower(), 1)
    poi_type = str(audit.get("poi_type", "none") or "none")
    security_present = str(audit.get("security_present", "not_sure") or "not_sure")
    df = pd.DataFrame([{
        "lighting": lighting,
        "visibility": visibility,
        "crime_rate": crime_rate,
        "crowd": int(crowd),
        "cctv_flag": int(cctv_flag),
        "poi_type": poi_type,
        "security_present": security_present
    }])
    return df

# ----------------------------
# Predict helper: uses pipeline or legacy model as before
# ----------------------------
def predict_score(audit):
    # pipeline loaded dynamically from models.pipeline_loader
    from models.pipeline_loader import pipeline as pl, legacy_model as lm
    if pl is not None:
        X_df = build_input_df(audit)
        try:
            return float(pl.predict_proba(X_df)[0][1])
        except Exception as e:
            raise RuntimeError(f"Prediction failed (pipeline): {e}")
    elif lm is not None:
        X = legacy_featurize(audit)
        try:
            return float(lm.predict_proba(X)[0][1])
        except Exception as e:
            raise RuntimeError(f"Prediction failed (legacy): {e}")
    else:
        raise RuntimeError("No model available. Run train.py to create safety_pipeline.joblib")
