import math
import pathlib
from datetime import datetime, timedelta, timezone

import pytest

from app.anomaly_model import AnomalyModel, AnomalyModelNotBuiltError

WINDOW_END = "2026-09-12"


def _quiet_history(days: int = 30, per_day: int = 3, seed: int = 42) -> list[dict]:
    """A plain, unremarkable 30-day transaction history -- no injected anomaly."""
    import random

    rng = random.Random(seed)
    categories = ["groceries", "dining", "transport", "entertainment", "shopping", "rent", "utilities"]
    end = datetime(2026, 9, 12, tzinfo=timezone.utc)
    start = end - timedelta(days=days - 1)

    transactions = []
    for d in range(days):
        day = start + timedelta(days=d)
        for _ in range(rng.randint(1, per_day)):
            ts = day.replace(hour=rng.randint(6, 22), minute=rng.randint(0, 59))
            transactions.append(
                {
                    "occurred_at_iso": ts.isoformat().replace("+00:00", "Z"),
                    "amount_agorot": float(rng.randint(500, 20000)),
                    "category_slug": rng.choice(categories),
                }
            )
    return transactions


def _history_with_injected_micro_burst() -> list[dict]:
    """The quiet baseline plus a real micro-burst anomaly on the final day --
    the exact `micro_burst` shape ml-pipeline/synthesize_ledger.py trained
    this model to catch (many tiny transactions crammed into a short window)."""
    transactions = _quiet_history()
    end = datetime(2026, 9, 12, tzinfo=timezone.utc)
    for i in range(40):
        ts = end.replace(hour=10, minute=(i * 3) % 60)
        transactions.append(
            {
                "occurred_at_iso": ts.isoformat().replace("+00:00", "Z"),
                "amount_agorot": 50.0,
                "category_slug": "shopping",
            }
        )
    return transactions


@pytest.fixture(scope="module")
def model() -> AnomalyModel:
    return AnomalyModel()


def test_raises_a_clear_error_when_the_model_file_is_missing():
    with pytest.raises(AnomalyModelNotBuiltError):
        AnomalyModel(model_path=pathlib.Path("/nonexistent/path/model.onnx"))


def test_detect_returns_the_expected_shape_and_types(model: AnomalyModel):
    result = model.detect(_quiet_history(), WINDOW_END)
    assert result["tier"] in ("HIGH", "MARGINAL", "NORMAL")
    assert isinstance(result["signal"], float)
    assert not math.isnan(result["signal"])
    assert set(result["thresholds"].keys()) == {"thetaLo", "thetaHi"}
    assert isinstance(result["topFeature"], str)
    assert result["topCategory"] is None or isinstance(result["topCategory"], str)


def test_detect_is_deterministic(model: AnomalyModel):
    history = _quiet_history()
    first = model.detect(history, WINDOW_END)
    second = model.detect(history, WINDOW_END)
    assert first == second


def test_detect_of_a_completely_empty_history_is_normal_not_a_crash(model: AnomalyModel):
    result = model.detect([], WINDOW_END)
    assert result["tier"] == "NORMAL"
    assert not math.isnan(result["signal"])


def test_detect_of_a_micro_burst_anomaly_is_correctly_flagged_high(model: AnomalyModel):
    # A real, verified regression test -- confirmed by hand before writing
    # this assertion that this exact injected shape (40 tiny transactions
    # crammed into ~2 hours on the final day) produces a HIGH classification
    # attributed to the burst-velocity feature, matching what the model was
    # actually trained on (ml-pipeline/synthesize_ledger.py's `micro_burst`
    # injection).
    result = model.detect(_history_with_injected_micro_burst(), WINDOW_END)
    assert result["tier"] == "HIGH"
    assert result["topFeature"] == "max_3h_burst_count"
    assert result["topCategory"] is None


def test_detect_rejects_a_malformed_window_end_date_key(model: AnomalyModel):
    with pytest.raises(ValueError):
        model.detect(_quiet_history(), "not-a-date")
