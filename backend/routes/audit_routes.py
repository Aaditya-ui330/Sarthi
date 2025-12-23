# services/audit_routes.py
from flask import Blueprint, request, jsonify
from services.audit_service import predict_score, audits_db, save_audits
from services.geospatial import get_time_band, latlng_to_cell_key
from services.auth_helpers import get_firebase_uid_from_request
import time, traceback

audit_bp = Blueprint("audit_bp", __name__, url_prefix="/api")

@audit_bp.route("/submit_audit", methods=["POST"])
def submit_audit():
    try:
        audit = request.get_json(silent=True)
        if not isinstance(audit, dict):
            return jsonify({"error": "Expected JSON body (Content-Type: application/json)"}), 400

        # parse/normalize timestamp -> use 'ts' as canonical field
        ts_raw = audit.get("timestamp") or audit.get("ts")
        if ts_raw is None:
            ts = int(time.time())
        else:
            try:
                ts = int(float(ts_raw))
            except:
                ts = int(time.time())

        # determine time band (use server time if timestamp missing)
        time_band = get_time_band(ts)

        # lat/lng normalization
        lat = audit.get("lat"); lng = audit.get("lng")
        try:
            lat = float(lat) if lat is not None and lat != "" else None
        except:
            lat = None
        try:
            lng = float(lng) if lng is not None and lng != "" else None
        except:
            lng = None

        # accuracy handling: if provided and large, degrade precision
        try:
            accuracy_m = float(audit.get("accuracy", 0.0) or 0.0)
        except:
            accuracy_m = 0.0
        if lat is not None and lng is not None and accuracy_m > 200:
            lat = round(lat, 3)
            lng = round(lng, 3)

        # compute cell_id (use the canonical function name latlng_to_cell_key)
        cell_id = latlng_to_cell_key(lat, lng) if lat is not None and lng is not None else None

        # compute safety score (predict_score may raise if no model)
        try:
            prob = predict_score(audit)
        except Exception as e:
            # Log traceback server-side, return a clear message to client
            traceback.print_exc()
            # Use None as safety_score if prediction fails
            prob = None

        # Build canonical audit record keys: ts, band, cell_id, safety_score
        uid = get_firebase_uid_from_request()
        if uid is None:
            return jsonify({"error": "User authentication failed or UID missing"}), 401
        audit_record = {
            **audit,
            "user_id": uid,
            "ts": ts,
            "band": time_band,
            "lat": lat,
            "lng": lng,
            "cell_id": cell_id,
            "safety_score": prob,
            "calculated_score": round(prob, 3) if prob is not None else None
        }

        audits_db.append(audit_record)
        save_audits()

        resp = {"message": "Audit submitted", "band": time_band}
        if prob is not None:
            resp["calculated_score"] = round(prob, 3)
        else:
            resp["calculated_score"] = None
            resp["note"] = "Model prediction unavailable; score saved as null."

        return jsonify(resp), 201

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@audit_bp.route('/user/audits', methods=['GET'])
def get_user_audits():
    uid = get_firebase_uid_from_request()
    if not uid:
        return jsonify([]), 401
    # Only return audits where 'user_id' matches the logged-in user
    user_audits = [a for a in audits_db if a.get('user_id') == uid]
    return jsonify(user_audits), 200

def register_audit_routes(app):
    app.register_blueprint(audit_bp)