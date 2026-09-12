"""
Loads the trained LSTM-autoencoder ONNX export
(public/models/spending_anomaly.onnx, AGENTS.md §3ll) and runs the same
inference/scoring pipeline src/lib/ml/anomaly-worker-handlers.ts runs in
the browser. Same "no PyTorch at request-serving time" discipline
embedding_model.py already follows -- ml-pipeline/train_autoencoder.py
trains in PyTorch offline, in a throwaway venv, and exports ONNX; this
module only ever loads that exported graph via ONNX Runtime.
"""

import pathlib
from functools import lru_cache

import numpy as np
import onnxruntime as ort

from .anomaly_constants import (
    ANOMALY_MODEL_PATH,
    CATEGORIES,
    FEATURE_NAMES,
    NUM_FEATURES,
    RECENT_EVAL_DAYS,
    THETA_HI,
    THETA_LO,
    WINDOW_DAYS,
)
from .anomaly_features import build_daily_feature_matrix, normalize_window


class AnomalyModelNotBuiltError(RuntimeError):
    pass


def _classify_tier(signal: float) -> str:
    if signal >= THETA_HI:
        return "HIGH"
    if signal >= THETA_LO:
        return "MARGINAL"
    return "NORMAL"


def _top_contributor(last_day_feature_errors: list[float]) -> tuple[str, str | None]:
    top_index = max(range(len(last_day_feature_errors)), key=lambda i: last_day_feature_errors[i])
    top_feature = FEATURE_NAMES[top_index]
    top_category = CATEGORIES[top_index - 3] if top_index >= 3 else None
    return top_feature, top_category


class AnomalyModel:
    def __init__(self, model_path: pathlib.Path = ANOMALY_MODEL_PATH):
        if not model_path.exists():
            raise AnomalyModelNotBuiltError(
                f"Anomaly-detection ONNX model not found at {model_path}. "
                "This is a committed build artifact (public/models/spending_anomaly.onnx), not "
                "something this service generates -- if it's genuinely missing, run "
                "`cd ml-pipeline && python synthesize_ledger.py && python train_autoencoder.py` "
                "from the repo root (see ml-pipeline/README.md)."
            )
        self._session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self._input_name = self._session.get_inputs()[0].name
        self._output_name = self._session.get_outputs()[0].name

    def detect(self, transactions: list[dict], window_end_date_key: str) -> dict:
        """
        Runs the full pipeline end to end: aggregate raw transactions into
        the dense feature matrix, normalize, run the ONNX model, score the
        final day's reconstruction error, and classify it -- the exact
        request-shaped equivalent of `createAnomalyDetectionHandlers().checkAnomaly`
        on the TypeScript side.
        """
        matrix = build_daily_feature_matrix(transactions, window_end_date_key)
        normalized_input = normalize_window(matrix)

        input_tensor = np.array(normalized_input, dtype=np.float32).reshape(1, WINDOW_DAYS, NUM_FEATURES)
        (reconstruction,) = self._session.run([self._output_name], {self._input_name: input_tensor})
        reconstruction_flat = reconstruction.reshape(-1).tolist()

        last_day_start = (WINDOW_DAYS - RECENT_EVAL_DAYS) * NUM_FEATURES
        last_day_feature_errors = [
            (reconstruction_flat[last_day_start + f] - normalized_input[last_day_start + f]) ** 2
            for f in range(NUM_FEATURES)
        ]
        signal = sum(last_day_feature_errors) / NUM_FEATURES
        top_feature, top_category = _top_contributor(last_day_feature_errors)

        return {
            "tier": _classify_tier(signal),
            "signal": signal,
            "thresholds": {"thetaLo": THETA_LO, "thetaHi": THETA_HI},
            "topFeature": top_feature,
            "topCategory": top_category,
        }


@lru_cache(maxsize=1)
def get_anomaly_model() -> AnomalyModel:
    return AnomalyModel()
