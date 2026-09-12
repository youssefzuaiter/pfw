"""
Concurrency/isolation coverage for the shared model singleton.

`get_embedding_model()` is `lru_cache(maxsize=1)`'d (app/embedding_model.py)
-- every request in this process shares the exact same `EmbeddingModel`
instance and its one `onnxruntime.InferenceSession`. main.py's `/embed`
handler is a plain `def`, not `async def`, so FastAPI/Starlette dispatch
each request onto its own worker thread -- real concurrent HTTP traffic
genuinely calls into that one shared session from multiple threads at
once, not just conceptually. This file proves that's actually safe: every
concurrent request gets back the correct vectors for its OWN input texts,
never another request's, and nothing raises or corrupts output under
real parallel load.
"""

import asyncio
import math

import httpx
import pytest

from app.constants import EMBEDDING_DIM
from app.main import app


@pytest.fixture
async def async_client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sidecar.test") as client:
        yield client


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    return dot / (norm_a * norm_b)


@pytest.mark.anyio
async def test_concurrent_requests_each_get_back_their_own_correct_vectors(async_client: httpx.AsyncClient):
    merchants = [f"merchant-{i}" for i in range(40)]

    async def embed_one(text: str) -> list[float]:
        response = await async_client.post("/embed", json={"texts": [text]})
        assert response.status_code == 200
        (vector,) = response.json()["embeddings"]
        return vector

    # Genuinely concurrent, not sequential-await-in-a-loop -- every
    # request is in flight at the same time, exercising the shared
    # InferenceSession from many threads simultaneously.
    concurrent_vectors = await asyncio.gather(*(embed_one(text) for text in merchants))

    # Ground truth computed sequentially (one request at a time), on the
    # same running process/model -- if concurrency ever corrupted a
    # result, this comparison is what would catch it, not just "did it
    # not crash".
    sequential_vectors = [await embed_one(text) for text in merchants]

    for concurrent_vector, sequential_vector in zip(concurrent_vectors, sequential_vectors):
        assert concurrent_vector == sequential_vector
        assert len(concurrent_vector) == EMBEDDING_DIM


@pytest.mark.anyio
async def test_concurrent_batches_do_not_cross_contaminate(async_client: httpx.AsyncClient):
    # Two distinct multi-item batches in flight at once; each batch's
    # response must reflect exactly its own texts, in its own order --
    # a thread-safety bug in the shared session could plausibly manifest
    # as one request's output leaking into another's.
    batch_a = ["Netflix", "Netflix.com", "Netflix Premium"]
    batch_b = ["Spotify", "Spotify Premium", "Spotify Family"]

    async def embed_batch(texts: list[str]) -> list[list[float]]:
        response = await async_client.post("/embed", json={"texts": texts})
        assert response.status_code == 200
        return response.json()["embeddings"]

    results_a, results_b = await asyncio.gather(embed_batch(batch_a), embed_batch(batch_b))

    assert len(results_a) == len(batch_a)
    assert len(results_b) == len(batch_b)

    # Within-batch ordering held under concurrency: "Netflix" and
    # "Netflix.com" (batch A) must still be closer to each other than
    # either is to anything in batch B's genuinely unrelated merchants.
    netflix, netflix_com = results_a[0], results_a[1]
    spotify = results_b[0]
    assert cosine(netflix, netflix_com) > cosine(netflix, spotify)
