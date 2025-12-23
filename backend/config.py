import os

# File paths (relative)
AUDIT_FILE = os.getenv("AUDIT_FILE", "audits_data.json")
PIPELINE_PATH = os.getenv("PIPELINE_PATH", "safety_pipeline.joblib")
LEGACY_MODEL_PATH = os.getenv("LEGACY_MODEL_PATH", "safety_model.joblib")

# Geocoding
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "safety-audit-app/1.0"

# Grid/decay constants (same as before)
GRID_RES_DEGREES = float(os.getenv("GRID_RES_DEGREES", 0.001))
T_HALF_HOURS = float(os.getenv("T_HALF_HOURS", 72.0))
K_CONF = float(os.getenv("K_CONF", 5.0))
LN2 = 0.6931471805599453
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "dev-token")
