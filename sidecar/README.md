# PFW Merchant Embedding Sidecar

A small FastAPI service that turns merchant-name strings into 384-dimension
embeddings, served via ONNX Runtime (no PyTorch at request time). Used by
Tier 3 of the categorization cascade (`src/lib/categorization/tier3-knn.ts`,
called through `src/server/embeddings/sidecar-client.ts`).

**The shipped model is a random-projection placeholder, not a trained
one** — see `app/build_model.py`'s module docstring for the full
rationale (a real multilingual sentence-embedding model is a
multi-hundred-MB download plus a PyTorch/transformers/optimum toolchain
just to run an export script once; disproportionate for what this phase
needs, which is the interface and the 384-dim/cosine-similarity
contract). Swapping in a real trained model later only touches
`build_model.py` — the FastAPI interface and the Node client stay the
same.

## Setup

```bash
cd sidecar
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m app.build_model   # produces model/embedding_model.onnx (gitignored)
```

## Run

```bash
source .venv/bin/activate
uvicorn app.main:app --port 8001
```

## Test

```bash
source .venv/bin/activate
python -m pytest -v
```

To also run the Node-side live integration test against this service:

```bash
EMBEDDING_SIDECAR_URL=http://localhost:8001 npm run test:integration
```
(from the repo root, with the sidecar running)

## Endpoints

- `GET /health` — `{ status, model_version, dimensions }`
- `POST /embed` — `{ texts: string[] }` (max 256 items, 500 chars each) →
  `{ embeddings: number[][], dimensions: 384, model_version }`

## Trust boundary

Localhost-only. No CORS middleware is configured — a browser cannot reach
this service directly. Only the Next.js server (via `EMBEDDING_SIDECAR_URL`)
is expected to call it. See `docs/SECURITY.md`.
