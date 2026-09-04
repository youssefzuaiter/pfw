"""Trains and exports the spending-anomaly LSTM autoencoder (AGENTS.md,
"Behavioral Spending Anomaly Detection").

Reads ml-pipeline/data/{train,val}_sequences.npz (produced by
synthesize_ledger.py — run that first). Fits a small sequence-to-sequence
LSTM autoencoder EXCLUSIVELY on the normal-only training pool, then
calibrates an anomaly-detection threshold from the training reconstruction-
error distribution and sanity-checks it against the validation pool's
injected anomalies.

Anomaly-threshold methodology — bootstrap-CI tiered classification, a
standard statistical technique for turning a point threshold into a
confidence band: resample the training reconstruction-error distribution
2,000 times, take each resample's own mean+2*std threshold, and use the
2.5th/97.5th percentiles of THOSE resampled thresholds as the band. Three
tiers:

    HIGH     reconstruction MSE >= theta_hi   (confident anomaly)
    MARGINAL theta_lo <= MSE < theta_hi        (within the threshold's own
                                                 uncertainty band — worth
                                                 surfacing softly, not as
                                                 a hard alert)
    NORMAL   MSE < theta_lo

Architecture — a small seq2seq LSTM autoencoder, built for this
feature's actual input shape (a 30-day SEQUENCE, the real shape of
"trailing transaction history" — an LSTM, not a dense network, is the
right tool for a sequence):

    encoder: LSTM(F -> HIDDEN_SIZE), take the final hidden state
    bottleneck: Linear(HIDDEN_SIZE -> BOTTLENECK_DIM), Tanh
    decoder: the bottleneck vector is repeated WINDOW_DAYS times as the
             decoder LSTM's input at every step (a standard seq2seq-
             autoencoder decoding scheme — the bottleneck has to carry
             everything needed to reconstruct all 30 days, since there's
             no per-step decoder input beyond it)
    output:  Linear(HIDDEN_SIZE -> F) applied at every decoder timestep

Every window is z-scored using ONLY that window's OWN leading
BASELINE_DAYS days as the reference mean/std (never a global scaler fit
across the whole training pool). Two reasons, both found empirically
while building this pipeline, not assumed up front:

  1. A global, population-level scaler conflates "household A spends
     more than household B" with "this household's day looks unusual
     FOR THEM" — the first real run of this script, before this fix,
     showed exactly that failure: overall reconstruction quality was
     poor (holdout MSE ~0.87, barely better than predicting the mean),
     and subscription_creep recall was ~1% while micro_burst recall was
     100% — the population-level std was so dominated by cross-household
     variance that a single household's real deviation barely moved the
     z-score at all, UNLESS it was the raw-count/velocity kind of spike
     a burst produces, which is large in absolute terms regardless of
     scale.
  2. It also would have been a real production-robustness problem: a
     global scaler fit on THIS synthetic population has no reason to
     match a real user's actual spending scale. Per-window, per-user
     normalization sidesteps that entirely — the same reasoning
     scripts/train-forecaster.py already applies to its own per-series
     normalization ("every real household's cash flow lives at a
     different absolute scale... The model never sees raw currency
     units").

Deliberately excluding the trailing (WINDOW_DAYS - BASELINE_DAYS) recent
days from the mean/std computation itself — not just from training, from
the STATISTIC — matters too: including them would let a fresh anomaly in
those days shift the very baseline used to judge it, partially masking
itself (the classic "an outlier inflates the statistic used to detect
it" problem). The recent days are what's being evaluated, not what
defines "normal" for that window. No scaler is fit anywhere or shipped
in the exported .meta.json — the real inference worker
(src/lib/ml/anomaly-worker.ts, Phase 3) will compute this exact same
baseline-mean/baseline-std transform from the real user's own trailing
history, live, every time.

Exported with a FIXED input shape (batch=1, WINDOW_DAYS, NUM_FEATURES) —
deliberately not a dynamic batch axis like scripts/train-forecaster.py
uses, per this feature's own spec: the browser worker only ever evaluates
one user's one trailing window at a time, so there is no batching
use case here to keep a dynamic axis open for.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn

SEED = 20260904
torch.manual_seed(SEED)
np.random.seed(SEED)

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(__file__).resolve().parent / "data"
MODEL_PATH = REPO_ROOT / "public" / "models" / "spending_anomaly.onnx"

HIDDEN_SIZE = 40
BOTTLENECK_DIM = 12
RECENT_EVAL_DAYS = 1  # anomaly signal = the single most recent day's error, not an average over several days. Every injected anomaly here (see synthesize_ledger.py) is labeled on EXACTLY one day, so averaging error over multiple recent days (an earlier draft used 3) dilutes that one day's signal against unaffected neighboring days for no benefit — the label always corresponds to exactly the window's last day.
BASELINE_DAYS = 30 - RECENT_EVAL_DAYS  # = 29. As large as possible given the single evaluated day. A prior draft used 27 (RECENT_EVAL_DAYS=3) and subscription_creep recall went to ZERO — traced to an off-by-one: a subscription bills every 28 days, so the prior (normal-priced) billing needed as a comparison reference sits EXACTLY 28 days before the hiked one, which fell 1 day outside a 27-day baseline every single time. 29 days guarantees that 28-day-prior occurrence always lands inside the baseline.
N_EPOCHS = 250
BATCH_SIZE = 32
LEARNING_RATE = 2e-3
EARLY_STOP_PATIENCE = 25
VAL_FIT_HOLDOUT_FRACTION = 0.1  # a slice of the (normal-only) TRAIN pool, used only for early stopping — never the labeled val pool
N_BOOTSTRAP_RESAMPLES = 2000
OPSET_VERSION = 18  # see scripts/train-forecaster.py's own note: torch's dynamo exporter targets 18 natively; forcing 17 has previously produced an invalid graph in this repo


def load_metadata() -> dict:
    return json.loads((DATA_DIR / "metadata.json").read_text())


def load_sequences() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    train = np.load(DATA_DIR / "train_sequences.npz")
    val = np.load(DATA_DIR / "val_sequences.npz")
    return train["X"], val["X"], val["y"], val["anomaly_type"]


def normalize_windows(windows: np.ndarray) -> np.ndarray:
    """log1p-then-per-window-z-score. `windows` has shape
    [N, WINDOW_DAYS, NUM_FEATURES]; returned array has the same shape.

    log1p FIRST, not a raw-value z-score, and this is not optional
    polish — it's what fixes a real bug this script hit on its first
    real run. Several features here (subscription/entertainment/other
    category totals) are raw agorot amounts that sit at EXACTLY ZERO on
    most days. A baseline that happens to be all-zero (common for a
    rarely-firing category over just BASELINE_DAYS days) has std=0,
    which the near-zero-variance guard below replaces with a floor of
    1.0 — but 1.0 is dimensionally meaningless against a raw agorot
    scale that can run into the thousands: a single nonzero occurrence
    anywhere in the window then divides by 1.0 instead of a sensible
    scale, producing a raw value in the THOUSANDS sitting next to
    otherwise-normal z-scored features near [-2, 2]. That one feature
    then dominates the reconstruction MSE completely — exactly what a
    real run of this script showed (MSE ~40,000, near-zero anomaly
    recall) before this fix.

    log1p compresses "usually 0, occasionally thousands" into "usually
    0, occasionally ~8-9" (log1p(6000) ~= 8.7) — a scale where the SAME
    1.0 std-floor guard is finally dimensionally sensible, regardless of
    whether the underlying feature is a raw agorot amount or a small
    integer count. Standard, well-established preprocessing for
    non-negative, heavy-tailed, zero-heavy features — not a
    domain-specific technique borrowed from anywhere.

    Deliberately excludes the trailing (WINDOW_DAYS - BASELINE_DAYS)
    recent days from the mean/std computation itself — not just from
    training, from the STATISTIC — since including them would let a
    fresh anomaly shift the very baseline used to judge it, partially
    masking itself.
    """
    log_windows = np.log1p(windows.astype(np.float64))
    baseline = log_windows[:, :BASELINE_DAYS, :]
    mean = baseline.mean(axis=1, keepdims=True)
    std = baseline.std(axis=1, keepdims=True)
    std = np.where(std < 1e-6, 1.0, std)
    return (log_windows - mean) / std


class LSTMAutoencoder(nn.Module):
    def __init__(self, num_features: int, window_days: int, hidden_size: int = HIDDEN_SIZE, bottleneck_dim: int = BOTTLENECK_DIM) -> None:
        super().__init__()
        self.window_days = window_days
        self.bottleneck_dim = bottleneck_dim

        self.encoder_lstm = nn.LSTM(num_features, hidden_size, batch_first=True)
        self.to_bottleneck = nn.Linear(hidden_size, bottleneck_dim)
        self.bottleneck_activation = nn.Tanh()

        self.decoder_lstm = nn.LSTM(bottleneck_dim, hidden_size, batch_first=True)
        self.output_layer = nn.Linear(hidden_size, num_features)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        batch_size = x.shape[0]
        _, (h_n, _c_n) = self.encoder_lstm(x)
        bottleneck = self.bottleneck_activation(self.to_bottleneck(h_n[-1]))  # [batch, bottleneck_dim]

        decoder_input = bottleneck.unsqueeze(1).expand(batch_size, self.window_days, self.bottleneck_dim)
        decoder_out, _ = self.decoder_lstm(decoder_input)
        reconstruction = self.output_layer(decoder_out)
        return reconstruction


def recent_reconstruction_error(reconstruction: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """The anomaly signal: mean squared error over the FEATURE dimension
    only, then averaged over just the trailing RECENT_EVAL_DAYS days —
    not the whole WINDOW_DAYS window.

    An earlier draft averaged error across all 30 days uniformly. Since
    both injected anomalies here are single-day events, that dilutes the
    one anomalous day's error across 29 unaffected days — a real,
    measured effect: subscription_creep recall stayed near-zero even
    after normalization was fixed, because a huge per-feature error on
    one day out of thirty barely moves a whole-window average. Evaluating
    only the trailing days matches what this feature is actually asking
    ("does TODAY / the last couple of days look anomalous"), not "does
    this whole month look atypical on average."
    """
    per_day_se = ((reconstruction - target) ** 2).mean(dim=2)  # [batch, WINDOW_DAYS]
    return per_day_se[:, -RECENT_EVAL_DAYS:].mean(dim=1)


def train(model: LSTMAutoencoder, train_windows_scaled: np.ndarray) -> LSTMAutoencoder:
    n = train_windows_scaled.shape[0]
    rng = np.random.default_rng(SEED)
    permutation = rng.permutation(n)
    n_holdout = int(n * VAL_FIT_HOLDOUT_FRACTION)
    holdout_idx = permutation[:n_holdout]
    fit_idx = permutation[n_holdout:]

    fit_data = torch.tensor(train_windows_scaled[fit_idx], dtype=torch.float32)
    holdout_data = torch.tensor(train_windows_scaled[holdout_idx], dtype=torch.float32)

    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    loss_fn = nn.MSELoss()

    best_holdout_loss = float("inf")
    best_state = None
    epochs_without_improvement = 0

    n_fit = fit_data.shape[0]
    n_batches = max(n_fit // BATCH_SIZE, 1)

    print(f"Training on {n_fit} windows ({n_batches} batches/epoch), holding out {n_holdout} for early stopping...")
    for epoch in range(N_EPOCHS):
        model.train()
        epoch_perm = torch.randperm(n_fit)
        epoch_loss = 0.0
        for batch_idx in range(n_batches):
            indices = epoch_perm[batch_idx * BATCH_SIZE : (batch_idx + 1) * BATCH_SIZE]
            batch = fit_data[indices]

            optimizer.zero_grad()
            reconstruction = model(batch)
            loss = loss_fn(reconstruction, batch)
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()

        model.eval()
        with torch.no_grad():
            holdout_reconstruction = model(holdout_data)
            holdout_loss = loss_fn(holdout_reconstruction, holdout_data).item()

        if epoch % 5 == 0 or epoch == N_EPOCHS - 1:
            print(f"  epoch {epoch:3d}  train MSE = {epoch_loss / n_batches:.5f}  holdout MSE = {holdout_loss:.5f}")

        if holdout_loss < best_holdout_loss - 1e-6:
            best_holdout_loss = holdout_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= EARLY_STOP_PATIENCE:
                print(f"  early stopping at epoch {epoch} (best holdout MSE = {best_holdout_loss:.5f})")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    return model


def compute_bootstrap_thresholds(training_errors: np.ndarray) -> tuple[float, float, float]:
    """Returns (theta_lo, theta_hi, point_threshold). See module docstring
    for the tiering these back — HIGH/MARGINAL/NORMAL — and its provenance.
    """
    point_threshold = float(training_errors.mean() + 2 * training_errors.std())

    rng = np.random.default_rng(SEED + 7)
    n = len(training_errors)
    resampled_thresholds = np.empty(N_BOOTSTRAP_RESAMPLES)
    for i in range(N_BOOTSTRAP_RESAMPLES):
        resample = rng.choice(training_errors, size=n, replace=True)
        resampled_thresholds[i] = resample.mean() + 2 * resample.std()

    theta_lo = float(np.percentile(resampled_thresholds, 2.5))
    theta_hi = float(np.percentile(resampled_thresholds, 97.5))
    return theta_lo, theta_hi, point_threshold


def evaluate_on_validation(
    model: LSTMAutoencoder,
    val_windows_scaled: np.ndarray,
    val_labels: np.ndarray,
    val_types: np.ndarray,
    theta_lo: float,
    theta_hi: float,
) -> None:
    model.eval()
    with torch.no_grad():
        val_data = torch.tensor(val_windows_scaled, dtype=torch.float32)
        reconstruction = model(val_data)
        errors = recent_reconstruction_error(reconstruction, val_data).numpy()

    flagged = errors >= theta_hi
    marginal = (errors >= theta_lo) & (errors < theta_hi)

    true_positive = int(np.sum(flagged & (val_labels == 1)))
    false_positive = int(np.sum(flagged & (val_labels == 0)))
    false_negative = int(np.sum(~flagged & (val_labels == 1)))
    true_negative = int(np.sum(~flagged & (val_labels == 0)))

    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)

    print("\nValidation results (HIGH tier only, i.e. MSE >= theta_hi):")
    print(f"  true positive={true_positive}  false positive={false_positive}  false negative={false_negative}  true negative={true_negative}")
    print(f"  precision={precision:.3f}  recall={recall:.3f}")
    print(f"  MARGINAL tier count: {int(marginal.sum())}")

    for anomaly_type in ("subscription_creep", "micro_burst"):
        type_mask = val_types == anomaly_type
        type_labels = val_labels[type_mask]
        type_flagged = flagged[type_mask]
        type_recall = np.sum(type_flagged & (type_labels == 1)) / max(np.sum(type_labels == 1), 1)
        print(f"  recall on {anomaly_type} anomalies specifically: {type_recall:.3f}")


def export_onnx(model: LSTMAutoencoder, num_features: int, window_days: int) -> None:
    model.eval()
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)

    dummy_input = torch.zeros(1, window_days, num_features)

    torch.onnx.export(
        model,
        (dummy_input,),
        str(MODEL_PATH),
        input_names=["input"],
        output_names=["reconstruction"],
        opset_version=OPSET_VERSION,
        # No dynamic_shapes — fixed (1, window_days, num_features) shape by
        # design, per this feature's own spec (see module docstring).
    )

    # Fold any external-data split back into one self-contained file — see
    # scripts/train-forecaster.py's identical fix for why the exporter
    # defaults to splitting weights out, and why that's unwanted here at
    # this model's tiny size (a single fetch() in the worker, no second
    # file to keep in sync).
    reloaded = onnx.load(str(MODEL_PATH), load_external_data=True)
    onnx.save_model(reloaded, str(MODEL_PATH), save_as_external_data=False)
    external_data_path = MODEL_PATH.with_name(MODEL_PATH.name + ".data")
    if external_data_path.exists():
        external_data_path.unlink()

    print(f"\nExported ONNX model to {MODEL_PATH} ({MODEL_PATH.stat().st_size / 1024:.1f} KB, single file, no external data)")

    onnx_model = onnx.load(str(MODEL_PATH))
    onnx.checker.check_model(onnx_model)
    print("onnx.checker.check_model: structurally valid.")


def verify_onnx(model: LSTMAutoencoder, num_features: int, window_days: int) -> None:
    """Confirms the exported ONNX graph produces the same reconstruction as
    the source PyTorch model, on data it never trained on — not just that
    the checker didn't complain. Same discipline as
    scripts/train-forecaster.py's verify_onnx().
    """
    model.eval()
    session = ort.InferenceSession(str(MODEL_PATH), providers=["CPUExecutionProvider"])

    rng = np.random.default_rng(SEED + 99)
    test_input_np = rng.normal(0.0, 1.0, size=(1, window_days, num_features)).astype(np.float32)
    test_input_pt = torch.tensor(test_input_np)

    with torch.no_grad():
        pytorch_output = model(test_input_pt).numpy()

    (onnx_output,) = session.run(["reconstruction"], {"input": test_input_np})

    max_abs_diff = float(np.max(np.abs(pytorch_output - onnx_output)))
    print(f"\nMax abs diff between PyTorch and ONNX reconstructions: {max_abs_diff:.2e}")
    assert max_abs_diff < 1e-4, "ONNX export diverged from the source PyTorch model beyond float32 tolerance"
    print("PASS — exported ONNX graph is numerically equivalent to the trained PyTorch model.")


def write_metadata(
    metadata: dict,
    theta_lo: float,
    theta_hi: float,
    point_threshold: float,
) -> None:
    meta_path = MODEL_PATH.with_suffix(".meta.json")
    meta = {
        "windowDays": metadata["windowDays"],
        "numFeatures": metadata["numFeatures"],
        "featureNames": metadata["featureNames"],
        "categories": metadata["categories"],
        "hiddenSize": HIDDEN_SIZE,
        "bottleneckDim": BOTTLENECK_DIM,
        "opsetVersion": OPSET_VERSION,
        "inputNames": ["input"],
        "outputNames": ["reconstruction"],
        "normalization": {
            "method": "log1p, then per-window baseline z-score — NOT a precomputed/shipped scaler",
            "baselineDays": BASELINE_DAYS,
            "recentDays": metadata["windowDays"] - BASELINE_DAYS,
            "description": (
                "Step 1: apply log1p (natural log of 1+x) to EVERY raw value in the "
                "windowDays x numFeatures window — every feature here is a non-negative "
                "count or agorot amount, so log1p is defined everywhere and log1p(0)=0. "
                "This step is not optional: skipping it reproduces a real bug this "
                "pipeline hit (see train_autoencoder.py's normalize_windows() docstring) "
                "where a rarely-nonzero raw-agorot feature could blow up the reconstruction "
                "error by itself. Step 2: on the log1p-transformed window, compute mean/std "
                "per feature over ONLY the first baselineDays days (std floored at 1.0 if "
                "< 1e-6), then z-score all windowDays days (baseline days AND the trailing "
                "recentDays days) using that mean/std. Must be recomputed live for every "
                "user, every inference call — there is no global scaler to load."
            ),
        },
        "anomalySignal": {
            "recentEvalDays": RECENT_EVAL_DAYS,
            "description": (
                "Run the normalized (windowDays x numFeatures) tensor through the ONNX "
                "model to get a same-shaped reconstruction. Compute squared error per "
                "day (mean over the feature dimension only), then take the mean of just "
                "the LAST recentEvalDays day(s) of that per-day error — never the whole "
                "window's average error, which dilutes a single anomalous day's signal "
                "across every unaffected day and was empirically much less sensitive "
                "(see recent_reconstruction_error()'s docstring in train_autoencoder.py). "
                "Compare that single number against thresholds.thetaHi/thetaLo below."
            ),
        },
        "thresholds": {
            "thetaLo": theta_lo,
            "thetaHi": theta_hi,
            "pointThreshold": point_threshold,
            "tiers": "HIGH if signal >= thetaHi; MARGINAL if thetaLo <= signal < thetaHi; NORMAL if signal < thetaLo",
        },
        "thresholdMethodology": (
            "Bootstrap-CI tiered classification (2000 resamples of the training "
            "reconstruction-error distribution; theta_lo/theta_hi are the 2.5th/97.5th "
            "percentiles of each resample's own mean+2*std threshold)."
        ),
        "trainedOn": "synthetic data only (see ml-pipeline/synthesize_ledger.py) — not real financial transaction data",
        "seed": SEED,
        "moneyUnit": "agorot (integer minor units of ILS)",
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Wrote metadata to {meta_path}")


def main() -> None:
    metadata = load_metadata()
    train_windows, val_windows, val_labels, val_types = load_sequences()

    num_features = metadata["numFeatures"]
    window_days = metadata["windowDays"]
    assert train_windows.shape[1:] == (window_days, num_features)

    train_windows_scaled = normalize_windows(train_windows)
    val_windows_scaled = normalize_windows(val_windows)

    model = LSTMAutoencoder(num_features, window_days)
    model = train(model, train_windows_scaled)

    model.eval()
    with torch.no_grad():
        train_data = torch.tensor(train_windows_scaled, dtype=torch.float32)
        train_reconstruction = model(train_data)
        training_errors = recent_reconstruction_error(train_reconstruction, train_data).numpy()

    theta_lo, theta_hi, point_threshold = compute_bootstrap_thresholds(training_errors)
    print(
        f"\nThresholds — point (mean+2*std) = {point_threshold:.5f}, "
        f"bootstrap 95% CI = [{theta_lo:.5f}, {theta_hi:.5f}]"
    )

    evaluate_on_validation(model, val_windows_scaled, val_labels, val_types, theta_lo, theta_hi)

    export_onnx(model, num_features, window_days)
    verify_onnx(model, num_features, window_days)
    write_metadata(metadata, theta_lo, theta_hi, point_threshold)


if __name__ == "__main__":
    main()
