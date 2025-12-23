# generate_bold_heat_data.py
import json, csv, random, datetime
random.seed(12345)

# Clusters inside your synthetic region for strong infrared hotspots
clusters = [
    {"center": (13.052, 77.592), "n": 40, "score_mu": 0.08, "score_sigma": 0.03, "samples_mu": 6, "confidence_mu": 0.12, "band":"midnight"},
    {"center": (13.008, 77.585), "n": 30, "score_mu": 0.18, "score_sigma": 0.05, "samples_mu": 8, "confidence_mu": 0.18, "band":"night"},
    {"center": (12.995, 77.594), "n": 35, "score_mu": 0.32, "score_sigma": 0.06, "samples_mu": 5, "confidence_mu": 0.25, "band":"evening"},
    {"center": (13.070, 77.590), "n": 45, "score_mu": 0.78, "score_sigma": 0.07, "samples_mu": 10, "confidence_mu": 0.8, "band":"morning"},
    {"center": (13.030, 77.587), "n": 50, "score_mu": 0.48, "score_sigma": 0.18, "samples_mu": 4, "confidence_mu": 0.4, "band":"afternoon"}
]

rows = []
now_ts = int(datetime.datetime.now(datetime.timezone.utc).timestamp())

# Generate clustered points
for c in clusters:
    cx, cy = c["center"]
    for i in range(c["n"]):
        lat = round(random.gauss(cx, 0.0022), 6)
        lng = round(random.gauss(cy, 0.0022), 6)
        score = max(0, min(1, random.gauss(c["score_mu"], c["score_sigma"])))
        severity = round(1-score, 3)
        samples = max(1, int(abs(random.gauss(c["samples_mu"], max(1, c["samples_mu"]*0.4)))))
        confidence = round(max(0.01, min(1.0, random.gauss(c["confidence_mu"], 0.07))), 3)
        ts = now_ts - random.randint(0, 30*24*3600)

        rows.append({
            "lat": lat, "lng": lng, "ts": ts,
            "score": round(score,4), "severity": severity,
            "samples": samples, "confidence": confidence,
            "crime_rate": random.randint(0,3),
            "lighting": random.randint(1,5),
            "visibility": random.randint(1,5),
            "crowd_density": random.choice(["low","medium","high"]),
            "cctv": "no" if random.random() < 0.4 else "yes",
            "poi_type": random.choice(["market","bus_stop","park","mall","train_station","none"]),
            "security_present": "no" if random.random() < 0.6 else "yes",
            "band": c["band"]
        })

# Add background scattered safe points
for i in range(40):
    lat = round(random.uniform(12.985, 13.095), 6)
    lng = round(random.uniform(77.582, 77.600), 6)
    score = round(random.uniform(0.6, 0.95), 3)
    rows.append({
        "lat": lat, "lng": lng,
        "ts": now_ts - random.randint(0,30*24*3600),
        "score": score, "severity": round(1-score,3),
        "samples": random.randint(1,6),
        "confidence": round(random.uniform(0.5,0.95),3),
        "crime_rate": random.randint(0,2),
        "lighting": random.randint(3,5),
        "visibility": random.randint(3,5),
        "crowd_density": random.choice(["low","medium","high"]),
        "cctv": "yes",
        "poi_type": random.choice(["mall","residential","school","none"]),
        "security_present": "yes",
        "band": random.choice(["morning","afternoon","evening"])
    })

# ---------------------------------
# WRITE OUTPUT FILES TO CORRECT LOCATIONS
# ---------------------------------

# EXACT name used by train.py
json_path = "audits_data.json"
# EXACT name used by synth_data_generator.py
csv_path = "historical_audits.csv"

# Save JSON
with open(json_path, "w", encoding="utf-8") as jf:
    json.dump(rows, jf, indent=2)

# Save CSV
fieldnames = ["lat","lng","ts","score","severity","samples","confidence","crime_rate",
              "lighting","visibility","crowd_density","cctv","poi_type","security_present","band"]

with open(csv_path, "w", newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, "") for k in fieldnames})

print(f"Generated {len(rows)} rows ->")
print(f" - {json_path}")
print(f" - {csv_path}")
