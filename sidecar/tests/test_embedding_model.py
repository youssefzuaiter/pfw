import math

import pytest

from app.constants import EMBEDDING_DIM
from app.embedding_model import EmbeddingModel, ModelNotBuiltError
import pathlib


@pytest.fixture(scope="module")
def model() -> EmbeddingModel:
    return EmbeddingModel()


def test_raises_a_clear_error_when_the_model_file_is_missing():
    with pytest.raises(ModelNotBuiltError):
        EmbeddingModel(model_path=pathlib.Path("/nonexistent/path/model.onnx"))


def test_embed_returns_one_vector_per_input_text(model: EmbeddingModel):
    vectors = model.embed(["Netflix", "Spotify", "רמי לוי"])
    assert len(vectors) == 3
    assert all(len(v) == EMBEDDING_DIM for v in vectors)


def test_embed_of_empty_list_returns_empty_list(model: EmbeddingModel):
    assert model.embed([]) == []


def test_embeddings_are_unit_length(model: EmbeddingModel):
    # The ONNX graph's final node is an L2 normalization — every output
    # vector should have (approximately) unit norm, which is what makes
    # cosine similarity well-behaved downstream (src/lib/vector-math.ts).
    (vector,) = model.embed(["some merchant name"])
    norm = math.sqrt(sum(v * v for v in vector))
    assert abs(norm - 1.0) < 1e-4


def test_embedding_is_deterministic(model: EmbeddingModel):
    (a,) = model.embed(["Netflix"])
    (b,) = model.embed(["Netflix"])
    assert a == b


def test_similar_strings_are_more_similar_than_unrelated_ones(model: EmbeddingModel):
    def cosine(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(y * y for y in b))
        return dot / (norm_a * norm_b)

    netflix, netflix_com, spotify = model.embed(["Netflix", "Netflix.com", "Spotify Premium"])
    assert cosine(netflix, netflix_com) > cosine(netflix, spotify)
