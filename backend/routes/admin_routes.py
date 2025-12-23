from flask import Blueprint, request, jsonify
from config import ADMIN_TOKEN
from functools import wraps
from models.pipeline_loader import load_models

admin_bp = Blueprint("admin_bp", __name__, url_prefix="/admin")

def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get("X-ADMIN-TOKEN")
        if token != ADMIN_TOKEN:
            return jsonify({"error": "unauthorized"}), 403
        return f(*args, **kwargs)
    return wrapper

@admin_bp.route("/reload_model", methods=["POST"])
@require_admin
def reload_model():
    try:
        load_models()
        from models.pipeline_loader import pipeline, legacy_model
        if pipeline is not None:
            return jsonify({"message":"pipeline reloaded"}), 200
        if legacy_model is not None:
            return jsonify({"message":"legacy model reloaded"}), 200
        return jsonify({"error":"no model found"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500
