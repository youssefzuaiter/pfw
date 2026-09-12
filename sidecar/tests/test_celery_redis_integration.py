"""
The one test file in this suite that needs REAL infrastructure: a real
Redis (the broker + result backend) and a real, separate Celery worker
process consuming from it -- proving the actual thing this feature exists
for (heavy inference genuinely runs off the FastAPI request/response
cycle, in another process, communicating only through Redis) rather than
trusting that eager-mode tests (test_tasks.py, test_main_tasks_http.py)
correctly stand in for it.

Skipped automatically when Redis isn't reachable at CELERY_BROKER_URL --
same environment-gated-skip convention this app's Node side already uses
for its embedding-sidecar integration test (`describe.skipIf(!process.env...)`).
Locally: `docker compose up -d redis` from the repo root (see compose.yaml)
makes this runnable; CI's sidecar-tests job runs a real `redis:` service
container so this genuinely executes there too, rather than being skipped
the way the Node-side embedding-sidecar test is (Redis is now first-class,
load-bearing infra for THIS service, not a separately-deployed service
this workflow merely calls out to -- see ci.yml's own comment on the
difference).

This file starts its own real Celery worker subprocess against whatever
Redis is configured -- it does not assume one is already running.
"""

import socket
import subprocess
import sys
import time
from urllib.parse import urlparse

import httpx
import pytest

from app.celery_app import CELERY_BROKER_URL
from app.main import app

WORKER_STARTUP_TIMEOUT_SECONDS = 20
POLL_INTERVAL_SECONDS = 0.5
TASK_RESULT_TIMEOUT_SECONDS = 15


def _redis_is_reachable(broker_url: str) -> bool:
    parsed = urlparse(broker_url)
    try:
        with socket.create_connection((parsed.hostname, parsed.port or 6379), timeout=1):
            return True
    except OSError:
        return False


requires_real_redis = pytest.mark.skipif(
    not _redis_is_reachable(CELERY_BROKER_URL),
    reason=f"No Redis reachable at {CELERY_BROKER_URL} -- run `docker compose up -d redis` from the repo root.",
)


@pytest.fixture
def real_celery_worker():
    """Starts a genuine `celery worker` subprocess against the real, already-verified-reachable
    broker, waits for it to report ready, yields, then always tears it down."""
    process = subprocess.Popen(
        [sys.executable, "-m", "celery", "-A", "app.celery_app:celery_app", "worker", "--loglevel=info", "--concurrency=1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + WORKER_STARTUP_TIMEOUT_SECONDS
        ready = False
        while time.monotonic() < deadline:
            line = process.stdout.readline()
            if not line:
                if process.poll() is not None:
                    break
                continue
            if "ready." in line:
                ready = True
                break
        if not ready:
            process.terminate()
            output = process.stdout.read() if process.stdout else ""
            pytest.fail(f"Celery worker never reported ready within {WORKER_STARTUP_TIMEOUT_SECONDS}s:\n{output}")
        yield process
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


@pytest.fixture
async def async_client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sidecar.test") as client:
        yield client


@requires_real_redis
@pytest.mark.anyio
async def test_the_real_async_round_trip_through_a_separate_worker_process(
    async_client: httpx.AsyncClient, real_celery_worker
):
    request_body = {
        "transactions": [
            {"occurred_at_iso": "2026-09-12T10:00:00Z", "amount_agorot": 5000.0, "category_slug": "groceries"}
        ],
        "window_end_date_key": "2026-09-12",
    }

    enqueue_response = await async_client.post("/tasks/anomaly-detect", json=request_body)
    assert enqueue_response.status_code == 202
    task_id = enqueue_response.json()["task_id"]

    deadline = time.monotonic() + TASK_RESULT_TIMEOUT_SECONDS
    status_response = None
    while time.monotonic() < deadline:
        status_response = await async_client.get(f"/tasks/{task_id}")
        assert status_response.status_code == 200
        if status_response.json()["status"] in ("SUCCESS", "FAILURE"):
            break
        time.sleep(POLL_INTERVAL_SECONDS)

    assert status_response is not None
    body = status_response.json()
    assert body["status"] == "SUCCESS", f"Task never succeeded within {TASK_RESULT_TIMEOUT_SECONDS}s: {body}"
    assert body["result"]["ok"] is True
    assert body["result"]["tier"] in ("HIGH", "MARGINAL", "NORMAL")


@requires_real_redis
@pytest.mark.anyio
async def test_an_unknown_task_id_reads_as_pending_against_the_real_backend(async_client: httpx.AsyncClient):
    # No worker needed for this one -- proves the real (not mocked)
    # Redis result-backend lookup behaves exactly as documented in
    # main.py's own doc comment (an unissued id looks identical to a
    # not-yet-started one).
    response = await async_client.get("/tasks/genuinely-never-issued-id")
    assert response.status_code == 200
    assert response.json()["status"] == "PENDING"
