import math

import pytest

from app.anomaly_constants import BASELINE_DAYS, NUM_FEATURES, WINDOW_DAYS
from app.anomaly_features import (
    build_daily_feature_matrix,
    bucket_for_category_slug,
    max_burst_count,
    normalize_window,
)


def test_bucket_for_category_slug_known_mappings():
    assert bucket_for_category_slug("groceries") == "groceries"
    # rent maps to subscriptions on purpose (both are fixed-price
    # recurring charges) -- see anomaly_constants.py's own comment.
    assert bucket_for_category_slug("rent") == "subscriptions"


def test_bucket_for_category_slug_unrecognized_falls_back_to_other():
    assert bucket_for_category_slug("some-custom-user-category") == "other"


def test_max_burst_count_empty_is_zero():
    assert max_burst_count([]) == 0


def test_max_burst_count_single_transaction_is_one():
    assert max_burst_count([600]) == 1


def test_max_burst_count_within_window_counts_together():
    # All three within a 3-hour (180-minute) window.
    assert max_burst_count([600, 650, 700]) == 3


def test_max_burst_count_outside_window_does_not_count_together():
    assert max_burst_count([0, 1000]) == 1


def test_build_daily_feature_matrix_shape_is_always_dense():
    matrix = build_daily_feature_matrix([], "2026-09-12")
    assert len(matrix) == WINDOW_DAYS
    assert all(len(day) == NUM_FEATURES for day in matrix)
    assert all(value == 0.0 for day in matrix for value in day)


def test_build_daily_feature_matrix_rejects_a_malformed_date_key():
    with pytest.raises(ValueError):
        build_daily_feature_matrix([], "not-a-date")


def test_build_daily_feature_matrix_places_a_transaction_on_the_correct_day():
    # windowEnd = 2026-09-12 -> window is [2026-08-14 .. 2026-09-12] (30 days).
    # A transaction on 2026-09-12 itself must land in the LAST day slot.
    transactions = [{"occurred_at_iso": "2026-09-12T10:00:00Z", "amount_agorot": 100.0, "category_slug": "groceries"}]
    matrix = build_daily_feature_matrix(transactions, "2026-09-12")
    assert matrix[-1][0] == 100.0  # total_spend_agorot
    assert matrix[-1][1] == 1.0  # transaction_count
    assert all(day[0] == 0.0 for day in matrix[:-1])


def test_build_daily_feature_matrix_ignores_transactions_outside_the_window():
    transactions = [
        {"occurred_at_iso": "2020-01-01T10:00:00Z", "amount_agorot": 999.0, "category_slug": "groceries"}
    ]
    matrix = build_daily_feature_matrix(transactions, "2026-09-12")
    assert all(value == 0.0 for day in matrix for value in day)


def test_build_daily_feature_matrix_category_bucket_placement():
    transactions = [{"occurred_at_iso": "2026-09-12T10:00:00Z", "amount_agorot": 250.0, "category_slug": "rent"}]
    matrix = build_daily_feature_matrix(transactions, "2026-09-12")
    # Feature order: total, count, burst (indices 0-2), then CATEGORIES in
    # order (groceries, dining, subscriptions, ...) starting at index 3 --
    # subscriptions is CATEGORIES' 3rd entry, so index 3 + 2 = 5. `rent`
    # maps to `subscriptions` per CATEGORY_SLUG_TO_BUCKET.
    subscriptions_index = 5
    assert matrix[-1][subscriptions_index] == 250.0


def test_normalize_window_returns_the_correct_flat_length():
    matrix = [[0.0] * NUM_FEATURES for _ in range(WINDOW_DAYS)]
    flat = normalize_window(matrix)
    assert len(flat) == WINDOW_DAYS * NUM_FEATURES


def test_normalize_window_all_zero_input_stays_zero():
    # log1p(0) = 0 everywhere; baseline std floors to 1.0 when it's ~0 --
    # (0 - 0) / 1.0 = 0, not a division-by-zero NaN.
    matrix = [[0.0] * NUM_FEATURES for _ in range(WINDOW_DAYS)]
    flat = normalize_window(matrix)
    assert all(value == 0.0 for value in flat)
    assert all(not math.isnan(value) for value in flat)


def test_normalize_window_recent_days_never_feed_the_baseline_statistic():
    # A single, huge value on the LAST day (outside the 29-day baseline)
    # must not shift the baseline's own mean/std -- it should show up as
    # a large z-score deviation instead of being smoothed away.
    matrix = [[1.0] * NUM_FEATURES for _ in range(BASELINE_DAYS)]
    matrix.append([100000.0] * NUM_FEATURES)  # the one RECENT_EVAL_DAYS day
    flat = normalize_window(matrix)
    last_day_start = (WINDOW_DAYS - 1) * NUM_FEATURES
    assert all(flat[last_day_start + f] > 5.0 for f in range(NUM_FEATURES))
