"""
Task-logic tests, run via Celery's own `task_always_eager` mode -- the
task body executes synchronously, in-process, with no real Redis broker
or worker involved. This is Celery's own documented way to unit-test a
task's logic; the actual async dispatch/broker/worker machinery is
proven separately, against a REAL Redis + a real worker process, in
tests/test_celery_redis_integration.py.

Deliberately reads the result straight off the object `.delay()` returns
(an EagerResult), never through a fresh `AsyncResult(task_id)` lookup --
verified by hand that a fresh lookup in eager mode tries to hit the real
result backend (Redis) even with `task_always_eager=True`, and fails
with no broker running. `task_store_eager_result=True` looked like the
fix at first glance but turned out to make `.delay()` itself require a
reachable backend (confirmed live, not assumed) -- so eager mode here
stays broker-free by construction, and the "read via a fresh AsyncResult"
shape is exactly what test_celery_redis_integration.py exists to cover
against the real thing instead.
"""

import pytest

from app.tasks import detect_spending_anomaly


def _quiet_transaction() -> list[dict]:
    return [{"occurred_at_iso": "2026-09-12T10:00:00Z", "amount_agorot": 100.0, "category_slug": "groceries"}]


def test_task_runs_eagerly_and_returns_a_real_result(celery_eager_mode):
    result = detect_spending_anomaly.delay(_quiet_transaction(), "2026-09-12")
    assert result.status == "SUCCESS"
    assert result.result["ok"] is True
    assert result.result["tier"] in ("HIGH", "MARGINAL", "NORMAL")


def test_task_of_empty_history_still_succeeds(celery_eager_mode):
    result = detect_spending_anomaly.delay([], "2026-09-12")
    assert result.status == "SUCCESS"
    assert result.result["ok"] is True


def test_task_returns_a_domain_level_failure_for_bad_input_not_an_exception(celery_eager_mode):
    # A malformed date is a caller error, not a transient failure -- the
    # task catches it and returns {"ok": False, ...} rather than letting
    # a ValueError propagate as a Celery FAILURE state (see app/tasks.py's
    # own doc comment for why this distinction matters).
    result = detect_spending_anomaly.delay(_quiet_transaction(), "not-a-date")
    assert result.status == "SUCCESS"
    assert result.result["ok"] is False
    assert result.result["error"] == "invalid_input"


def test_task_name_is_stable_for_client_compatibility():
    # The Celery task name is part of the wire protocol between whatever
    # enqueues a task and the worker that consumes it -- an accidental
    # rename here would silently orphan any already-queued task from a
    # previous deploy.
    assert detect_spending_anomaly.name == "app.tasks.detect_spending_anomaly"
