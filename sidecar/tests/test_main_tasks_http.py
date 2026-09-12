"""
HTTP-level coverage for the /tasks/* routes (app/main.py).

POST /tasks/anomaly-detect is tested via celery_eager_mode (conftest.py)
-- `.delay()` runs synchronously with no real broker needed, so these
are fast and CI-safe. GET /tasks/{task_id} is tested by monkeypatching
`app.main.AsyncResult` directly -- that route's whole job is mapping a
Celery status onto an HTTP response shape, which is exactly what a
controlled fake status/result lets this file test without a real Redis
result backend. The actual real-broker, real-worker, real-Redis round
trip between these two routes is proven separately in
tests/test_celery_redis_integration.py.
"""

import httpx
import pytest

from app.main import MAX_ANOMALY_TRANSACTIONS, app


@pytest.fixture
async def async_client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sidecar.test") as client:
        yield client


def _valid_request_body() -> dict:
    return {
        "transactions": [
            {"occurred_at_iso": "2026-09-12T10:00:00Z", "amount_agorot": 100.0, "category_slug": "groceries"}
        ],
        "window_end_date_key": "2026-09-12",
    }


# --- POST /tasks/anomaly-detect (real task execution, eager mode) ------


@pytest.mark.anyio
async def test_enqueue_anomaly_detection_returns_202_with_a_task_id(async_client: httpx.AsyncClient, celery_eager_mode):
    response = await async_client.post("/tasks/anomaly-detect", json=_valid_request_body())
    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "queued"
    assert isinstance(body["task_id"], str) and len(body["task_id"]) > 0


@pytest.mark.anyio
async def test_enqueue_anomaly_detection_accepts_an_empty_transaction_list(
    async_client: httpx.AsyncClient, celery_eager_mode
):
    response = await async_client.post(
        "/tasks/anomaly-detect", json={"transactions": [], "window_end_date_key": "2026-09-12"}
    )
    assert response.status_code == 202


@pytest.mark.anyio
async def test_enqueue_anomaly_detection_rejects_a_malformed_date_key(
    async_client: httpx.AsyncClient, celery_eager_mode
):
    response = await async_client.post(
        "/tasks/anomaly-detect", json={"transactions": [], "window_end_date_key": "09/12/2026"}
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_enqueue_anomaly_detection_rejects_a_batch_over_the_size_limit(
    async_client: httpx.AsyncClient, celery_eager_mode
):
    oversized = {
        "transactions": [
            {"occurred_at_iso": "2026-09-12T10:00:00Z", "amount_agorot": 1.0, "category_slug": "groceries"}
        ]
        * (MAX_ANOMALY_TRANSACTIONS + 1),
        "window_end_date_key": "2026-09-12",
    }
    response = await async_client.post("/tasks/anomaly-detect", json=oversized)
    assert response.status_code == 422


@pytest.mark.anyio
async def test_enqueue_anomaly_detection_rejects_missing_fields(async_client: httpx.AsyncClient, celery_eager_mode):
    response = await async_client.post("/tasks/anomaly-detect", json={"transactions": []})
    assert response.status_code == 422


# --- GET /tasks/{task_id} (status-mapping logic, mocked AsyncResult) ---


class _FakeAsyncResult:
    def __init__(self, status: str, result=None):
        self.status = status
        self.result = result


@pytest.mark.anyio
async def test_get_task_status_success_returns_the_full_result(
    async_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    fake = _FakeAsyncResult("SUCCESS", result={"ok": True, "tier": "NORMAL"})
    monkeypatch.setattr("app.main.AsyncResult", lambda task_id, app: fake)

    response = await async_client.get("/tasks/some-task-id")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "SUCCESS"
    assert body["result"] == {"ok": True, "tier": "NORMAL"}


@pytest.mark.anyio
async def test_get_task_status_failure_wraps_the_error(async_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
    fake = _FakeAsyncResult("FAILURE", result=RuntimeError("boom"))
    monkeypatch.setattr("app.main.AsyncResult", lambda task_id, app: fake)

    response = await async_client.get("/tasks/some-task-id")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "FAILURE"
    assert body["result"]["ok"] is False
    assert "boom" in body["result"]["detail"]


@pytest.mark.anyio
async def test_get_task_status_pending_has_no_result_yet(async_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
    fake = _FakeAsyncResult("PENDING", result=None)
    monkeypatch.setattr("app.main.AsyncResult", lambda task_id, app: fake)

    response = await async_client.get("/tasks/some-task-id")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "PENDING"
    assert body["result"] is None


@pytest.mark.anyio
async def test_get_task_status_of_an_unknown_id_is_pending_not_404(
    async_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    # Documented, real Celery limitation (see main.py's own doc comment
    # on this route): there is no way to distinguish a genuinely unknown
    # task id from one that hasn't started yet.
    fake = _FakeAsyncResult("PENDING", result=None)
    monkeypatch.setattr("app.main.AsyncResult", lambda task_id, app: fake)

    response = await async_client.get("/tasks/this-id-was-never-issued")
    assert response.status_code == 200
    assert response.json()["status"] == "PENDING"
