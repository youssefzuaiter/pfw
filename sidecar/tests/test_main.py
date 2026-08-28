from fastapi.testclient import TestClient

from app.constants import EMBEDDING_DIM, MODEL_VERSION
from app.main import MAX_BATCH_SIZE, MAX_TEXT_LENGTH, app

client = TestClient(app)


def test_health_reports_ok_with_model_metadata():
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["dimensions"] == EMBEDDING_DIM
    assert body["model_version"] == MODEL_VERSION


def test_embed_returns_vectors_of_the_right_shape():
    response = client.post("/embed", json={"texts": ["Netflix", "רמי לוי"]})
    assert response.status_code == 200
    body = response.json()
    assert len(body["embeddings"]) == 2
    assert all(len(v) == EMBEDDING_DIM for v in body["embeddings"])
    assert body["dimensions"] == EMBEDDING_DIM


def test_embed_rejects_an_empty_batch():
    response = client.post("/embed", json={"texts": []})
    assert response.status_code == 422


def test_embed_rejects_a_batch_over_the_size_limit():
    response = client.post("/embed", json={"texts": ["x"] * (MAX_BATCH_SIZE + 1)})
    assert response.status_code == 422


def test_embed_rejects_a_text_over_the_length_limit():
    response = client.post("/embed", json={"texts": ["a" * (MAX_TEXT_LENGTH + 1)]})
    assert response.status_code == 422


def test_embed_rejects_a_malformed_request_body():
    response = client.post("/embed", json={"texts": "not a list"})
    assert response.status_code == 422


def test_embed_handles_hebrew_text_end_to_end():
    response = client.post("/embed", json={"texts": ["שופרסל דיל", "נטפליקס"]})
    assert response.status_code == 200
    assert len(response.json()["embeddings"]) == 2
