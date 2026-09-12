"""
Pure feature-engineering functions for the spending-anomaly pipeline --
no ONNX Runtime, no Celery, no FastAPI here, so these are directly
testable against plain data literals, same convention as
feature_extraction.py. A careful Python port of
src/lib/ml/anomaly-worker-handlers.ts's `buildDailyFeatureMatrix` and
`normalizeWindow` -- see that file's own doc comments for the full
rationale (log1p isn't optional; the baseline/recent split exists so the
statistic judging the evaluated day never includes that day itself).
"""

import math
import re
from datetime import datetime, timezone

from .anomaly_constants import (
    BASELINE_DAYS,
    BURST_WINDOW_MINUTES,
    CATEGORIES,
    CATEGORY_SLUG_TO_BUCKET,
    NUM_FEATURES,
    WINDOW_DAYS,
)

MS_PER_DAY = 24 * 60 * 60 * 1000
_DATE_KEY_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def bucket_for_category_slug(slug: str) -> str:
    return CATEGORY_SLUG_TO_BUCKET.get(slug, "other")


def _date_key_to_utc_midnight_ms(date_key: str) -> int:
    dt = datetime(int(date_key[0:4]), int(date_key[5:7]), int(date_key[8:10]), tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _parse_iso_to_utc(occurred_at_iso: str) -> datetime:
    # Python's fromisoformat doesn't accept a bare trailing "Z" on every
    # supported version this app might run on -- normalize it to an
    # explicit UTC offset first, same as this app's Node side treats any
    # ISO string as UTC-anchored (dateKeyToUtcMidnightMs uses Date.UTC
    # throughout, never the local timezone).
    normalized = occurred_at_iso.replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def max_burst_count(minutes_of_day: list[int]) -> int:
    """The busiest BURST_WINDOW_MINUTES-wide window's transaction count within one day -- mirrors
    synthesize_ledger.py's `_max_burst_count` / anomaly-worker-handlers.ts's `maxBurstCount` exactly
    (same sliding-window-over-sorted-minutes algorithm)."""
    if not minutes_of_day:
        return 0
    sorted_minutes = sorted(minutes_of_day)
    max_count = 0
    left = 0
    for right in range(len(sorted_minutes)):
        while sorted_minutes[right] - sorted_minutes[left] > BURST_WINDOW_MINUTES:
            left += 1
        max_count = max(max_count, right - left + 1)
    return max_count


def build_daily_feature_matrix(transactions: list[dict], window_end_date_key: str) -> list[list[float]]:
    """
    Aggregates raw transactions into a dense (zero-filled) WINDOW_DAYS x
    NUM_FEATURES matrix, oldest day first -- a transaction whose date
    falls outside the window is silently ignored (defensive; this only
    ever runs against this app's own data, never adversarial input, same
    reasoning the TS original gives).

    Each transaction dict must have `occurred_at_iso` (ISO 8601
    datetime), `amount_agorot` (positive expense magnitude), and
    `category_slug`.
    """
    if not _DATE_KEY_PATTERN.match(window_end_date_key):
        raise ValueError(f"window_end_date_key must be an ISO YYYY-MM-DD string, got {window_end_date_key!r}")

    window_end_ms = _date_key_to_utc_midnight_ms(window_end_date_key)
    window_start_ms = window_end_ms - (WINDOW_DAYS - 1) * MS_PER_DAY

    day_totals = [0.0] * WINDOW_DAYS
    day_counts = [0] * WINDOW_DAYS
    day_minutes: list[list[int]] = [[] for _ in range(WINDOW_DAYS)]
    day_category_totals = [{c: 0.0 for c in CATEGORIES} for _ in range(WINDOW_DAYS)]

    for txn in transactions:
        occurred_at = _parse_iso_to_utc(txn["occurred_at_iso"])
        date_ms = int(
            datetime(occurred_at.year, occurred_at.month, occurred_at.day, tzinfo=timezone.utc).timestamp() * 1000
        )
        day_index = round((date_ms - window_start_ms) / MS_PER_DAY)
        if day_index < 0 or day_index >= WINDOW_DAYS:
            continue

        amount = txn["amount_agorot"]
        day_totals[day_index] += amount
        day_counts[day_index] += 1
        day_minutes[day_index].append(occurred_at.hour * 60 + occurred_at.minute)
        bucket = bucket_for_category_slug(txn["category_slug"])
        day_category_totals[day_index][bucket] += amount

    return [
        [
            day_totals[d],
            float(day_counts[d]),
            float(max_burst_count(day_minutes[d])),
            *[day_category_totals[d][c] for c in CATEGORIES],
        ]
        for d in range(WINDOW_DAYS)
    ]


def normalize_window(matrix: list[list[float]]) -> list[float]:
    """
    log1p, then per-window baseline z-score -- must exactly match
    ml-pipeline/train_autoencoder.py's `normalize_windows()` and
    anomaly-worker-handlers.ts's `normalizeWindow`. Returns a flat,
    row-major (day-major then feature) list of length
    WINDOW_DAYS * NUM_FEATURES, matching the ONNX model's fixed
    (1, WINDOW_DAYS, NUM_FEATURES) input shape.
    """
    log_matrix = [[math.log1p(v) for v in day] for day in matrix]

    mean = [0.0] * NUM_FEATURES
    std = [1.0] * NUM_FEATURES
    for f in range(NUM_FEATURES):
        baseline_values = [log_matrix[d][f] for d in range(BASELINE_DAYS)]
        m = sum(baseline_values) / len(baseline_values)
        variance = sum((v - m) ** 2 for v in baseline_values) / len(baseline_values)
        raw_std = math.sqrt(variance)
        mean[f] = m
        std[f] = 1.0 if raw_std < 1e-6 else raw_std

    out = [0.0] * (WINDOW_DAYS * NUM_FEATURES)
    for d in range(WINDOW_DAYS):
        for f in range(NUM_FEATURES):
            out[d * NUM_FEATURES + f] = (log_matrix[d][f] - mean[f]) / std[f]
    return out
