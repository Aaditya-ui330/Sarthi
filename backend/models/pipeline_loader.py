# models/pipeline_loader.py
"""
Robust loader for the trained sklearn pipeline and optional legacy model.
Tries multiple candidate locations and prints clear diagnostics so any
process that imports this module can load the pipeline regardless of cwd.
"""

import os
import joblib
import traceback
from config import PIPELINE_PATH, LEGACY_MODEL_PATH

# Public vars users import
pipeline = None
legacy_model = None

def _abs_if_exists(p):
    """Return absolute path if p exists, else None."""
    try:
        p_abs = os.path.abspath(p)
        if os.path.exists(p_abs):
            return p_abs
    except Exception:
        pass
    return None

def _candidate_pipeline_paths():
    """
    Yield candidate paths to try for loading the pipeline, in order:
      1) configured PIPELINE_PATH (from config)
      2) package-relative models/<filename>
      3) repo-root <filename> (cwd)
      4) models/<filename> relative
      5) the literal filename (rely on import/workdir)
    """
    # 1) explicit config path (may be absolute or relative)
    if PIPELINE_PATH:
        yield PIPELINE_PATH

    # package dir (this file's directory) + filename
    pkg_dir = os.path.dirname(__file__)
    fname = os.path.basename(PIPELINE_PATH) if PIPELINE_PATH else "safety_pipeline.joblib"
    yield os.path.join(pkg_dir, fname)

    # repo/cwd + filename
    yield os.path.join(os.getcwd(), fname)

    # defensive extra: parent of pkg dir + filename
    yield os.path.abspath(os.path.join(pkg_dir, "..", fname))

    # final fallback: literal filename (as-is)
    yield fname

def _try_load(path):
    """Try to load with joblib; return object on success else None (and print error)."""
    try:
        obj = joblib.load(path)
        print(f"[pipeline_loader] loaded pipeline from: {path}")
        return obj
    except Exception as e:
        # Print full traceback so failures are visible in any process
        print(f"[pipeline_loader] failed to load pipeline from {path}: {type(e).__name__}: {e}")
        traceback.print_exc()
        return None

def load_models():
    """Attempt to load pipeline and legacy model into module-level vars."""
    global pipeline, legacy_model
    pipeline = None
    legacy_model = None

    # Try pipeline from several candidate locations
    for cand in _candidate_pipeline_paths():
        if not cand:
            continue
        cand_abs = os.path.abspath(cand)
        # If file exists at candidate, try to load; otherwise still attempt load (to show errors)
        if os.path.exists(cand_abs):
            pipeline_obj = _try_load(cand_abs)
            if pipeline_obj is not None:
                pipeline = pipeline_obj
                break
        else:
            # try to load even when not exists (to surface odd issues)
            pipeline_obj = _try_load(cand)
            if pipeline_obj is not None:
                pipeline = pipeline_obj
                break

    # If pipeline not loaded yet, try the configured LEGACY_MODEL_PATH (if present)
    if pipeline is None and LEGACY_MODEL_PATH:
        try:
            lm_path = os.path.abspath(LEGACY_MODEL_PATH)
            if os.path.exists(lm_path):
                try:
                    legacy_model = joblib.load(lm_path)
                    print(f"[pipeline_loader] loaded legacy model from: {lm_path}")
                except Exception as e:
                    print(f"[pipeline_loader] failed to load legacy model from {lm_path}: {type(e).__name__}: {e}")
                    traceback.print_exc()
                    legacy_model = None
            else:
                # attempt literal load to show errors if any
                try:
                    legacy_model = joblib.load(LEGACY_MODEL_PATH)
                    print(f"[pipeline_loader] loaded legacy model from literal path: {LEGACY_MODEL_PATH}")
                except Exception as e:
                    print(f"[pipeline_loader] failed to load legacy model from literal {LEGACY_MODEL_PATH}: {type(e).__name__}: {e}")
                    traceback.print_exc()
                    legacy_model = None
        except Exception as e:
            print(f"[pipeline_loader] unexpected error while loading legacy model: {e}")
            traceback.print_exc()
            legacy_model = None

# run loader at import so pipeline/legacy_model are populated for any importing process
load_models()