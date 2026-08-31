"""Trains and exports the stochastic cash-flow forecaster (AGENTS.md §3dd).

Genuinely trains a small autoregressive probabilistic RNN — this is
explicitly NOT a randomly-initialized "dummy" model. A confidence-band
UI (p5/median/p95, src/app/dashboard/_components/runway-forecast-chart.tsx)
built on untrained weights would show statistically meaningless numbers
with the visual authority of a real forecast, which is worse than not
shipping the feature at all — the same reasoning src/lib/monte-carlo.ts
(AGENTS.md §3n) was built around: an honest probability, never a
fake-looking one.

Architecture — a single-step, stateful LSTM cell (DeepAR-shaped: a
learned per-day Gaussian head, driven autoregressively), NOT a model
that unrolls a fixed 30-day sequence internally:

    input  = [previous day's normalized cash-flow delta, sin(dow), cos(dow)]
    state  = (h, c)              — LSTMCell hidden/cell state
    output = (mean, log_var, h', c')   — next day's predicted N(mean, exp(log_var))

Exporting only the single step (not a 30-day unroll, and no sampling
inside the graph — ONNX graphs are static compute graphs, ill-suited to
hosting a random draw) is what lets the SAME small graph serve two
different phases at inference time, both driven from
src/workers/forecaster-worker-handlers.ts:
  1. Warmup: teacher-forced over the real last 90 days (feeds each real
     observed delta back in), building a hidden state that actually
     reflects a specific user's real recent cash-flow pattern.
  2. Rollout: autoregressive for 30 days, batched across many
     independent Monte Carlo paths at once (the LSTM's batch dimension
     is exactly this) — each path samples its own delta from the
     predicted Gaussian and feeds ITS OWN sample back in as the next
     step's input, exactly like src/lib/monte-carlo.ts's per-year
     Box-Muller draws, just replacing the hand-specified return
     distribution with a learned one. Empirical percentiles (p5/p50/p95)
     are computed FROM the resulting ensemble of sampled paths in
     src/workers/forecaster-worker-handlers.ts, not analytically
     propagated through 30 days of compounding Gaussians — the same
     "many stochastic paths, then take percentiles" approach the
     Monte Carlo engine already uses, for the same reason: it's simpler
     and more robust than closed-form uncertainty propagation.

Per-series normalization, not a fixed baked-in scale: every real
household's cash flow lives at a different absolute scale (agorot
figures vary by orders of magnitude person to person). The model never
sees raw currency units — every synthetic training series is normalized
by ITS OWN mean/std before training, and
forecaster-worker-handlers.ts does the identical normalize-by-the-
user's-own-recent-statistics step before calling into the model, then
de-normalizes the output back into agorot. This is standard practice
for small per-series RNN forecasters (the same idea DeepAR-style models
use) and avoids inventing a fake "typical" cash-flow scale to bake into
the weights.

Verified END TO END in this pass, not just written: trained for real,
exported to ONNX, and the exported graph's outputs were compared
numerically against the original PyTorch model's outputs on held-out
synthetic data (see the verification block at the bottom) — both
match to float32 precision. Run inside a throwaway venv
(`python3 -m venv .venv && source .venv/bin/activate && pip install
--index-url https://download.pytorch.org/whl/cpu torch && pip install
onnx onnxruntime numpy`), torn down immediately after — this app has no
permanent Python ML toolchain, matching sidecar/'s own "own a small,
separate Python environment only where genuinely needed" precedent
rather than adding a project-wide Python dependency for one training
script that only ever needs to run once (or again, if this model is
ever retrained).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn

# ---------------------------------------------------------------------
# Reproducibility — same "deterministic, seeded" habit this app already
# holds for its own mock-data generator (prisma/seed/rng.ts's mulberry32).
# ---------------------------------------------------------------------
SEED = 20260904
torch.manual_seed(SEED)
np.random.seed(SEED)

HIDDEN_SIZE = 32
INPUT_SIZE = 3  # [prev_delta_normalized, sin(dow), cos(dow)]
SEQUENCE_LENGTH = 120  # days per synthetic series
N_SERIES = 2000
N_EPOCHS = 30
BATCH_SIZE = 64
LEARNING_RATE = 3e-3
OPSET_VERSION = 18  # torch 2.13's dynamo-based exporter targets 18 natively; forcing a downgrade to 17 produced an invalid graph (a Split node using opset-18-only `num_outputs`) — verified by hitting that exact failure first, not guessed

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = REPO_ROOT / "public" / "models" / "cashflow-forecaster.onnx"


# ---------------------------------------------------------------------
# Synthetic data — stochastic drift (a slowly random-walking baseline
# level) + weekly seasonality (a random per-series day-of-week profile,
# since real households differ in WHICH days carry income/spend spikes,
# not just whether they do) + Gaussian noise. Deliberately not modeled
# on this app's own real seed data (prisma/seed/israeli-data.ts) — that
# generator is JS/mulberry32-driven and this is an independent NumPy
# implementation producing a similarly-*shaped* (trend + weekly pattern
# + noise) but not identical distribution; close enough to be a
# meaningful training signal for a small demo model, not a claim of
# matching this app's exact mock-data statistics.
# ---------------------------------------------------------------------
def generate_synthetic_series(n_series: int, length: int) -> np.ndarray:
    series = np.zeros((n_series, length), dtype=np.float64)
    for i in range(n_series):
        trend_vol = np.random.uniform(0.5, 2.0)
        noise_vol = np.random.uniform(1.0, 3.0)
        seasonal_amplitude = np.random.uniform(1.0, 4.0)
        weekly_profile = np.random.normal(0.0, 1.0, size=7) * seasonal_amplitude
        weekly_profile -= weekly_profile.mean()  # a week's seasonal effects should net to ~0

        level = np.random.uniform(-1.0, 1.0)
        levels = np.zeros(length)
        for t in range(length):
            level += np.random.normal(0.0, trend_vol)
            levels[t] = level

        dow = np.arange(length) % 7
        seasonal = weekly_profile[dow]
        noise = np.random.normal(0.0, noise_vol, size=length)
        series[i] = levels + seasonal + noise

    return series


def normalize_per_series(series: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Each row normalized by ITS OWN mean/std — mirrors what the Worker does to a real user's history."""
    mean = series.mean(axis=1, keepdims=True)
    std = series.std(axis=1, keepdims=True)
    std = np.where(std < 1e-6, 1.0, std)  # a perfectly flat synthetic series (rare) shouldn't divide by ~0
    normalized = (series - mean) / std
    return normalized, mean.squeeze(1), std.squeeze(1)


def dow_features(length: int) -> np.ndarray:
    dow = np.arange(length) % 7
    angle = 2 * math.pi * dow / 7
    return np.stack([np.sin(angle), np.cos(angle)], axis=1)  # [length, 2]


# ---------------------------------------------------------------------
# Model — see module docstring for why this is a single step, not a
# 30-day unroll.
# ---------------------------------------------------------------------
class CashflowForecasterCell(nn.Module):
    def __init__(self, input_size: int = INPUT_SIZE, hidden_size: int = HIDDEN_SIZE) -> None:
        super().__init__()
        self.cell = nn.LSTMCell(input_size, hidden_size)
        self.head = nn.Linear(hidden_size, 2)  # [mean, log_var]

    def forward(
        self, x: torch.Tensor, h: torch.Tensor, c: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        h_next, c_next = self.cell(x, (h, c))
        out = self.head(h_next)
        mean, log_var = out[:, 0:1], out[:, 1:2]
        # Clamped, not left unbounded: an untrained-region input (e.g. an
        # early, poorly-conditioned training step) can otherwise drive
        # log_var to a huge value, producing an Inf/NaN loss that stalls
        # training — bounding it to a generous but finite range keeps
        # training numerically stable without materially constraining
        # what the model can express once it HAS learned something
        # sensible.
        log_var = torch.clamp(log_var, min=-8.0, max=8.0)
        return mean, log_var, h_next, c_next


def gaussian_nll(mean: torch.Tensor, log_var: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    var = torch.exp(log_var)
    return 0.5 * (log_var + (target - mean) ** 2 / var).mean()


def train() -> CashflowForecasterCell:
    print(f"Generating {N_SERIES} synthetic series of {SEQUENCE_LENGTH} days each...")
    raw = generate_synthetic_series(N_SERIES, SEQUENCE_LENGTH)
    normalized, _mean, _std = normalize_per_series(raw)
    dow = dow_features(SEQUENCE_LENGTH)  # shared across all series — same calendar

    data = torch.tensor(normalized, dtype=torch.float32)  # [N_SERIES, SEQUENCE_LENGTH]
    dow_t = torch.tensor(dow, dtype=torch.float32)  # [SEQUENCE_LENGTH, 2]

    model = CashflowForecasterCell()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)

    n_batches = N_SERIES // BATCH_SIZE
    print(f"Training for {N_EPOCHS} epochs ({n_batches} batches/epoch, batch size {BATCH_SIZE})...")
    for epoch in range(N_EPOCHS):
        permutation = torch.randperm(N_SERIES)
        epoch_loss = 0.0
        for batch_idx in range(n_batches):
            indices = permutation[batch_idx * BATCH_SIZE : (batch_idx + 1) * BATCH_SIZE]
            batch = data[indices]  # [BATCH_SIZE, SEQUENCE_LENGTH]

            h = torch.zeros(BATCH_SIZE, HIDDEN_SIZE)
            c = torch.zeros(BATCH_SIZE, HIDDEN_SIZE)
            prev_delta = torch.zeros(BATCH_SIZE, 1)

            optimizer.zero_grad()
            loss = torch.tensor(0.0)
            for t in range(SEQUENCE_LENGTH):
                dow_step = dow_t[t].unsqueeze(0).expand(BATCH_SIZE, -1)
                step_input = torch.cat([prev_delta, dow_step], dim=1)
                mean, log_var, h, c = model(step_input, h, c)
                target = batch[:, t : t + 1]
                loss = loss + gaussian_nll(mean, log_var, target)
                prev_delta = target  # teacher forcing — the REAL value, not the model's own prediction

            loss = loss / SEQUENCE_LENGTH
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()

        if epoch % 5 == 0 or epoch == N_EPOCHS - 1:
            print(f"  epoch {epoch:3d}  mean NLL/step = {epoch_loss / n_batches:.4f}")

    return model


# ---------------------------------------------------------------------
# Export — dynamic batch axis so the Worker can run many Monte Carlo
# rollout paths through one onnxruntime.run() call per day, not one
# call per path per day.
# ---------------------------------------------------------------------
def export_onnx(model: CashflowForecasterCell) -> None:
    model.eval()
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)

    dummy_input = torch.zeros(2, INPUT_SIZE)  # batch=2 in the trace itself, not 1 — makes sure the
    dummy_h = torch.zeros(2, HIDDEN_SIZE)  # exporter can't accidentally treat the batch dim as
    dummy_c = torch.zeros(2, HIDDEN_SIZE)  # a fixed constant equal to 1.

    # `dynamic_shapes`, not the legacy `dynamic_axes` — torch 2.13's
    # dynamo-based exporter (the only one available now that onnxscript
    # is installed) warned that `dynamic_axes` isn't reliable under it,
    # and that warning was concretely reproduced: the first working
    # export computed correct values (verified below) but declared a
    # static batch=1 shape on every OUTPUT despite `dynamic_axes` asking
    # for a dynamic one, producing a real (if harmless-in-Python)
    # shape-mismatch warning on every batch>1 call. Keyed by this
    # module's forward() parameter names (x, h, c), not the ONNX
    # input_names below — those are two independent naming layers.
    batch_dim = torch.export.Dim("batch")
    dynamic_shapes = {
        "x": {0: batch_dim},
        "h": {0: batch_dim},
        "c": {0: batch_dim},
    }

    torch.onnx.export(
        model,
        (dummy_input, dummy_h, dummy_c),
        str(MODEL_PATH),
        input_names=["input", "h_in", "c_in"],
        output_names=["mean", "log_var", "h_out", "c_out"],
        dynamic_shapes=dynamic_shapes,
        opset_version=OPSET_VERSION,
    )

    # torch's dynamo-based exporter defaults to splitting weights into a
    # separate `.onnx.data` external-data file (sensible for a large
    # model, over ONNX protobuf's 2GB inline limit — irrelevant at this
    # model's actual size). Re-saving with save_as_external_data=False
    # re-embeds everything into one self-contained .onnx file, which is
    # what src/workers/forecaster-worker-handlers.ts fetches — a single
    # `fetch()` + `InferenceSession.create()` call, no second file, no
    # `externalData` wiring to keep in sync with it.
    reloaded = onnx.load(str(MODEL_PATH), load_external_data=True)
    onnx.save_model(reloaded, str(MODEL_PATH), save_as_external_data=False)
    external_data_path = MODEL_PATH.with_name(MODEL_PATH.name + ".data")
    if external_data_path.exists():
        external_data_path.unlink()

    print(f"Exported ONNX model to {MODEL_PATH} ({MODEL_PATH.stat().st_size / 1024:.1f} KB, single file, no external data)")

    onnx_model = onnx.load(str(MODEL_PATH))
    onnx.checker.check_model(onnx_model)
    print("onnx.checker.check_model: structurally valid.")


# ---------------------------------------------------------------------
# Verification — the exported graph must produce the SAME numbers as
# the PyTorch model it was exported from, run over a real multi-step
# rollout (not just a single forward pass), on data the model never
# trained on. This is what actually proves the export is correct, not
# just "checker.check_model didn't complain."
# ---------------------------------------------------------------------
def verify_onnx(model: CashflowForecasterCell) -> None:
    model.eval()
    session = ort.InferenceSession(str(MODEL_PATH), providers=["CPUExecutionProvider"])

    rng = np.random.default_rng(SEED + 1)
    test_series = generate_synthetic_series(1, SEQUENCE_LENGTH)
    normalized, _mean, _std = normalize_per_series(test_series)
    dow = dow_features(SEQUENCE_LENGTH)

    batch = 4  # also exercises the dynamic batch axis, not just batch=1
    h_pt = torch.zeros(batch, HIDDEN_SIZE)
    c_pt = torch.zeros(batch, HIDDEN_SIZE)
    h_onnx = np.zeros((batch, HIDDEN_SIZE), dtype=np.float32)
    c_onnx = np.zeros((batch, HIDDEN_SIZE), dtype=np.float32)
    prev_delta_pt = torch.zeros(batch, 1)
    prev_delta_onnx = np.zeros((batch, 1), dtype=np.float32)

    max_abs_diff = 0.0
    with torch.no_grad():
        for t in range(SEQUENCE_LENGTH):
            dow_step = dow[t]
            step_input_pt = torch.cat(
                [prev_delta_pt, torch.tensor(dow_step, dtype=torch.float32).unsqueeze(0).expand(batch, -1)], dim=1
            )
            mean_pt, log_var_pt, h_pt, c_pt = model(step_input_pt, h_pt, c_pt)

            step_input_onnx = np.concatenate(
                [prev_delta_onnx, np.tile(dow_step.astype(np.float32), (batch, 1))], axis=1
            ).astype(np.float32)
            mean_onnx, log_var_onnx, h_onnx, c_onnx = session.run(
                ["mean", "log_var", "h_out", "c_out"],
                {"input": step_input_onnx, "h_in": h_onnx, "c_in": c_onnx},
            )

            max_abs_diff = max(
                max_abs_diff,
                float(np.max(np.abs(mean_pt.numpy() - mean_onnx))),
                float(np.max(np.abs(log_var_pt.numpy() - log_var_onnx))),
            )

            # Feed real observed data back in (a "warmup"-shaped check —
            # the actual autoregressive/sampling loop is the Worker's
            # job, not this script's; this just proves the exported
            # graph tracks the PyTorch model step for step).
            next_val = float(normalized[0, t])
            prev_delta_pt = torch.full((batch, 1), next_val)
            prev_delta_onnx = np.full((batch, 1), next_val, dtype=np.float32)

    print(f"Max abs diff between PyTorch and ONNX outputs over {SEQUENCE_LENGTH} steps, batch={batch}: {max_abs_diff:.2e}")
    assert max_abs_diff < 1e-4, "ONNX export diverged from the source PyTorch model beyond float32 tolerance"
    print("PASS — exported ONNX graph is numerically equivalent to the trained PyTorch model.")


def write_metadata() -> None:
    """
    Ships alongside the .onnx file so forecaster-worker-handlers.ts
    doesn't need to hardcode architecture constants separately from
    what was actually trained/exported here.
    """
    meta_path = MODEL_PATH.with_suffix(".meta.json")
    meta = {
        "inputSize": INPUT_SIZE,
        "hiddenSize": HIDDEN_SIZE,
        "opsetVersion": OPSET_VERSION,
        "inputNames": ["input", "h_in", "c_in"],
        "outputNames": ["mean", "log_var", "h_out", "c_out"],
        "trainedOn": "synthetic data only (see this script) — not this app's real seeded data, not real financial time series",
        "seed": SEED,
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Wrote metadata to {meta_path}")


if __name__ == "__main__":
    trained_model = train()
    export_onnx(trained_model)
    verify_onnx(trained_model)
    write_metadata()
