# train.py
"""
Final robust train.py (version-safe for OneHotEncoder).
Reads: historical_audits.csv
Writes: safety_pipeline.joblib (preprocessor + classifier pipeline)

Usage:
    python train.py

Notes:
 - This file adapts to scikit-learn versions that use either `sparse` or `sparse_output`.
 - Expects columns including (recommended):
     lighting, visibility, crowd_density, cctv, crime_rate, poi_type, security_present, overall_safe
 - If columns are missing, reasonable defaults are filled.
"""
import os
import joblib
import pandas as pd
import numpy as np
import sklearn
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler, OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, accuracy_score
import inspect
import sys

from config import PIPELINE_PATH
CSV_PATH = "historical_audits.csv"

# Fixed mappings to keep app/train consistent
CROWD_MAP = {"low": 0, "medium": 1, "high": 2}
CCTV_MAP = {"yes": 1, "no": 0}
SECURITY_DEFAULT = "not_sure"
POI_DEFAULT = "none"


def make_onehot_encoder_safe(**kwargs):
    """
    Construct OneHotEncoder in a way that works across sklearn versions.
    Prefer using 'sparse_output' when available; fall back to 'sparse'.
    """
    sig = inspect.signature(OneHotEncoder)
    params = sig.parameters
    if "sparse_output" in params:
        # sklearn >= ~1.2
        return OneHotEncoder(handle_unknown="ignore", sparse_output=kwargs.get("sparse_output", False))
    elif "sparse" in params:
        # older sklearn
        return OneHotEncoder(handle_unknown="ignore", sparse=kwargs.get("sparse", False))
    else:
        # last-resort: try default constructor and hope for best
        return OneHotEncoder(handle_unknown="ignore")


def load_and_prepare(csv_path=CSV_PATH):
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"{csv_path} not found. Generate synthetic data or export your real data to this path.")

    df = pd.read_csv(csv_path)
    print("Columns detected:", list(df.columns))

    # Ensure numeric fields exist and coerce
    for col in ["lighting", "visibility", "crime_rate"]:
        if col not in df.columns:
            print(f"Warning: {col} missing — filling with zeros")
            df[col] = 0
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    # crowd_density -> numeric crowd
    if "crowd_density" not in df.columns:
        print("Warning: crowd_density missing — defaulting to 'medium'")
        df["crowd_density"] = "medium"
    df["crowd"] = df["crowd_density"].astype(str).str.lower().map(CROWD_MAP).fillna(1).astype(int)

    # cctv -> flag
    if "cctv" not in df.columns:
        print("Warning: cctv missing — defaulting to 'yes'")
        df["cctv"] = "yes"
    df["cctv_flag"] = df["cctv"].astype(str).str.lower().map(CCTV_MAP).fillna(1).astype(int)

    # poi_type and security_present: ensure exist
    if "poi_type" not in df.columns:
        df["poi_type"] = POI_DEFAULT
    else:
        df["poi_type"] = df["poi_type"].fillna(POI_DEFAULT).astype(str)

    if "security_present" not in df.columns:
        df["security_present"] = SECURITY_DEFAULT
    else:
        df["security_present"] = df["security_present"].fillna(SECURITY_DEFAULT).astype(str)

    # target
    target_col = "overall_safe"
    if target_col not in df.columns:
        raise KeyError(f"Target column '{target_col}' not found in {csv_path}. Please include overall_safe (0/1).")

    # Build feature DataFrame (order matters)
    X = pd.DataFrame({
        "lighting": df["lighting"].astype(float),
        "visibility": df["visibility"].astype(float),
        "crime_rate": df["crime_rate"].astype(float),
        "crowd": df["crowd"].astype(int),
        "cctv_flag": df["cctv_flag"].astype(int),
        "poi_type": df["poi_type"].astype(str),
        "security_present": df["security_present"].astype(str)
    })
    y = df[target_col].astype(int)

    return X, y


def build_and_train(X, y):
    numeric_features = ["lighting", "visibility", "crime_rate", "crowd", "cctv_flag"]
    categorical_features = ["poi_type", "security_present"]

    # Create version-safe OneHotEncoder
    onehot = make_onehot_encoder_safe(sparse_output=False, sparse=False)

    preprocessor = ColumnTransformer(transformers=[
        ("num", StandardScaler(), numeric_features),
        ("cat", onehot, categorical_features)
    ], remainder="drop")

    pipeline = Pipeline([
        ("pre", preprocessor),
        ("clf", LogisticRegression(max_iter=2000, class_weight="balanced", solver="lbfgs"))
    ])

    # stratify if binary target
    strat = y if len(set(y)) == 2 else None
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=strat)

    pipeline.fit(X_train, y_train)

    # Evaluate
    y_pred = pipeline.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"Test accuracy: {acc:.4f}")
    print("Classification report:")
    print(classification_report(y_test, y_pred))

    return pipeline


def main():
    print(f"scikit-learn version: {sklearn.__version__}", file=sys.stderr)
    X, y = load_and_prepare(CSV_PATH)
    print("Training pipeline...")
    pipeline = build_and_train(X, y)
    print(f"Saving pipeline to {PIPELINE_PATH} ...")
    joblib.dump(pipeline, PIPELINE_PATH)
    print("Done. Pipeline saved as", PIPELINE_PATH)


if __name__ == "__main__":
    main()
