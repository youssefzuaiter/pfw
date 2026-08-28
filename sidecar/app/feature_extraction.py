"""
Deterministic text -> fixed-size numeric feature vector via the
"hashing trick": character trigrams, each hashed into one of FEATURE_DIM
buckets, counted, then L1-normalized. No ML framework needed for this
step — it's what turns a merchant string into the fixed-size input the
ONNX model's MatMul actually operates on.

Pure-Python `str`/`hashlib` handle Hebrew (and any other script) natively
— there's no ASCII assumption anywhere in this module, unlike the classic
`\b`-regex pitfall documented in src/lib/text-matching.ts on the Node
side (see AGENTS.md for the "Hebrew regex boundary safety" law this
guards on the TypeScript side; this file is the equivalent care taken on
the Python side of the embedding pipeline).
"""

import hashlib

from .constants import FEATURE_DIM


def normalize_text(text: str) -> str:
    return " ".join(text.strip().lower().split())


def char_trigrams(text: str) -> list[str]:
    if not text:
        return []
    padded = f"  {text} "
    return [padded[i : i + 3] for i in range(len(padded) - 2)]


def hash_bucket(token: str, dim: int = FEATURE_DIM) -> int:
    digest = hashlib.sha256(token.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % dim


def extract_features(text: str, dim: int = FEATURE_DIM) -> list[float]:
    """Bag-of-hashed-trigrams feature vector, L1-normalized so text length doesn't dominate the magnitude."""
    trigrams = char_trigrams(normalize_text(text))
    vector = [0.0] * dim

    if not trigrams:
        return vector

    for trigram in trigrams:
        vector[hash_bucket(trigram, dim)] += 1.0

    total = sum(vector)
    if total > 0:
        vector = [v / total for v in vector]

    return vector
