# PFW Spending-Anomaly ML Pipeline

Trains the LSTM autoencoder behind the in-browser "Behavioral Spending
Anomaly Detection" feature (AGENTS.md). Runs entirely offline, once (or
again if the model is ever retrained) — this app has no permanent Python
ML toolchain, matching `sidecar/`'s and `scripts/train-forecaster.py`'s
own "own a small, separate Python environment only where genuinely
needed" precedent.

**Nothing here talks to the real app or a real database.** Both scripts
work on synthetic data only; the only artifact that ever reaches the app
is the exported ONNX model + its `.meta.json`, committed under
`public/models/`.

Built from scratch for this feature — an original LSTM sequence-to-
sequence autoencoder sized for a 30-day transaction-history window, with
a standard bootstrap-CI tiered threshold (HIGH/MARGINAL/NORMAL) on top,
not adapted from any other project.

## Setup

```bash
cd ml-pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run (in order)

```bash
python synthesize_ledger.py    # writes data/{train,val}_sequences.npz + metadata.json (gitignored)
python train_autoencoder.py    # trains, prints validation precision/recall, exports:
                                #   public/models/spending_anomaly.onnx
                                #   public/models/spending_anomaly.meta.json
```

Both files under `public/models/` are real build artifacts, committed to
the repo (not gitignored) — the same treatment
`public/models/cashflow-forecaster.onnx` already gets. `data/` is
regenerated fresh each run and never committed.

## Teardown

```bash
deactivate
cd .. && rm -rf ml-pipeline/.venv
```

## What's in each file

- `synthesize_ledger.py` — generates two independent synthetic household
  pools: an entirely-normal TRAIN pool, and a VAL pool where every
  household gets exactly one injected anomaly (`subscription_creep` or
  `micro_burst`). See its own module docstring for the exact per-day
  feature vector and injection mechanics.
- `train_autoencoder.py` — fits the LSTM autoencoder on the TRAIN pool
  only, calibrates the bootstrap-CI anomaly thresholds from the training
  reconstruction-error distribution, sanity-checks recall against the
  VAL pool's two known anomaly types, exports to ONNX with a **fixed**
  `(1, 30, 10)` input shape, verifies the exported graph numerically
  against the source PyTorch model, and writes the normalization method
  (log1p, then per-window baseline z-score — no global scaler is fit or
  shipped) + thresholds every downstream consumer needs into
  `.meta.json`.
