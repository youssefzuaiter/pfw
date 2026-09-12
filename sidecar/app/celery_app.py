"""
Celery application for offloading heavy inference off the FastAPI
request/response cycle -- see app/tasks.py for the actual task and
main.py's `/tasks/*` routes for how a request enqueues one and later
polls its result.

Broker and result backend are both Redis (a `keyvalue` service in
render.yaml). Configured entirely from environment variables so the same
code runs against a local `redis://localhost:6379/...` (docker compose,
below) and Render's injected `CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND`
(populated via render.yaml's `fromService`/`connectionString`) with no
code change between environments -- the same "one source of truth, env-
driven" convention this app's Node side already follows for
DATABASE_URL/EMBEDDING_SIDECAR_URL (AGENTS.md §3i).

Run the worker (from sidecar/, with the venv active):
    celery -A app.celery_app:celery_app worker --loglevel=info --concurrency=2
"""

import os

from celery import Celery

CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = os.environ.get("CELERY_RESULT_BACKEND", "redis://localhost:6379/1")

celery_app = Celery(
    "pfw_sidecar",
    broker=CELERY_BROKER_URL,
    backend=CELERY_RESULT_BACKEND,
    include=["app.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    # Anomaly detection is a per-dashboard-load, single-shot inference
    # (matches the client-side Worker's own "runs once, not repeatedly"
    # framing, AGENTS.md §3ll) -- a stuck/hung task should surface as a
    # timeout, not run forever and quietly pin a worker slot.
    task_time_limit=30,
    task_soft_time_limit=20,
    # Redis-as-broker has no message-level ack beyond visibility timeout
    # (unlike RabbitMQ) -- late acks mean a worker that crashes mid-task
    # requeues the task instead of silently losing it.
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    result_expires=3600,
)
