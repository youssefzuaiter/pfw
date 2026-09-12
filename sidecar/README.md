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

### Async anomaly-detection tasks (Celery + Redis)

The `/tasks/anomaly-detect` (enqueue) and `/tasks/{task_id}` (poll)
routes offload the anomaly-detection ONNX inference
(`public/models/spending_anomaly.onnx`, AGENTS.md §3ll) onto a separate
Celery worker process instead of running it inline in the request —
`app/celery_app.py` / `app/tasks.py`. Both routes need a real worker
running against the same Redis broker to do anything but sit queued.

```bash
# from the repo root
docker compose up -d redis   # starts pfw_local_redis on localhost:6379

# from sidecar/, in a second terminal, with the venv active
celery -A app.celery_app:celery_app worker --loglevel=info --concurrency=2
```

`CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND` default to
`redis://localhost:6379/0` and `/1` respectively (two DB indices on the
same local Redis, kept separate purely for `redis-cli`-debugging
clarity) — override both if pointing at a different Redis. See
`render.yaml` at the repo root for how these are populated in production
(a managed Redis `keyvalue` service, both vars sharing one
`connectionString` there — see that file's own comment for why that's
fine).

## Test

```bash
source .venv/bin/activate
python -m pytest -v
```

`tests/conftest.py`'s `ensure_model_is_built` fixture builds
`model/embedding_model.onnx` automatically if it's missing (e.g. a fresh
checkout, before you've run `python -m app.build_model` by hand) — the
explicit `build_model` step above is still the faster path locally, but
skipping it isn't a foot-gun.

`.github/workflows/ci.yml`'s `sidecar-tests` job runs this suite (with
coverage) on every push/PR — it's no longer manual/local-only. Run it
with coverage locally the same way CI does:

```bash
python -m pytest -v --cov=app --cov-report=term-missing
```

`tests/test_celery_redis_integration.py` needs a real Redis reachable at
`CELERY_BROKER_URL` (`docker compose up -d redis` from the repo root) —
it spawns its own real `celery worker` subprocess and skips itself
automatically (not an error) if Redis isn't reachable, the same
environment-gated-skip convention this app's Node side already uses for
its own live-integration tests. Every other test file needs no broker at
all (Celery's `task_always_eager` mode, `tests/conftest.py`'s
`celery_eager_mode` fixture).

To also run the Node-side live integration test against this service:

```bash
EMBEDDING_SIDECAR_URL=http://localhost:8001 npm run test:integration
```
(from the repo root, with the sidecar running)

## Endpoints

- `GET /health` — `{ status, model_version, dimensions }`
- `POST /embed` — `{ texts: string[] }` (max 256 items, 500 chars each) →
  `{ embeddings: number[][], dimensions: 384, model_version }`
- `POST /tasks/anomaly-detect` — `{ transactions: [...], window_end_date_key }`
  → `202 { task_id, status: "queued" }`. Enqueues onto Celery; does not
  run inference inline.
- `GET /tasks/{task_id}` — `{ task_id, status, result }`. Poll after
  enqueueing. `status` is a raw Celery state (`PENDING`/`STARTED`/
  `SUCCESS`/`FAILURE`/...) — a genuinely unknown `task_id` reads
  identically to `PENDING`, a real Celery limitation (see `main.py`'s own
  doc comment on this route), not a bug in this service.

## Trust boundary

Localhost-only. No CORS middleware is configured — a browser cannot reach
this service directly. Only the Next.js server (via `EMBEDDING_SIDECAR_URL`)
is expected to call it. See `docs/SECURITY.md`.
