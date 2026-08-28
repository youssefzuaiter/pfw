"""Shared constants between the feature extractor, the model builder, and the serving app."""

# Size of the hashed-trigram bag-of-features vector fed into the ONNX model.
FEATURE_DIM = 4096

# Output embedding size — the spec's "384-dimension embeddings" requirement.
EMBEDDING_DIM = 384

# Fixed seed for the random projection matrix, so `python build_model.py`
# always reproduces the exact same model file byte-for-byte.
RANDOM_SEED = 20260827

MODEL_VERSION = "v1-random-projection"
