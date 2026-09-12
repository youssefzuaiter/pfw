"""
FastAPI ONNX sidecar for merchant-name embeddings (384 dimensions).

Trust boundary: localhost-only, called by the Next.js server only (see
docs/SECURITY.md's trust-boundary diagram and
src/server/embeddings/sidecar-client.ts on the Node side). No CORS
middleware is configured here on purpose — a browser has no way to reach
this service directly (no CORS headers means the browser's same-origin
policy blocks any cross-origin fetch attempt outright), and it isn't
meant to be reachable from anywhere but the app server's own network.

Run: uvicorn app.main:app --port 8001   (from the sidecar/ directory,
after `python -m app.build_model` has produced model/embedding_model.onnx)

The /tasks/* routes offload heavy anomaly-detection inference onto a
separate Celery worker process (app/celery_app.py, app/tasks.py) instead
of running it inline here -- that worker must be running, pointed at the
same Redis broker, for those two routes to do anything but enqueue work
that never gets picked up. See README.md's "Run the worker" section.
"""

from celery.result import AsyncResult
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .celery_app import celery_app
from .constants import EMBEDDING_DIM, MODEL_VERSION
from .embedding_model import ModelNotBuiltError, get_embedding_model
from .tasks import detect_spending_anomaly

MAX_BATCH_SIZE = 256
MAX_TEXT_LENGTH = 500

# The anomaly-detection window is fixed at 30 days (anomaly_constants.WINDOW_DAYS)
# but a day can genuinely hold many transactions -- this caps request size
# independently of that, the same "explicit limit, not implicit" habit
# MAX_BATCH_SIZE above already follows.
MAX_ANOMALY_TRANSACTIONS = 5000

app = FastAPI(title="PFW Merchant Embedding Sidecar", version=MODEL_VERSION)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=MAX_BATCH_SIZE)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dimensions: int = EMBEDDING_DIM
    model_version: str = MODEL_VERSION


class HealthResponse(BaseModel):
    status: str
    model_version: str
    dimensions: int


class AnomalyTransaction(BaseModel):
    occurred_at_iso: str
    # ge=0 is load-bearing, not decorative. `amount_agorot` is documented
    # as a POSITIVE expense magnitude (the Node caller negates signed
    # amounts before sending -- see getRecentExpenseTransactionsForAnomalyDetection),
    # and anomaly_features.normalize_window() feeds these straight into
    # math.log1p(), which raises `ValueError: math domain error` for any
    # value <= -1. Unconstrained, a single negative amount turned into a
    # task that always came back {"ok": false, "error": "invalid_input"}
    # -- a silent, permanently-failing pipeline rather than a clear 422 at
    # the boundary where the bad input actually entered.
    amount_agorot: float = Field(..., ge=0)
    category_slug: str


class AnomalyDetectRequest(BaseModel):
    # min_length=1 for the same reason: an empty window has no baseline to
    # z-score against, so it can only ever produce a meaningless result.
    transactions: list[AnomalyTransaction] = Field(
        ..., min_length=1, max_length=MAX_ANOMALY_TRANSACTIONS
    )
    window_end_date_key: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")


class TaskQueuedResponse(BaseModel):
    task_id: str
    status: str = "queued"


class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    result: dict | None = None


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        get_embedding_model()
    except ModelNotBuiltError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return HealthResponse(status="ok", model_version=MODEL_VERSION, dimensions=EMBEDDING_DIM)


@app.post("/embed", response_model=EmbedResponse)
def embed(request: EmbedRequest) -> EmbedResponse:
    for text in request.texts:
        if len(text) > MAX_TEXT_LENGTH:
            raise HTTPException(status_code=422, detail=f"Text exceeds {MAX_TEXT_LENGTH} characters")

    try:
        model = get_embedding_model()
    except ModelNotBuiltError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    vectors = model.embed(request.texts)
    return EmbedResponse(embeddings=vectors)


@app.post("/tasks/anomaly-detect", response_model=TaskQueuedResponse, status_code=202)
def enqueue_anomaly_detection(request: AnomalyDetectRequest) -> TaskQueuedResponse:
    """
    Enqueues the heavy inference (feature aggregation + normalization +
    ONNX forward pass) as a Celery task and returns immediately with a
    task id -- the actual work happens in a separate worker process
    (app/tasks.py), never inline in this request/response cycle. Poll
    GET /tasks/{task_id} for the result.
    """
    task = detect_spending_anomaly.delay(
        [t.model_dump() for t in request.transactions],
        request.window_end_date_key,
    )
    return TaskQueuedResponse(task_id=task.id)


@app.get("/tasks/{task_id}", response_model=TaskStatusResponse)
def get_task_status(task_id: str) -> TaskStatusResponse:
    """
    Polls a previously-enqueued task's status/result. Note a real, known
    Celery limitation: an unknown/never-issued task_id is indistinguishable
    from one that's genuinely still PENDING -- Celery has no "does this
    task id exist" check, by design (the broker only ever holds messages
    for tasks that haven't been picked up yet, and the result backend
    only gains an entry once a worker starts/finishes one) -- so this
    route can never return a 404 for a bogus id, only PENDING forever.
    """
    async_result = AsyncResult(task_id, app=celery_app)

    result_payload: dict | None = None
    if async_result.status == "SUCCESS":
        result_payload = async_result.result
    elif async_result.status == "FAILURE":
        result_payload = {"ok": False, "error": "task_failed", "detail": str(async_result.result)}

    return TaskStatusResponse(task_id=task_id, status=async_result.status, result=result_payload)
