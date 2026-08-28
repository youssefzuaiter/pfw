"""
Loads the exported ONNX model and runs inference via ONNX Runtime. No
PyTorch (or any other training framework) is imported here, in main.py,
or anywhere else at request-serving time — inference is ONNX Runtime
only, per the spec's "no runtime PyTorch" requirement.
"""

import pathlib
from functools import lru_cache

import numpy as np
import onnxruntime as ort

from .feature_extraction import extract_features

MODEL_PATH = pathlib.Path(__file__).parent.parent / "model" / "embedding_model.onnx"


class ModelNotBuiltError(RuntimeError):
    pass


class EmbeddingModel:
    def __init__(self, model_path: pathlib.Path = MODEL_PATH):
        if not model_path.exists():
            raise ModelNotBuiltError(
                f"ONNX model not found at {model_path}. Run `python -m app.build_model` from sidecar/ first."
            )
        self._session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self._input_name = self._session.get_inputs()[0].name

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        features = np.array([extract_features(text) for text in texts], dtype=np.float32)
        (output,) = self._session.run(None, {self._input_name: features})
        return output.tolist()


@lru_cache(maxsize=1)
def get_embedding_model() -> EmbeddingModel:
    return EmbeddingModel()
