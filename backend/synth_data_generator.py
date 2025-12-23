# synth_data_generator_full.py
"""
Generate synthetic audit data for Bengaluru (Yelahanka → Majestic)
with 5 time bands: morning, afternoon, evening, night, midnight.

Outputs:
  - CSV (default: historical_audits.csv)
  - JSON (fixed): audits_data.json

UPDATE:
  ✔ Added real "score" field (0–1 safety)
  ✔ Uses band-based timestamps
  ✔ severity still included
  ✔ Safe score = sigmoid(model)
"""

import csv
import json
import math
import random
import argparse
import time
import datetime
import numpy as np


def sigmoid(x):
    return 1.0 / (1.0 + math.exp(-x))


def sample_timestamp_for_band(band, base_date=None, seed=None):
    """Generate UTC timestamp belonging to specific band period."""
    bands = {
        "morning":   (6, 11),
        "afternoon": (12, 16),
        "evening":   (17, 20),
        "night":     (21, 23),
        "midnight":  (0, 3)
    }
    if base_date is None:
        base_date = datetime.date.today()

    rng = random.Random(seed)
    hour_start, hour_end = bands.get(band, (0, 23))

    hour = rng.randint(hour_start, hour_end)
    minute = rng.randint(0, 59)
    second = rng.randint(0, 59)

    dt = datetime.datetime.combine(
        base_date, datetime.time(hour=hour, minute=minute, second=second)
    )

    return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp())


def generate_dataset(n_rows=5000, include_geo=True, seed=42, out_csv="historical_audits.csv"):
    random.seed(seed)
    np.random.seed(seed)

    # model coefficients
    beta_intercept = -0.2
    beta_lighting = 0.6
    beta_visibility = 0.55
    beta_crowd = -0.35
    beta_cctv = 0.7
    beta_crime = -0.9
    beta_poi = 0.1
    beta_security = 0.9
    noise_std = 0.5

    poi_choices = [
        ("none", 0.0), ("bus_stop", 0.1), ("metro_station", 0.4),
        ("train_station", 0.35), ("park", -0.2), ("market", 0.1),
        ("mall", 0.3), ("bar", -0.4), ("atm", -0.1),
        ("school", 0.2), ("residential", 0.05), ("other", 0.0)
    ]
    poi_names = [p for p,_ in poi_choices]

    # Bengaluru bounding box
    lat_min, lat_max = 12.98, 13.10
    lon_min, lon_max = 77.58, 77.60

    bands = ["morning", "afternoon", "evening", "night", "midnight"]
    per_band = [n_rows // len(bands)] * len(bands)
    for i in range(n_rows % len(bands)):
        per_band[i] += 1

    rows = []
    base_date = datetime.date.today()

    idx = 0
    for b_idx, band in enumerate(bands):
        for j in range(per_band[b_idx]):
            row_seed = seed + idx
            rng = random.Random(row_seed)
            np_rng = np.random.RandomState(row_seed)

            lighting = int(np.clip(round(np_rng.normal(3.4, 1.0)), 1, 5))
            visibility = int(np.clip(round(np_rng.normal(3.2, 1.1)), 1, 5))

            # crowd density
            r = rng.random()
            if r < 0.45:
                crowd = "medium"; crowd_val = 1
            elif r < 0.75:
                crowd = "low"; crowd_val = 0
            else:
                crowd = "high"; crowd_val = 2

            crime_rate = int(np.clip(np_rng.poisson(1.1), 0, 5))

            # POI choice
            if crime_rate >= 4:
                weights = [1 if name not in ("bar","park","atm") else 3 
                           for name in poi_names]
            else:
                weights = [2 if name in ("metro_station","mall","train_station",
                                         "bus_stop","market") else 1 for name in poi_names]

            poi = rng.choices(poi_names, weights=weights, k=1)[0]

            # security
            if crime_rate >= 4:
                security_present = "no" if rng.random() < 0.7 else "yes"
            elif poi in ("metro_station","train_station","mall","school"):
                security_present = "yes" if rng.random() < 0.8 else "no"
            else:
                security_present = "yes" if rng.random() < 0.45 else "no"

            # cctv
            if security_present == "yes" or poi in ("metro_station","train_station","mall"):
                cctv = "yes" if rng.random() < 0.85 else "no"
            else:
                cctv = "yes" if rng.random() < 0.55 else "no"

            poi_bonus = dict(poi_choices)[poi]

            # ML-like safety model
            x = (
                beta_intercept
                + beta_lighting * (lighting / 5)
                + beta_visibility * (visibility / 5)
                + beta_cctv * (1 if cctv == "yes" else 0)
                + beta_crowd * (crowd_val / 2)
                + beta_crime * (crime_rate / 5)
                + beta_poi * poi_bonus
                + beta_security * (1 if security_present == "yes" else 0)
                + np_rng.normal(0, noise_std)
            )

            p_safe = sigmoid(x)
            score = round(p_safe, 4)
            severity = round(1 - p_safe, 3)

            ts = sample_timestamp_for_band(band, base_date, seed=row_seed)

            lat = round(rng.uniform(lat_min, lat_max), 6)
            lng = round(rng.uniform(lon_min, lon_max), 6)

            rows.append({
                "lat": lat,
                "lng": lng,
                "ts": ts,
                "score": score,              # NEW ✔
                "severity": severity,
                "crime_rate": crime_rate,
                "lighting": lighting,
                "visibility": visibility,
                "crowd_density": crowd,
                "cctv": cctv,
                "poi_type": poi,
                "security_present": security_present,
                "band": band
            })

            idx += 1

    # Shuffle rows
    rng_final = random.Random(seed + 999)
    rng_final.shuffle(rows)

    # ---- WRITE CSV ----
    fieldnames = [
        "lat","lng","ts","score","severity","crime_rate","lighting","visibility",
        "crowd_density","cctv","poi_type","security_present","band"
    ]

    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    # ---- WRITE JSON: ALWAYS audits_data.json ----
    json_path = "audits_data.json"
    with open(json_path, "w", encoding="utf-8") as jf:
        json.dump(rows, jf, indent=2)

    print(f"[OK] Generated {len(rows)} rows across {bands}")
    print(f"CSV saved → {out_csv}")
    print(f"JSON saved → audits_data.json")

    return out_csv, json_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=50)
    parser.add_argument("--geo", action="store_true")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=str, default="historical_audits.csv")
    args = parser.parse_args()

    generate_dataset(
        n_rows=args.n,
        include_geo=True,
        seed=args.seed,
        out_csv=args.out
    )
