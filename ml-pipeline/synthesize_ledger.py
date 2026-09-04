"""Generates synthetic daily-ledger sequences for the spending-anomaly
autoencoder (AGENTS.md, "Behavioral Spending Anomaly Detection").

Produces two independent household pools, mirroring train_autoencoder.py's
"fit exclusively on normal data" requirement:

  - TRAIN pool: every household is entirely normal, no injected anomalies.
    This is what the autoencoder is fit on.
  - VAL pool: every household gets exactly one injected anomaly (either
    "subscription_creep" or "micro_burst", alternating), at a random day.
    Used only to measure reconstruction error on abnormal behavior and to
    calibrate/validate the anomaly threshold — never used for training
    weights.

Every monetary figure is a plain Python int representing Agorot (integer
minor units of ILS), matching this app's own money law (AGENTS.md §1,
`src/lib/money.ts`) — never a float. This script has no dependency on the
app's own TypeScript money helpers (it's a standalone, independently-run
Python pipeline, same "own a small separate toolchain" precedent as
sidecar/ and scripts/train-forecaster.py), so the same "integer minor
units, never a float" discipline is re-implemented here from scratch
rather than imported.

Per-day feature vector (order matters — train_autoencoder.py and the
eventual TypeScript inference worker both depend on this exact order,
recorded in data/metadata.json and, later, the exported model's own
.meta.json):

    0  total_spend_agorot        -- sum of every transaction that day
    1  transaction_count         -- count of transactions that day
    2  max_3h_burst_count        -- the busiest 3-hour window's transaction
                                     count that day (the "velocity" signal:
                                     a scattered-micro-transaction burst
                                     spikes THIS far more than the plain
                                     daily count does, since it compresses
                                     many transactions into a short window)
    3  cat_groceries_agorot
    4  cat_dining_agorot
    5  cat_subscriptions_agorot
    6  cat_shopping_agorot
    7  cat_transport_agorot
    8  cat_entertainment_agorot
    9  cat_other_agorot

Two anomaly shapes are injected into the validation pool, chosen because
they stress the autoencoder in genuinely different ways — a sustained
level shift vs. a short sharp count/velocity spike:

  - subscription_creep: one household's recurring subscription charge
    steps up by 2.5x-4x starting at a random day and stays elevated
    (feature 5 and, correspondingly, feature 0 shift upward on every
    subsequent billing day) — a real subscription price hike, not a
    one-off transaction.
  - micro_burst: 20-50 extra tiny transactions (50-300 agorot each,
    categories "shopping"/"other") land within a 2-3 hour window on one
    day — transaction_count and max_3h_burst_count spike sharply while
    total_spend barely moves, the opposite failure mode from creep.

A day is labeled anomalous ONLY on the exact day the injected anomalous
event actually happened (the day a hiked subscription charge first
bills, or the day a burst's extra transactions land) — never a guessed
calendar range after "onset." An earlier draft of this script labeled a
fixed 14-day window after a creep's onset, which is wrong relative to a
28-day billing cadence: over half the time, the hiked charge hadn't
actually billed yet inside that window, so the model was being asked to
flag days that still looked completely normal. Labeling the exact event
day (and, for creep, guaranteeing at least one billing occurrence by
leaving a full 28-day cycle of runway after onset) fixes that.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SEED = 20260904

REPO_ROOT = Path(__file__).resolve().parent
DATA_DIR = REPO_ROOT / "data"

WINDOW_DAYS = 30  # trailing history length the model reads at inference time
TIMELINE_DAYS = 240  # per-household synthetic history length
BURN_IN_DAYS = 45  # anomalies never start before this, so a full trailing window of normal behavior exists beforehand

N_TRAIN_HOUSEHOLDS = 160
N_VAL_HOUSEHOLDS = 60

TRAIN_STRIDE_DAYS = 3  # overlap allowed — this is data augmentation for a reconstruction model, not a leakage concern (no labels involved)
VAL_STRIDE_DAYS = 1  # dense stride so the exact onset day is very likely captured by some window

CATEGORIES = [
    "groceries",
    "dining",
    "subscriptions",
    "shopping",
    "transport",
    "entertainment",
    "other",
]

FEATURE_NAMES = [
    "total_spend_agorot",
    "transaction_count",
    "max_3h_burst_count",
    *[f"cat_{c}_agorot" for c in CATEGORIES],
]
NUM_FEATURES = len(FEATURE_NAMES)
assert NUM_FEATURES == 3 + len(CATEGORIES)

MINUTES_PER_DAY = 24 * 60
BURST_WINDOW_MINUTES = 3 * 60


@dataclass
class HouseholdProfile:
    """Fixed-for-life behavioral parameters drawn once per synthetic household."""

    category_daily_lambda: dict[str, float]
    category_amount_mean_agorot: dict[str, int]
    category_amount_std_agorot: dict[str, int]
    category_weekday_multiplier: dict[str, np.ndarray]  # each length 7, mean ~1.0 — see _draw_household_profile for why this replaced a single shared weekly multiplier
    subscriptions: list[dict] = field(default_factory=list)  # each: {day_of_month, base_amount_agorot}


def _draw_household_profile(rng: np.random.Generator) -> HouseholdProfile:
    # Base daily transaction-rate ranges per category — subscriptions are
    # deliberately near-zero here; they're modeled separately below as
    # discrete monthly billing events, not a Poisson rate, since a real
    # subscription charges a fixed amount on a fixed cadence, not a
    # randomly-sized amount at a random daily probability.
    lambda_ranges = {
        "groceries": (0.15, 0.45),
        "dining": (0.2, 0.6),
        "shopping": (0.1, 0.35),
        "transport": (0.2, 0.5),
        "entertainment": (0.05, 0.25),
        "other": (0.05, 0.2),
    }
    amount_ranges_agorot = {
        "groceries": (4000, 18000),
        "dining": (2500, 9000),
        "shopping": (3000, 25000),
        "transport": (1500, 6000),
        "entertainment": (2000, 12000),
        "other": (1000, 8000),
    }

    category_daily_lambda: dict[str, float] = {}
    category_amount_mean_agorot: dict[str, int] = {}
    category_amount_std_agorot: dict[str, int] = {}
    category_weekday_multiplier: dict[str, np.ndarray] = {}
    for cat in CATEGORIES:
        if cat == "subscriptions":
            continue
        lo, hi = lambda_ranges[cat]
        category_daily_lambda[cat] = float(rng.uniform(lo, hi))
        mlo, mhi = amount_ranges_agorot[cat]
        mean_amount = int(rng.uniform(mlo, mhi))
        category_amount_mean_agorot[cat] = mean_amount
        # Tighter amount variance than an earlier draft (was 0.35x mean) —
        # real recurring spending (the same grocery run, the same commute)
        # doesn't vary THAT much transaction to transaction; a tighter
        # distribution gives the autoencoder an actually-learnable "normal"
        # to reconstruct, which is what lets a genuine anomaly stand out
        # above the noise floor instead of blending into it.
        category_amount_std_agorot[cat] = max(int(mean_amount * 0.22), 100)

        # A real per-CATEGORY weekly rhythm (groceries peak Saturday, dining
        # peaks Fri/Sat evenings, transport is a weekday-commute thing,
        # entertainment/shopping skew weekend) — deliberately NOT one
        # shared multiplier applied identically to every category (an
        # earlier draft did that, and it gave the LSTM almost nothing
        # learnable: without a distinct per-category weekly SHAPE, each
        # day's category totals are close to independent noise around a
        # flat mean, which the autoencoder can't compress meaningfully,
        # which in turn means a genuine anomaly doesn't stand out above an
        # already-high irreducible noise floor). Gamma-distributed and
        # re-normalized to a mean of 1.0 across the week — positive,
        # moderately peaked, no risk of a negative multiplier.
        raw_weekday = rng.gamma(shape=4.0, scale=1.0, size=7)
        category_weekday_multiplier[cat] = raw_weekday / raw_weekday.mean()

    n_subscriptions = int(rng.integers(2, 5))
    subscriptions = [
        {
            "day_of_month": int(rng.integers(0, 28)),
            "base_amount_agorot": int(rng.uniform(1500, 6000)),
        }
        for _ in range(n_subscriptions)
    ]

    return HouseholdProfile(
        category_daily_lambda=category_daily_lambda,
        category_amount_mean_agorot=category_amount_mean_agorot,
        category_amount_std_agorot=category_amount_std_agorot,
        category_weekday_multiplier=category_weekday_multiplier,
        subscriptions=subscriptions,
    )


def _draw_lognormal_amount_agorot(rng: np.random.Generator, mean_agorot: int, std_agorot: int) -> int:
    # A lognormal with the given mean/std (method-of-moments), clipped to a
    # sane floor — a real transaction amount is never zero or negative.
    mean = max(mean_agorot, 1.0)
    std = max(std_agorot, 1.0)
    variance = std**2
    mu = np.log(mean**2 / np.sqrt(variance + mean**2))
    sigma = np.sqrt(np.log(1 + variance / mean**2))
    amount = rng.lognormal(mu, sigma)
    return max(int(round(amount)), 50)


def _generate_normal_day(
    rng: np.random.Generator, profile: HouseholdProfile, day_index: int
) -> tuple[np.ndarray, list[tuple[str, int, int]]]:
    """Returns (feature_vector, transactions) where transactions is a list of
    (category, amount_agorot, minute_of_day) tuples — the raw events the
    feature vector is aggregated from, kept around so anomaly injection can
    append to the same list before re-aggregating.
    """
    dow = day_index % 7

    transactions: list[tuple[str, int, int]] = []
    for cat in CATEGORIES:
        if cat == "subscriptions":
            continue
        lam = profile.category_daily_lambda[cat] * profile.category_weekday_multiplier[cat][dow]
        n_txns = rng.poisson(lam)
        for _ in range(n_txns):
            amount = _draw_lognormal_amount_agorot(
                rng, profile.category_amount_mean_agorot[cat], profile.category_amount_std_agorot[cat]
            )
            minute = int(rng.integers(0, MINUTES_PER_DAY))
            transactions.append((cat, amount, minute))

    # Subscriptions bill on their fixed day-of-month, not a Poisson draw.
    day_of_month = day_index % 28
    for sub in profile.subscriptions:
        if sub["day_of_month"] == day_of_month:
            minute = int(rng.integers(0, MINUTES_PER_DAY))
            transactions.append(("subscriptions", sub["base_amount_agorot"], minute))

    return _aggregate_day(transactions), transactions


def _aggregate_day(transactions: list[tuple[str, int, int]]) -> np.ndarray:
    features = np.zeros(NUM_FEATURES, dtype=np.int64)
    total = 0
    count = 0
    minutes = []
    cat_totals = {cat: 0 for cat in CATEGORIES}

    for cat, amount, minute in transactions:
        total += amount
        count += 1
        minutes.append(minute)
        cat_totals[cat] += amount

    features[0] = total
    features[1] = count
    features[2] = _max_burst_count(minutes)
    for i, cat in enumerate(CATEGORIES):
        features[3 + i] = cat_totals[cat]
    return features


def _max_burst_count(minutes: list[int]) -> int:
    """The busiest BURST_WINDOW_MINUTES-wide window's transaction count,
    considered over a day extended by one BURST_WINDOW_MINUTES tail so a
    burst straddling midnight (a real micro-burst injected near end of day)
    is still measured correctly, not artificially split in two.
    """
    if not minutes:
        return 0
    sorted_minutes = sorted(minutes)
    max_count = 0
    left = 0
    for right in range(len(sorted_minutes)):
        while sorted_minutes[right] - sorted_minutes[left] > BURST_WINDOW_MINUTES:
            left += 1
        max_count = max(max_count, right - left + 1)
    return max_count


def _generate_household_timeline(
    rng: np.random.Generator, inject_anomaly: str | None
) -> tuple[np.ndarray, np.ndarray, str]:
    """Returns (features [TIMELINE_DAYS, NUM_FEATURES], is_anomaly [TIMELINE_DAYS], anomaly_type)."""
    profile = _draw_household_profile(rng)
    all_transactions: list[list[tuple[str, int, int]]] = []

    for day in range(TIMELINE_DAYS):
        _features, txns = _generate_normal_day(rng, profile, day)
        all_transactions.append(txns)

    is_anomaly = np.zeros(TIMELINE_DAYS, dtype=np.int64)
    anomaly_type = "none"

    if inject_anomaly == "subscription_creep":
        # onset_day leaves at least one full 28-day billing cycle of
        # runway, so the hiked charge is GUARANTEED to actually bill at
        # least once before the timeline ends — a fixed calendar-day
        # label window (the original approach here) has no such guarantee
        # relative to a 28-day cadence, and silently mislabels days where
        # the hike hasn't billed yet as "anomalous" when they still look
        # completely normal.
        onset_day = int(rng.integers(BURN_IN_DAYS, TIMELINE_DAYS - 28 - 1))
        target_sub = profile.subscriptions[int(rng.integers(0, len(profile.subscriptions)))]
        multiplier = float(rng.uniform(2.5, 4.0))
        hiked_amount = int(target_sub["base_amount_agorot"] * multiplier)

        hiked_days: list[int] = []
        for day in range(onset_day, TIMELINE_DAYS):
            day_of_month = day % 28
            if target_sub["day_of_month"] == day_of_month:
                # Re-bill this specific subscription at the hiked amount —
                # find and replace its transaction for this day rather than
                # appending a second one, since it's the SAME subscription
                # charging a higher price, not a new charge.
                txns = all_transactions[day]
                for i, (cat, amount, minute) in enumerate(txns):
                    if cat == "subscriptions" and amount == target_sub["base_amount_agorot"]:
                        txns[i] = (cat, hiked_amount, minute)
                        hiked_days.append(day)
                        break

        assert hiked_days, "onset_day always leaves >=28 days of runway, so at least one billing occurrence must exist"
        # Only the FIRST hiked bill is labeled anomalous — that's the
        # moment the creep first becomes observable. Every later hiked
        # bill is the new (still-elevated) normal, not a fresh event to
        # re-flag on every subsequent cycle.
        is_anomaly[hiked_days[0]] = 1
        anomaly_type = "subscription_creep"

    elif inject_anomaly == "micro_burst":
        onset_day = int(rng.integers(BURN_IN_DAYS, TIMELINE_DAYS - 1))
        n_extra = int(rng.integers(20, 51))
        burst_start_minute = int(rng.integers(0, MINUTES_PER_DAY - BURST_WINDOW_MINUTES))
        for _ in range(n_extra):
            cat = "shopping" if rng.random() < 0.5 else "other"
            amount = int(rng.integers(50, 301))
            minute = burst_start_minute + int(rng.integers(0, BURST_WINDOW_MINUTES))
            all_transactions[onset_day].append((cat, amount, minute))

        is_anomaly[onset_day] = 1
        anomaly_type = "micro_burst"

    features = np.stack([_aggregate_day(txns) for txns in all_transactions])
    return features, is_anomaly, anomaly_type


def _slice_windows(
    features: np.ndarray, is_anomaly: np.ndarray, stride: int
) -> tuple[np.ndarray, np.ndarray]:
    """Slices trailing WINDOW_DAYS-day windows. A window ending at day d is
    labeled anomalous iff day d itself (the "today" the model would be
    asked about at inference time) is flagged — not if ANY day inside the
    window is flagged, since the window's job is reconstructing what LED
    UP TO today, and the label is about whether today looks abnormal
    relative to that lead-up.
    """
    windows = []
    labels = []
    for end in range(WINDOW_DAYS - 1, len(features), stride):
        start = end - WINDOW_DAYS + 1
        windows.append(features[start : end + 1])
        labels.append(is_anomaly[end])
    return np.stack(windows), np.array(labels, dtype=np.int64)


def generate_train_pool(rng: np.random.Generator) -> np.ndarray:
    all_windows = []
    for _ in range(N_TRAIN_HOUSEHOLDS):
        features, is_anomaly, _ = _generate_household_timeline(rng, inject_anomaly=None)
        windows, _labels = _slice_windows(features, is_anomaly, TRAIN_STRIDE_DAYS)
        all_windows.append(windows)
    return np.concatenate(all_windows, axis=0)


def generate_val_pool(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, list[str]]:
    all_windows = []
    all_labels = []
    all_types = []
    for i in range(N_VAL_HOUSEHOLDS):
        anomaly = "subscription_creep" if i % 2 == 0 else "micro_burst"
        features, is_anomaly, anomaly_type = _generate_household_timeline(rng, inject_anomaly=anomaly)
        windows, labels = _slice_windows(features, is_anomaly, VAL_STRIDE_DAYS)
        all_windows.append(windows)
        all_labels.append(labels)
        all_types.extend([anomaly_type] * len(labels))
    return np.concatenate(all_windows, axis=0), np.concatenate(all_labels, axis=0), all_types


def main() -> None:
    rng = np.random.default_rng(SEED)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Generating {N_TRAIN_HOUSEHOLDS} normal households ({TIMELINE_DAYS} days each)...")
    train_windows = generate_train_pool(rng)
    print(f"  -> {train_windows.shape[0]} training windows of shape {train_windows.shape[1:]}")

    print(f"Generating {N_VAL_HOUSEHOLDS} households with one injected anomaly each...")
    val_windows, val_labels, val_types = generate_val_pool(rng)
    n_anomalous = int(val_labels.sum())
    print(
        f"  -> {val_windows.shape[0]} validation windows "
        f"({n_anomalous} labeled anomalous, {val_windows.shape[0] - n_anomalous} normal)"
    )

    np.savez_compressed(
        DATA_DIR / "train_sequences.npz",
        X=train_windows.astype(np.int64),
    )
    np.savez_compressed(
        DATA_DIR / "val_sequences.npz",
        X=val_windows.astype(np.int64),
        y=val_labels,
        anomaly_type=np.array(val_types),
    )

    metadata = {
        "seed": SEED,
        "windowDays": WINDOW_DAYS,
        "timelineDays": TIMELINE_DAYS,
        "featureNames": FEATURE_NAMES,
        "categories": CATEGORIES,
        "numFeatures": NUM_FEATURES,
        "trainHouseholds": N_TRAIN_HOUSEHOLDS,
        "valHouseholds": N_VAL_HOUSEHOLDS,
        "trainWindowCount": int(train_windows.shape[0]),
        "valWindowCount": int(val_windows.shape[0]),
        "valAnomalousWindowCount": n_anomalous,
        "moneyUnit": "agorot (integer minor units of ILS, matching src/lib/money.ts's Agorot law)",
    }
    (DATA_DIR / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Wrote {DATA_DIR / 'train_sequences.npz'}, {DATA_DIR / 'val_sequences.npz'}, and metadata.json")


if __name__ == "__main__":
    main()
