# Configuration

AtlasGate reads configuration from environment variables. Docker Compose can copy `.env.example`, and process deployments can set environment variables directly. Never commit `.env` or any credentials.

## Service and storage

| Variable | Default | Meaning |
|---|---|---|
| `ATLASGATE_HOST` | `127.0.0.1` | Listen address; keep it loopback unless there is a trusted reverse proxy |
| `ATLASGATE_PORT` | `4310` | HTTP port |
| `ATLASGATE_DB_PATH` | `data/atlasgate.db` | SQLite file path; usually `/data/atlasgate.db` in Docker |
| `ATLASGATE_DEV_MODE` | `true` | Whether development data is enabled; must be `false` in production |
| `ATLASGATE_DEV_KEY` | `atlasgate-dev-key` | Development gateway key; must be replaced in shared environments |
| `ATLASGATE_ADMIN_USERNAME` | `admin` in development | Console administrator account |
| `ATLASGATE_ADMIN_PASSWORD` | `atlasgate-admin` in development | Console administrator password; use a strong password in production |
| `ATLASGATE_ADMIN_SESSION_TTL_MS` | `28800000` | HttpOnly administrator session lifetime |
| `ATLASGATE_REQUEST_TIMEOUT_MS` | `60000` | Request timeout cap for upstream and vector services |

SQLite uses WAL and foreign keys. The database should live on persistent local or block storage, and backups must account for the WAL state.

## Python Agent worker

| Variable | Default | Meaning |
|---|---|---|
| `ATLASGATE_PYTHON` | auto-detect | Probes `python` first, then `python3`; can be overridden explicitly |
| `ATLASGATE_PYTHON_TIMEOUT_MS` | `15000` | Agent preparation request timeout |
| `ATLASGATE_PYTHON_WORKER_POOL_SIZE` | `2` | Number of resident Python workers |
| `ATLASGATE_PYTHON_WORKER_QUEUE_LIMIT` | `100` | Waiting queue cap; returns 503 when full |
| `ATLASGATE_PYTHON_WORKER_MAX_REQUESTS` | `1000` | Requests handled by one worker before it is recycled |

When the current environment only has `python3`:

```bash
ATLASGATE_PYTHON=python3 npm start
```

## Retrieval and Wiki

| Variable | Default | Meaning |
|---|---|---|
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | Retrieval mode: `local` (lexical-only, legacy default), `hybrid` (lexical + local dense vectors fused by RRF, default), `qdrant` (dense-only, requires Qdrant) |
| `ATLASGATE_EMBEDDING_BASE_URL` | empty | OpenAI-compatible `/v1/embeddings` service address (local ONNX service `python/atlasgate_agent/embedding_worker.py` or another vendor); when empty, `hybrid` degrades to lexical-only |
| `ATLASGATE_EMBEDDING_API_KEY` | empty | Embedding service key |
| `ATLASGATE_EMBEDDING_MODEL` | `bge-small-zh-v1.5` | Embedding model name |
| `ATLASGATE_EMBEDDING_DIMENSIONS` | `512` | Vector dimensions |
| `ATLASGATE_QDRANT_URL` | empty | Qdrant address (only in `qdrant` mode) |
| `ATLASGATE_QDRANT_API_KEY` | empty | Qdrant key |
| `ATLASGATE_QDRANT_COLLECTION_PREFIX` | `atlasgate` | Qdrant collection name prefix |
| `ATLASGATE_QUERY_REWRITE_ENABLED` | `true` | Whether zero-evidence questions may be rewritten and retried once (requires a real LLM Provider; ineffective under mock) |
| `ATLASGATE_QUERY_SEDIMENT_ENABLED` | `true` | Whether Q&A may be automatically sedimented into the Wiki (similar questions ≥3 times plus quality rules, or an explicit `save_to_wiki`/`sediment` request) |
| `ATLASGATE_WIKI_INGEST_MODE` | `review` | Default ingest mode per base: `review` (Changes wait for human review before merging) or `auto` (auto-merge after compile/sediment) |
| `ATLASGATE_WIKI_MAX_PAGES_PER_SOURCE` | `20` | Maximum pages compiled from a single source |
| `ATLASGATE_WIKI_INGEST_POLL_MS` | `2000` | Ingestion queue polling interval |
| `ATLASGATE_WIKI_INGEST_CONCURRENCY` | `1` | Concurrent ingestion count |
| `ATLASGATE_WIKI_SYNC_DIR` | `knowledge` | One-way Markdown mirror directory (relative to the project root or an absolute path); set to an empty string to disable the mirror |
| `ATLASGATE_WIKI_PURPOSE_PATH` | `purpose.md` | purpose system page path |
| `ATLASGATE_WIKI_SCHEMA_PATH` | `schema.md` | schema system page path |
| `ATLASGATE_WIKI_INDEX_PATH` | `index.md` | index system page path (maintained by the compiler) |
| `ATLASGATE_WIKI_LOG_PATH` | `log.md` | log system page path (maintained by the compiler) |
| `ATLASGATE_WIKI_OVERVIEW_PATH` | `overview.md` | overview system page path (maintained by the compiler) |

Retrieval notes:

- `hybrid` (default): lexical bigram page-level retrieval and local dense vectors (`semantic_vectors` table, cosine similarity inside SQLite) are fused by **RRF**; without `ATLASGATE_EMBEDDING_BASE_URL` it degrades to lexical-only without error.
- `qdrant`: dense-only retrieval; requires both `ATLASGATE_QDRANT_URL` and `ATLASGATE_EMBEDDING_BASE_URL`.
- Embeddings can be fully offline: the local ONNX service `python/atlasgate_agent/embedding_worker.py` (bge-small-zh-v1.5, 512 dims, sole extra dependency `onnxruntime`), or any OpenAI-compatible `/v1/embeddings`. DeepSeek offers no official embedding model.
- Knowledge-base page-level feature hashing vectors are offline features and must not be labeled as semantic embeddings.
- System pages (`index.md`/`log.md`/`purpose.md`/`schema.md`/`overview.md`) and degraded pages (`atlasgate-degraded` marker) do not participate in retrieval by default.

## Provider

Providers support `openai`, `anthropic`, and the built-in `mock` kind. When creating a Provider you can set `name`, `kind`, `base_url`, `models`, capabilities, ratings, `api_key`, and `balance_endpoint`. Provider keys are stored server-side only; the API never returns key contents.

## Quick verification

The default development configuration (zero npm runtime dependencies) starts directly, console at http://127.0.0.1:4310:

```bash
npm start
# Health check: confirms version, Python pool, and retrieval status
curl http://127.0.0.1:4310/health
# Log in with default credentials to verify the management console
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
```

Enable dense retrieval (local ONNX embedding + hybrid):

```bash
python3 python/atlasgate_agent/embedding_worker.py \
  --model /path/to/bge-small-zh-v1.5/onnx/model.onnx \
  --tokenizer /path/to/bge-small-zh-v1.5 \
  --host 127.0.0.1 --port 8031
ATLASGATE_EMBEDDING_BASE_URL=http://127.0.0.1:8031/v1 npm start
# The health check should show retrieval.enabled=true
curl http://127.0.0.1:4310/health
```
