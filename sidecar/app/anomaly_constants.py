"""
Constants for the server-side spending-anomaly-detection pipeline.

Every value here is copied from two sources that must stay in lockstep:
public/models/spending_anomaly.meta.json (the trained model's own
metadata) and src/lib/ml/anomaly-worker-handlers.ts (the browser-side
implementation of this exact pipeline, AGENTS.md §3ll) -- this module is
a deliberate, careful Python port of that TypeScript file, not an
independent reimplementation, since the two must agree byte-for-byte on
feature order and normalization or a request routed to this server-side
path would silently classify differently than the client-side one.

Regenerate every constant below (via ml-pipeline/train_autoencoder.py) if
the model is ever retrained with different hyperparameters or a new
bootstrap run -- see that script's own docstring.
"""

import pathlib

WINDOW_DAYS = 30  # must match ml-pipeline/synthesize_ledger.py's WINDOW_DAYS
BASELINE_DAYS = 29  # must match ml-pipeline/train_autoencoder.py's BASELINE_DAYS
RECENT_EVAL_DAYS = 1  # must match ml-pipeline/train_autoencoder.py's RECENT_EVAL_DAYS
BURST_WINDOW_MINUTES = 3 * 60  # must match ml-pipeline/synthesize_ledger.py's BURST_WINDOW_MINUTES

# Copied from public/models/spending_anomaly.meta.json's "thresholds".
THETA_LO = 1.0396369874477387
THETA_HI = 1.2275562047958375

CATEGORIES = ("groceries", "dining", "subscriptions", "shopping", "transport", "entertainment", "other")

FEATURE_NAMES = (
    "total_spend_agorot",
    "transaction_count",
    "max_3h_burst_count",
    *[f"cat_{c}_agorot" for c in CATEGORIES],
)
NUM_FEATURES = len(FEATURE_NAMES)

# Mirrors src/lib/ml/anomaly-worker-handlers.ts's CATEGORY_SLUG_TO_BUCKET
# exactly -- see that file's own doc comment for why `rent` maps to
# `subscriptions` and why an unrecognized slug falls back to `other`
# rather than throwing.
CATEGORY_SLUG_TO_BUCKET = {
    "groceries": "groceries",
    "dining": "dining",
    "transport": "transport",
    "entertainment": "entertainment",
    "shopping": "shopping",
    "rent": "subscriptions",
    "utilities": "other",
    "health": "other",
    "uncategorized": "other",
}

# This service is deployed independently of the Next.js app (see
# render.yaml's `rootDir: sidecar`), but this path deliberately points
# *outside* sidecar/ to the one canonical, committed model artifact
# under public/models/ rather than a duplicated copy -- a monorepo
# checkout (Render's included) still contains the whole repo even when a
# service's rootDir scopes its build/start working directory (see
# render.yaml's own comment for the real, verified consequence of this:
# a model retrain doesn't auto-trigger a redeploy of this service, since
# that file lives outside sidecar/'s rootDir).
ANOMALY_MODEL_PATH = pathlib.Path(__file__).parent.parent.parent / "public" / "models" / "spending_anomaly.onnx"
