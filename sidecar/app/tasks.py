"""
Celery tasks. Kept deliberately thin -- all the real logic lives in
app.anomaly_model.AnomalyModel.detect (a plain function with no Celery
dependency at all), so it's testable by calling it directly with no
broker/worker involved (see tests/test_anomaly_model.py) and the task
wrapper below only has to handle the framework plumbing: same "pure
function separate from framework wiring" split this app's Node side uses
everywhere (src/lib/ engines vs. src/server/ wiring, AGENTS.md §3b).

`bind=True` + returning a plain dict (not raising) on a domain-level
failure keeps AsyncResult.status at SUCCESS with a `{"ok": false, ...}`
payload for an expected failure (the model genuinely isn't built yet),
reserving Celery's own FAILURE/retry machinery for a real, unexpected
crash.
"""

from celery.utils.log import get_task_logger

from .anomaly_model import AnomalyModelNotBuiltError, get_anomaly_model
from .celery_app import celery_app

logger = get_task_logger(__name__)


@celery_app.task(name="app.tasks.detect_spending_anomaly", bind=True, max_retries=2, default_retry_delay=5)
def detect_spending_anomaly(self, transactions: list[dict], window_end_date_key: str) -> dict:
    try:
        model = get_anomaly_model()
    except AnomalyModelNotBuiltError as error:
        logger.warning("Anomaly model unavailable: %s", error)
        return {"ok": False, "error": "model_not_built", "detail": str(error)}

    try:
        result = model.detect(transactions, window_end_date_key)
    except ValueError as error:
        # A malformed window_end_date_key or similar caller error -- not
        # transient, retrying would never help, so this doesn't go
        # through self.retry.
        return {"ok": False, "error": "invalid_input", "detail": str(error)}

    return {"ok": True, **result}
