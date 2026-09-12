"""
HTTP-level coverage for the sidecar's real, deployed surface: the two
routes in app/main.py (/health, /embed) and nothing else -- this service
has no authentication and no database, so there is nothing else to test
at this layer (see AGENTS.md and this sidecar's own README for why).

test_main.py already covers the documented happy paths and the
request-schema rejections (empty batch, over-limit batch, over-length
text, malformed body, Hebrew text). This file adds what wasn't covered
there: exact boundary values (not just one-past-the-limit), HTTP method/
route errors, the documented "no CORS" trust boundary, graceful
degradation when the model isn't loaded, and a real edge case in the
feature-extraction/ONNX pipeline (an all-whitespace text embeds to an
all-zero vector, not a crash -- see feature_extraction.py's L1-norm
guard and this file's own test below, which verified the real behavior
by hand before writing the assertion).

Uses a real httpx.AsyncClient talking to the ASGI app directly
(httpx.ASGITransport), not FastAPI's TestClient wrapper -- the currently
installed Starlette (1.6.0) deprecates TestClient's own httpx usage in
favor of a separate `httpx2` package neither this file nor the rest of
this test suite depends on, so exercising httpx directly here sidesteps
that deprecation path entirely rather than adding an unfamiliar,
unverified dependency for a project that only asked for "pytest and
httpx".
"""

import httpx
import pytest

from app.constants import EMBEDDING_DIM, MODEL_VERSION
from app.embedding_model import ModelNotBuiltError
from app.main import MAX_BATCH_SIZE, MAX_TEXT_LENGTH, app


@pytest.fixture
async def async_client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sidecar.test") as client:
        yield client


# --- Boundary values, not just one-past-the-limit -------------------


@pytest.mark.anyio
async def test_embed_accepts_a_batch_of_exactly_the_max_size(async_client: httpx.AsyncClient):
    response = await async_client.post("/embed", json={"texts": ["merchant"] * MAX_BATCH_SIZE})
    assert response.status_code == 200
    assert len(response.json()["embeddings"]) == MAX_BATCH_SIZE


@pytest.mark.anyio
async def test_embed_accepts_a_text_of_exactly_the_max_length(async_client: httpx.AsyncClient):
    response = await async_client.post("/embed", json={"texts": ["a" * MAX_TEXT_LENGTH]})
    assert response.status_code == 200
    assert len(response.json()["embeddings"]) == 1


# --- Method / route errors -------------------------------------------


@pytest.mark.anyio
async def test_embed_rejects_get(async_client: httpx.AsyncClient):
    response = await async_client.get("/embed")
    assert response.status_code == 405


@pytest.mark.anyio
async def test_health_rejects_post(async_client: httpx.AsyncClient):
    response = await async_client.post("/health")
    assert response.status_code == 405


@pytest.mark.anyio
async def test_unknown_route_is_a_404(async_client: httpx.AsyncClient):
    response = await async_client.get("/nonexistent")
    assert response.status_code == 404


# --- The documented "no CORS" trust boundary --------------------------


@pytest.mark.anyio
async def test_no_cors_headers_are_ever_returned(async_client: httpx.AsyncClient):
    # main.py's own module docstring: "No CORS middleware is configured
    # here on purpose ... a browser has no way to reach this service
    # directly." A cross-origin-shaped request (a real browser preflight
    # shape) must come back with no Access-Control-* headers at all --
    # anything else would silently reopen the exact hole this design
    # relies on staying closed.
    response = await async_client.options(
        "/embed",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in response.headers
    assert "access-control-allow-methods" not in response.headers

    response = await async_client.post(
        "/embed",
        json={"texts": ["Netflix"]},
        headers={"Origin": "https://evil.example.com"},
    )
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


# --- Malformed input the existing suite doesn't cover ------------------


@pytest.mark.anyio
async def test_embed_rejects_non_string_entries(async_client: httpx.AsyncClient):
    response = await async_client.post("/embed", json={"texts": ["Netflix", 42]})
    assert response.status_code == 422


@pytest.mark.anyio
async def test_embed_rejects_a_missing_texts_field(async_client: httpx.AsyncClient):
    response = await async_client.post("/embed", json={})
    assert response.status_code == 422


@pytest.mark.anyio
async def test_embed_rejects_invalid_json(async_client: httpx.AsyncClient):
    response = await async_client.post(
        "/embed", content=b"{not valid json", headers={"content-type": "application/json"}
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_embed_client_cannot_override_dimensions_or_model_version(async_client: httpx.AsyncClient):
    # EmbedRequest only ever declares a `texts` field -- extra client-
    # supplied keys must be ignored, not silently accepted and echoed
    # back as if the server had computed them.
    response = await async_client.post(
        "/embed",
        json={"texts": ["Netflix"], "dimensions": 9999, "model_version": "not-real"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["dimensions"] == EMBEDDING_DIM
    assert body["model_version"] == MODEL_VERSION


# --- A real, hand-verified edge case in the feature-extraction/ONNX pipeline --


@pytest.mark.anyio
async def test_embed_of_whitespace_only_text_returns_a_zero_vector_not_a_crash(async_client: httpx.AsyncClient):
    # feature_extraction.extract_features's L1-norm guard (`if total >
    # 0`) leaves an all-whitespace text as an all-zero feature vector;
    # verified separately, by hand, that ONNX Runtime's LpNormalization
    # node then leaves a zero-norm vector as zero rather than dividing
    # by zero -- this pins that real, observed behavior against a
    # regression (a future model/feature-extraction change producing a
    # NaN here would silently corrupt every downstream cosine-similarity
    # comparison, not raise an error).
    response = await async_client.post("/embed", json={"texts": ["   ", ""]})
    assert response.status_code == 200
    for vector in response.json()["embeddings"]:
        assert len(vector) == EMBEDDING_DIM
        assert all(value == 0.0 for value in vector)


# --- Graceful degradation when the model isn't loaded -------------------


def test_health_reports_503_when_the_model_is_not_built(monkeypatch: pytest.MonkeyPatch):
    def raise_not_built():
        raise ModelNotBuiltError("model not built")

    # Patches the name as imported into app.main's own namespace, not
    # app.embedding_model's -- that's the binding the route handlers
    # actually call, and monkeypatch restores it automatically after
    # this test, so the real (already-built-by-conftest) model stays
    # available to every other test.
    monkeypatch.setattr("app.main.get_embedding_model", raise_not_built)

    from fastapi.testclient import TestClient

    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 503
    assert "not built" in response.json()["detail"]


def test_embed_reports_503_when_the_model_is_not_built(monkeypatch: pytest.MonkeyPatch):
    def raise_not_built():
        raise ModelNotBuiltError("model not built")

    monkeypatch.setattr("app.main.get_embedding_model", raise_not_built)

    from fastapi.testclient import TestClient

    client = TestClient(app)
    response = client.post("/embed", json={"texts": ["Netflix"]})
    assert response.status_code == 503
    assert "not built" in response.json()["detail"]
