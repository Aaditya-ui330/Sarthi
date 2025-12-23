from flask import Flask, Response, jsonify, send_from_directory
from flask_cors import CORS
import os

# Absolute path to frontend folder
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))

# Create app
app = Flask( __name__,
    static_folder=FRONTEND_DIR,
    static_url_path="")
CORS(app)

# Register blueprints (routes)
from routes.audit_routes import audit_bp
from routes.heatmap_routes import heatmap_bp
from routes.route_routes import route_bp
from routes.admin_routes import admin_bp

app.register_blueprint(audit_bp)
app.register_blueprint(heatmap_bp)
app.register_blueprint(route_bp)
app.register_blueprint(admin_bp)

# OpenAPI / Swagger static endpoint (keeps same UI)
from services.heatmap_service import OPENAPI, SWAGGER_HTML

@app.route("/openapi.json")
def openapi_json():
    return jsonify(OPENAPI)

@app.route("/docs")
def docs_ui():
    return Response(SWAGGER_HTML, mimetype="text/html")

@app.route("/")
def home():
    return "✅ Flask Safety Audit API is running! Use /api/submit_audit or /api/heatmap_data"

if __name__ == "__main__":
    # Ensure models are loaded on start
    from models.pipeline_loader import load_models
    load_models()
    app.run(host="0.0.0.0", port=5000,debug=True)
