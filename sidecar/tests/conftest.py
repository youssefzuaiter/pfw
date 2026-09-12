"""
Shared fixtures for the sidecar's test suite.

The exported ONNX model (model/embedding_model.onnx) is gitignored by
design (see app/build_model.py's own docstring) -- any fresh checkout,
including a CI runner, has no model file until something builds one.
`ensure_model_is_built` makes that a one-time, self-healing step instead
of a manual prerequisite someone has to remember: CI's own workflow step
builds it explicitly too (so a fresh runner never pays this fixture's
build cost inside the test run itself), but a plain `pytest` run from a
clean checkout -- exactly what a new contributor or a misconfigured CI
step would do -- now still works.

`anyio_backend` is what lets `@pytest.mark.anyio` tests use a real
`httpx.AsyncClient` against the ASGI app directly (see test_main_http.py
and test_concurrency.py) without adding pytest-asyncio as a dependency --
anyio itself already ships a pytest plugin, and anyio is already an
existing dependency of httpx, so this needs no new package.
"""

import pathlib

import pytest

from app.build_model import MODEL_OUTPUT_PATH, build_and_save
from app.celery_app import celery_app


@pytest.fixture(scope="session", autouse=True)
def ensure_model_is_built() -> pathlib.Path:
    if not MODEL_OUTPUT_PATH.exists():
        build_and_save()
    return MODEL_OUTPUT_PATH


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def celery_eager_mode():
    """
    Runs Celery tasks synchronously, in-process, with no real Redis
    broker/worker involved -- `.delay()` executes immediately and
    `AsyncResult` reads back a real (not faked) result. This is what lets
    tests/test_tasks.py and tests/test_main_tasks_http.py run cleanly in
    CI (and anywhere else) with zero infrastructure beyond what's already
    needed for the rest of this suite -- see docker-compose.yml for how
    to run a REAL worker+broker for genuine end-to-end/manual verification
    instead.
    """
    original_eager = celery_app.conf.task_always_eager
    original_propagates = celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    yield celery_app
    celery_app.conf.task_always_eager = original_eager
    celery_app.conf.task_eager_propagates = original_propagates
