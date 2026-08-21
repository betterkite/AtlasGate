# Operations

> Version baseline: **0.4.0** (tested Node 92 / Python 19; zero npm runtime dependencies). AtlasGate is a single-node modular monolith. Keep it on loopback or behind a trusted reverse proxy and continuously observe process, database, Python worker, Provider, ingest queue, and index state. The examples below are verified against the default dev config (`npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin); admin requests log in first to save a session. `$KB` is the id returned by KB creation (`POST /api/knowledge-bases`, see the [USAGE.md](USAGE.md) example); the Provider id `prv_30bebf0038914b319047` comes from the dev-database seed — replace it with your real id:

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
```

## Health checks

`GET /health` returns the version (0.4.0), database state, Python worker pool state, and retrieval configuration state. When `python_pool` `queued`/`rejected` keep growing or `restarts` climb, investigate the workers, SQLite reads, and upstream services:

```bash
curl http://127.0.0.1:4310/health | python3 -m json.tool
# Fields to watch:
#   version: "0.4.0"             current version
#   database: "ready"            database writable
#   python_pool.state            ready / unhealthy (unhealthy = worker failed to start, fast-fails without leaks)
#   python_pool.queued/rejected/restarts
#   retrieval.mode/backend/enabled   retrieval mode and whether dense retrieval is really enabled
```

## Overview metrics

The console Overview shows request volume, input/output/total tokens, estimated cost, success rate, latency, Provider health, and upstream balance. Cost is estimated from the current Provider rates, not a bill; the balance timestamp distinguishes fresh values from retained old ones. API form:

```bash
curl -b cookies.txt "http://127.0.0.1:4310/api/overview?range=7d"   # 24h | 7d | 30d
curl -b cookies.txt "http://127.0.0.1:4310/api/usage/breakdown"
```

## Provider failures

1. Check health status, attempt records, and recent balance errors.
2. Disable the failing Provider so it exits new routing.
3. Before deleting a configuration, confirm other Providers remain available.
4. A Provider with attempts in the last 30 seconds cannot be deleted.
5. After deletion, historical usage and attempt evidence must remain.

```bash
# 1) List Providers (health state, credential count) and recent attempt records
curl -b cookies.txt http://127.0.0.1:4310/api/providers
curl -b cookies.txt "http://127.0.0.1:4310/api/provider-attempts?limit=20"

# 2) Single test and balance refresh (DeepSeek auto-uses the official /user/balance;
#    replace prv_... with your Provider id)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/providers/prv_30bebf0038914b319047/test \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/providers/prv_30bebf0038914b319047/balance \
  -H 'content-type: application/json' -d '{}'

# 3) Disable/re-enable: PATCH /api/providers/:id with body {"enabled":false}
```

## Knowledge base failures

Do not edit published database rows or the Markdown mirror directly. Check pending Changes, revision history, and the conflict ledger. Wrong pending edits should be reverted (PATCH/DELETE change); a wrong published edit keeps the original version as evidence, then a correction Change is published as a new version (immutable Master):

```bash
# View pending changes (batch_id, author, conflict flags), the conflict ledger, and version history
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions"

# Revert one pending edit (delete the pending change; for published content publish a correction
# Change, never edit the row)
curl -b cookies.txt -X DELETE "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes/<changeId>"

# Retrieval verification (hybrid by default; without embeddings it auto-degrades to pure lexical
# page retrieval)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"stone slab clue","top_k":5}'
```

## Worker saturation

When the queue keeps piling up, first analyze retrieval and external-service latency, then consider raising the pool size (`ATLASGATE_PYTHON_WORKER_POOL_SIZE`, default 2). Timeouts recycle the corresponding worker; repeated crashes usually indicate an input or parsing defect and should not be masked by infinite retries. When `ATLASGATE_PYTHON_WORKER_QUEUE_LIMIT` (default 100) is full, new requests return 503 — expected backpressure.

```bash
# Observe pool state (queued/rejected/restarts) and Agent run records
curl http://127.0.0.1:4310/health | python3 -m json.tool
curl -b cookies.txt "http://127.0.0.1:4310/api/agents/runs?limit=20"
```

## Ingest queue failures

Ingestion is a persisted queue (`/ingest-queue`): serial per KB, failed items auto-retry up to 2 times, and crash recovery resumes (`recoverRunning`). Output stays pending per batch (shared `batch_id`) in review KBs or auto-merges in auto KBs. Sources are deduped by content SHA256 — identical content returns `skipped:true / reason:duplicate_content`; pass `force:true` to bypass dedup and re-queue when a previous compilation failed and you want to recompile.

```bash
# Queue state (pending -> running -> done/failed) and failure reasons
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=10"

# Force re-ingestion (bypass SHA256 dedup and re-queue)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well.","force":true}'

# Compiler-generated Review queue (deep_research/verify etc.) and Lint reports
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/reviews?status=open"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint-reports?status=open"
```

## Semantic index failures

Check `/api/knowledge-bases/:id/semantic-index` (job state/errors), fix the Embedding, Qdrant, dimension, or credential configuration, then retry. A failed index never modifies the published Master. `hybrid` (default) auto-degrades to pure lexical when `ATLASGATE_EMBEDDING_BASE_URL` is unset; `qdrant` mode with full config uses Qdrant only and does not mix local vectors, but if `ATLASGATE_QDRANT_URL` or the embedding configuration is missing, `/health` reports `retrieval.enabled` false and search falls back to lexical as well — always verify the actual mode via the `/health` `retrieval` field:

```bash
# View index jobs and errors
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index"

# Rebuild the current Master index (first search auto-triggers it when missing)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'

# Verify retrieval mode: mode=hybrid + enabled=true means lexical + local dense vectors RRF fusion is active
curl http://127.0.0.1:4310/health
```

## Backup and capacity

Take consistent SQLite backups (checkpoint with `PRAGMA wal_checkpoint(TRUNCATE)` before copying, see [CONSOLE_OPS.md](CONSOLE_OPS.md) Section 2); with semantic retrieval also consider Qdrant snapshots. Monitor database and WAL size, request p95, queue depth, knowledge chunk count, and the number of Qdrant collections per Master version.
