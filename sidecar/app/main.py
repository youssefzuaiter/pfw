"""
FastAPI ONNX sidecar for merchant-name embeddings (384 dimensions).

Trust boundary: localhost-only, called by the Next.js server only (see
docs/SECURITY.md's trust-boundary diagram and
src/server/embeddings/sidecar-client.ts on the Node side). No CORS
middleware is configured here on purpose — a browser has no way to reach
this service directly (no CORS headers means the browser's same-origin
policy blocks any cross-origin fetch attempt outright), and it isn't
meant to be reachable from anywhere but the app server's own network.

Run: uvicorn app.main:app --port 8001   (from the sidecar/ directory,
after `python -m app.build_model` has produced model/embedding_model.onnx)
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .constants import EMBEDDING_DIM, MODEL_VERSION
from .embedding_model import ModelNotBuiltError, get_embedding_model

MAX_BATCH_SIZE = 256
MAX_TEXT_LENGTH = 500

app = FastAPI(title="PFW Merchant Embedding Sidecar", version=MODEL_VERSION)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=MAX_BATCH_SIZE)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dimensions: int = EMBEDDING_DIM
    model_version: str = MODEL_VERSION


class HealthResponse(BaseModel):
    status: str
    model_version: str
    dimensions: int


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        get_embedding_model()
    except ModelNotBuiltError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return HealthResponse(status="ok", model_version=MODEL_VERSION, dimensions=EMBEDDING_DIM)


@app.post("/embed", response_model=EmbedResponse)
def embed(request: EmbedRequest) -> EmbedResponse:
    for text in request.texts:
        if len(text) > MAX_TEXT_LENGTH:
            raise HTTPException(status_code=422, detail=f"Text exceeds {MAX_TEXT_LENGTH} characters")

    try:
        model = get_embedding_model()
    except ModelNotBuiltError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    vectors = model.embed(request.texts)
    return EmbedResponse(embeddings=vectors)
