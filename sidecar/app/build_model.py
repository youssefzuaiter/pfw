"""
Builds and exports the ONNX embedding model: a fixed (seeded) random
projection from FEATURE_DIM (4096) hashed-trigram features down to
EMBEDDING_DIM (384), followed by L2 normalization.

This is a real, principled technique — a Johnson-Lindenstrauss random
projection — that approximately preserves cosine-similarity relationships
in a fixed lower-dimensional space. It has no *learned* semantic
knowledge the way a trained transformer embedding model would (it can't
know "cafe" and "coffee shop" mean the same thing); what it gives Phase 3
is a genuinely-ONNX-Runtime-served, 384-dimension embedding pipeline with
the exact right interface and cosine-similarity properties for the KNN
categorization tier (src/lib/categorization/tier3-knn.ts) to consume and
be tested against today.

Swapping in a real trained multilingual sentence-embedding model later
(e.g. a distilled multilingual MiniLM exported via optimum/onnxruntime)
is a matter of replacing this file's model-construction logic — the
FastAPI interface (main.py), the 384-dim output contract, and the
Node-side client (src/server/embeddings/sidecar-client.ts) all stay
exactly the same. See AGENTS.md for why that swap wasn't done in this
phase (a production embedding model is a multi-hundred-MB download and a
PyTorch/transformers/optimum toolchain just to run an export script once
— disproportionate for what Phase 3 asks for, which is the interface).

Run: python -m app.build_model   (from the sidecar/ directory)
Produces: sidecar/model/embedding_model.onnx (gitignored — regenerate,
don't hand-edit or expect it to be checked in).
"""

import pathlib

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from .constants import EMBEDDING_DIM, FEATURE_DIM, RANDOM_SEED

MODEL_OUTPUT_PATH = pathlib.Path(__file__).parent.parent / "model" / "embedding_model.onnx"


def build_model() -> onnx.ModelProto:
    rng = np.random.default_rng(RANDOM_SEED)
    # Scaled so projected vectors have a reasonable norm before L2 normalization.
    projection = rng.normal(loc=0.0, scale=1.0 / np.sqrt(FEATURE_DIM), size=(FEATURE_DIM, EMBEDDING_DIM)).astype(
        np.float32
    )

    input_tensor = helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, FEATURE_DIM])
    output_tensor = helper.make_tensor_value_info("embedding", TensorProto.FLOAT, [None, EMBEDDING_DIM])
    weight_initializer = numpy_helper.from_array(projection, name="projection_matrix")

    matmul_node = helper.make_node("MatMul", ["features", "projection_matrix"], ["projected"], name="project")
    normalize_node = helper.make_node(
        "LpNormalization", ["projected"], ["embedding"], axis=1, p=2, name="l2_normalize"
    )

    graph = helper.make_graph(
        [matmul_node, normalize_node],
        "merchant_embedding_model",
        [input_tensor],
        [output_tensor],
        initializer=[weight_initializer],
    )

    model = helper.make_model(graph, producer_name="pfw-sidecar", opset_imports=[helper.make_opsetid("", 18)])
    onnx.checker.check_model(model)
    return model


def build_and_save(output_path: pathlib.Path = MODEL_OUTPUT_PATH) -> pathlib.Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(build_model(), str(output_path))
    return output_path


if __name__ == "__main__":
    saved_path = build_and_save()
    print(f"Saved model to {saved_path}")
