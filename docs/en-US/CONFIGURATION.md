# Configuration

AtlasGate reads environment variables. Never commit `.env` or credentials.

| Variable | Default | Meaning |
|---|---|---|
| `ATLASGATE_HOST` | `127.0.0.1` | Listen address |
| `ATLASGATE_PORT` | `4310` | HTTP port |
| `ATLASGATE_DB_PATH` | `data/atlasgate.db` | SQLite path |
| `ATLASGATE_DEV_MODE` | `true` | Seeds local development data |
| `ATLASGATE_DEV_KEY` | `atlasgate-dev-key` | Development gateway key |
| `ATLASGATE_ADMIN_USERNAME` | `admin` in development | Console username |
| `ATLASGATE_ADMIN_PASSWORD` | `atlasgate-admin` in development | Console password |
| `ATLASGATE_PYTHON` | auto-detect | Python executable override |
| `ATLASGATE_PYTHON_TIMEOUT_MS` | `15000` | Agent preparation timeout |
| `ATLASGATE_PYTHON_WORKER_POOL_SIZE` | `2` | Persistent worker count |
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | `local`, `hybrid`, or `qdrant` |
| `ATLASGATE_EMBEDDING_BASE_URL` | empty | OpenAI-compatible embeddings endpoint |
| `ATLASGATE_QDRANT_URL` | empty | Qdrant HTTP origin |
| `ATLASGATE_WIKI_INGEST_MODE` | `review` | `review` or `auto` |
| `ATLASGATE_WIKI_SYNC_DIR` | `knowledge` | One-way Markdown mirror directory |

The runtime probes `python` and then `python3`. On a shell without a `python` alias, set `ATLASGATE_PYTHON=python3`.

Provider credentials are stored server-side and are never returned. Local feature vectors are not semantic embeddings. Retrieval modes fail clearly when required external services are unavailable.

