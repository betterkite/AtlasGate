# Console & Operations

> Version baseline: **0.4.0** (tested Node 92 / Python 19; zero npm runtime dependencies). This document covers day-to-day operations beyond console usage: backups, upgrades, logs, and common troubleshooting, tied to views 01 (Overview) / 07 (Audit evidence) and the `data/` directory. A tour of the 8 console views is in [USAGE.md](USAGE.md).

## 1. Where the data lives

| Path | Content | Committed to git |
| --- | --- | --- |
| `data/atlasgate.db` (+ wal/shm) | Main database (SQLite WAL): gateway config, **knowledge base pages** (versioned), audit ledger, keys, Skills, Memory, `semantic_vectors` dense vectors, `wiki_query_hits` citation heat | No (.gitignore) |
| `data/backups/` | Automatic backups before migrations such as the Wiki model upgrade | No |
| `data/server.log` | Service log (start with `nohup node src/server.js > data/server.log 2>&1`; under Docker see `docker compose logs`) | No |
| `knowledge/` | Per-KB md mirror (openable in Obsidian, one-way read-only, deletions tracked by `.atlasgate-manifest.json`) | No (default) |
| `python/vendor/` | pip-installed runtime dependencies (`pypdf` etc.; `onnxruntime` is an optional embedding dependency) | No |
| `docs/` | Documentation and test reports | Yes |

## 2. Backup and restore

```bash
# Cold backup (recommended)
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db

# Hot backup (WAL mode: checkpoint first, then copy, to avoid copying half-written pages)
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/atlasgate.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db
```

Restore: stop the service -> replace `data/atlasgate.db` with the backup file (also delete `-wal`/`-shm` so an old WAL cannot overwrite the restored DB) -> start:

```bash
# Assume the backup is data/backups/atlasgate-2026-01-01-0000.db
pkill -f "node src/server.js" || true   # 1) stop any running instance
cp data/backups/atlasgate-2026-01-01-0000.db data/atlasgate.db   # 2) restore the DB
rm -f data/atlasgate.db-wal data/atlasgate.db-shm                # 3) delete old WAL/shm to avoid overwrite
npm start                                                         # 4) restart
curl http://127.0.0.1:4310/health                                 # 5) confirm database:"ready"
```

## 3. Upgrades

1. Back up the database (see above).
2. `git pull` to update the code.
3. Restart. Migrations are **append-only and idempotent**: on startup they `ALTER TABLE` to add columns, seed system pages (legacy KBs get a pending Change), and refresh the md mirror.
4. Check the startup log for: `Wiki model: staged …` / `Wiki md mirror: synced …`.

```bash
cd /home/zengcccc/projects/AtlasGate   # replace with your project path
git pull
npm start
# The startup log should show:
#   AtlasGate is running at http://127.0.0.1:4310
#   Wiki model: staged N system page change(s) for legacy knowledge bases (only with legacy KBs)
#   Wiki md mirror: synced N knowledge base(s), M file(s) -> knowledge/
```

## 4. Key and security operations

- Client keys: issue/revoke/restore/remove all happen in "Model gateway"; removal keeps the audit history.
- Administrator: configured via `ATLASGATE_ADMIN_USERNAME/PASSWORD`; the console is only suitable on the `127.0.0.1` loopback (public deployment needs TLS/identity first, see [SECURITY.md](SECURITY.md)).
- Upstream keys: stored in the Provider/credential tables; the console only returns `has_api_key`; production should use an external Secret Manager.
- The dev gateway key `atlasgate-dev-key` is only auto-seeded when `ATLASGATE_DEV_MODE=true`; production must set `ATLASGATE_DEV_MODE=false` and issue its own client keys.

```bash
# Change the admin password (new password at least 12 characters; all other sessions are invalidated)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"current_password":"atlasgate-admin","new_password":"a-strong-new-password-2026"}'
```

## 5. Common troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| **Startup `already in use`** | Port occupied: `lsof -i:4310` or `ss -tlnp \| grep 4310` -> `kill <pid>`; or `ATLASGATE_PORT=4311 npm start` |
| **Service hangs / pages unreachable** | The old "missing python infinite regeneration" bug is fixed (bounded backoff + pool unhealthy fast-fail). Still stuck: check `data/server.log`; `curl http://127.0.0.1:4310/health` for the `python_pool` state; restart if needed |
| **Agent reports `python_agent_unavailable`** | Python missing/too old: `python3 --version` >=3.11; or `ATLASGATE_PYTHON=python3 npm start`; the pool auto-enters unhealthy and fast-fails (no FD leaks) |
| **Retrieval degrades to pure lexical** | `/health` shows `retrieval.enabled` false: `ATLASGATE_EMBEDDING_BASE_URL` not configured (hybrid auto-degrades, expected); qdrant mode also needs `ATLASGATE_QDRANT_URL`. After configuring, `POST /api/knowledge-bases/:id/semantic-index` rebuilds the index |
| **Balance shows not configured** | Provider has no balance endpoint and is not deepseek; or "Balance" was never clicked; DeepSeek is auto-detected (`/user/balance`) and refreshes |
| **Graph blank / buttons unresponsive** | Hard refresh (Ctrl+F5) to load the new frontend; still broken, check the F12 Console errors |
| **Stuck after import** | This version fixes the python regeneration loop; if it reproduces, paste `data/server.log` |
| **md mirror not updated** | Check that `knowledge/` isn't mis-gitignored (it is supposed to be ignored); sync happens on publish/startup/manual "Sync md" `POST /api/knowledge-bases/:id/sync` |

## 6. Monitoring entry points and view API examples

The "Overview", "Audit evidence", and "Model gateway" views are backed by exactly these APIs; copy-paste to run (login first as in Section 4 or USAGE.md step 0):

```bash
# Health: version, database, python pool (state/queued/rejected/restarts), retrieval (mode/backend/enabled)
curl http://127.0.0.1:4310/health

# Overview (view 01): request/Token curves, estimated cost, success rate, latency, Provider health,
# upstream balance; range=24h|7d|30d
curl -b cookies.txt "http://127.0.0.1:4310/api/overview?range=7d"

# Usage breakdown (by key/model dimensions)
curl -b cookies.txt "http://127.0.0.1:4310/api/usage/breakdown"

# Audit evidence (view 07): recent request ledger (each entry has the calling key, routing decision,
# usage, risk)
curl -b cookies.txt "http://127.0.0.1:4310/api/logs?limit=20"

# Model gateway (view 04): Provider attempt records (attempt trail)
curl -b cookies.txt "http://127.0.0.1:4310/api/provider-attempts?limit=20"

# Client key list
curl -b cookies.txt "http://127.0.0.1:4310/api/keys"
```

- Logs: `data/server.log` (startup/migration/mirror sync/queue failures all land here).

## 7. Related documents

- [DEPLOYMENT.md](DEPLOYMENT.md) (Docker/Compose, persistent volumes)
- [CONFIGURATION.md](CONFIGURATION.md) (all environment variables)
- [SECURITY.md](SECURITY.md) (security boundary and hardening checklist)
- [OPERATIONS.md](OPERATIONS.md) (supplementary day-to-day operations)
- [guides/06-console-and-mcp.md](guides/06-console-and-mcp.md) (the 8 console views step-by-step and MCP calls)
