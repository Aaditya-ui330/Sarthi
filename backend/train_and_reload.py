# train_and_reload.py
"""
Automatic retrain + reload helper.

Usage:
  # Run once (useful for CI / cron)
  python train_and_reload.py --run-once

  # Run continuously, retrain every 24h (86400s)
  python train_and_reload.py --interval 86400

  # Custom admin token and server URL
  python train_and_reload.py --run-once --admin-token "my-secret" --server "http://127.0.0.1:5000"

Notes:
- This script calls `python train.py` in the same folder. Keep train.py unchanged.
- After successful training, it will POST to /admin/reload_model with header X-ADMIN-TOKEN.
- Set ADMIN_TOKEN env var if you prefer not to pass it on the command line.
"""
import argparse
import subprocess
import os
import sys
import time
import requests
from datetime import datetime

from config import PIPELINE_PATH, ADMIN_TOKEN
DEFAULT_SERVER = os.getenv("SERVER_URL", "http://127.0.0.1:5000")
# use ADMIN_TOKEN when posting reload


def log(msg):
    print(f"[{datetime.now().isoformat()}] {msg}", flush=True)

def run_training(python_exe=None):
    """Call the project's train.py using subprocess. Returns True on success."""
    python_cmd = python_exe or sys.executable or "python"
    cmd = [python_cmd, "train.py"]
    log(f"Running training command: {' '.join(cmd)}")
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=3600)
        log("train.py finished successfully.")
        # Print last few lines of output for visibility
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        if out:
            log("train.py stdout (truncated):")
            log(out.splitlines()[-20:] and "\n".join(out.splitlines()[-20:]))
        if err:
            log("train.py stderr (truncated):")
            log(err.splitlines()[-20:] and "\n".join(err.splitlines()[-20:]))
        return True
    except subprocess.CalledProcessError as e:
        log(f"train.py failed with return code {e.returncode}")
        if e.stdout:
            log("train.py stdout (truncated):")
            log("\n".join((e.stdout or "").splitlines()[-20:]))
        if e.stderr:
            log("train.py stderr (truncated):")
            log("\n".join((e.stderr or "").splitlines()[-50:]))
        return False
    except Exception as e:
        log(f"Exception when running train.py: {e}")
        return False

def check_pipeline_exists(path=PIPELINE_PATH):
    exists = os.path.exists(path)
    log(f"Checking pipeline at '{path}': {'FOUND' if exists else 'MISSING'}")
    return exists

def post_reload(server_url, admin_token, retries=3, backoff=3):
    """Call POST /admin/reload_model with X-ADMIN-TOKEN header. Returns True on 2xx."""
    url = server_url.rstrip("/") + "/admin/reload_model"
    headers = {"X-ADMIN-TOKEN": admin_token}
    for attempt in range(1, retries+1):
        try:
            log(f"POST {url} (attempt {attempt})")
            resp = requests.post(url, headers=headers, timeout=10)
            if 200 <= resp.status_code < 300:
                log(f"Reload successful (HTTP {resp.status_code}) - response: {resp.text}")
                return True
            else:
                log(f"Reload failed (HTTP {resp.status_code}) - response: {resp.text}")
        except Exception as e:
            log(f"Error posting reload: {e}")
        if attempt < retries:
            time.sleep(backoff * attempt)
    return False

def run_once(server_url, admin_token, python_exe=None):
    log("Starting single retrain+reload run")
    ok = run_training(python_exe=python_exe)
    if not ok:
        log("Training failed; aborting reload.")
        return False
    if not check_pipeline_exists():
        log(f"Expected pipeline file '{PIPELINE_PATH}' not found after training. Aborting.")
        return False
    ok_reload = post_reload(server_url, admin_token)
    if not ok_reload:
        log("Reload endpoint failed. You may need to reload model manually.")
        return False
    log("Retrain + reload completed successfully.")
    return True

def run_daemon(interval_s, server_url, admin_token, python_exe=None):
    log(f"Starting daemon mode: interval={interval_s}s")
    while True:
        try:
            ok = run_once(server_url, admin_token, python_exe=python_exe)
            if not ok:
                log("One iteration failed; will retry at next interval.")
        except Exception as e:
            log(f"Unexpected error in loop: {e}")
        log(f"Sleeping for {interval_s} seconds...")
        time.sleep(interval_s)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run-once", action="store_true", help="Run train.py once then reload model and exit")
    p.add_argument("--interval", type=int, default=None, help="If set, run continuously every INTERVAL seconds")
    p.add_argument("--server", type=str, default=os.getenv("RELOAD_SERVER", DEFAULT_SERVER), help="Server base URL (default http://127.0.0.1:5000)")
    p.add_argument("--admin-token", type=str, default=os.getenv("ADMIN_TOKEN", "dev-token"), help="Admin token for reload endpoint (default: from ADMIN_TOKEN env or 'dev-token')")
    p.add_argument("--python", type=str, default=None, help="Python executable to run train.py (default: current interpreter)")
    args = p.parse_args()

    if not args.run_once and not args.interval:
        p.error("Specify --run-once or --interval N (seconds) to run continuously.")

    if args.run_once:
        success = run_once(args.server, args.admin_token, python_exe=args.python)
        sys.exit(0 if success else 2)

    if args.interval:
        try:
            run_daemon(args.interval, args.server, args.admin_token, python_exe=args.python)
        except KeyboardInterrupt:
            log("Daemon interrupted by user, exiting.")
            sys.exit(0)

if __name__ == "__main__":
    main()
