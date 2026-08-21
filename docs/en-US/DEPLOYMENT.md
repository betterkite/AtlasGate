# Deployment

> Version baseline: **0.4.0** (tested Node 92 / Python 19; zero npm runtime dependencies). Defaults to listening on `http://127.0.0.1:4310`, console `admin / atlasgate-admin`, gateway key `atlasgate-dev-key` (only auto-seeded in dev mode).

## Local process

Requires Node.js 24+ (with `node:sqlite`) and Python 3.11+:

```bash
python3 -m pip install -r python/requirements.txt --target python/vendor   # optional: PDF parsing (pypdf)
npm start
```

The project has no npm runtime dependencies, so `npm install` is not needed. The service listens on `http://127.0.0.1:4310` by default. Common environment overrides:

```bash
ATLASGATE_PYTHON=python3 npm start        # explicitly specify python when there is no python alias
ATLASGATE_PORT=4311 npm start             # change the port (when 4310 is occupied)
ATLASGATE_DEV_MODE=false ATLASGATE_ADMIN_PASSWORD='a-strong-password' npm start   # turn off dev defaults
```

Verify immediately after startup:

```bash
curl http://127.0.0.1:4310/health                     # {"status":"ok","version":"0.4.0",...}
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

## Environment variable cheat sheet

| Variable | Default | Description |
|---|---|---|
| `ATLASGATE_HOST` / `ATLASGATE_PORT` | `127.0.0.1` / `4310` | Listen address and port; must be `0.0.0.0` in a container |
| `ATLASGATE_DB_PATH` | `data/atlasgate.db` | SQLite file path; `/data/atlasgate.db` in Docker |
| `ATLASGATE_DEV_MODE` | `true` | When `false`, the default admin password and dev gateway key are disabled; `ATLASGATE_ADMIN_USERNAME/PASSWORD` must be provided |
| `ATLASGATE_ADMIN_USERNAME/PASSWORD` | `admin` / `atlasgate-admin` | Console administrator (must change in production) |
| `ATLASGATE_DEV_KEY` | `atlasgate-dev-key` | Dev gateway key; change in shared environments |
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | `local` (pure lexical) / `hybrid` (lexical + local dense vectors RRF, default) / `qdrant` (dense only) |
| `ATLASGATE_EMBEDDING_BASE_URL` | empty | OpenAI-compatible `/v1/embeddings`; when empty, hybrid auto-degrades to pure lexical |
| `ATLASGATE_EMBEDDING_MODEL` / `_DIMENSIONS` | `bge-small-zh-v1.5` / `512` | Local ONNX embedding (`python/atlasgate_agent/embedding_worker.py`) |
| `ATLASGATE_QDRANT_URL` / `_API_KEY` | empty | Only needed for `qdrant` mode |
| `ATLASGATE_QUERY_REWRITE_ENABLED` / `QUERY_SEDIMENT_ENABLED` | `true` / `true` | Zero-evidence query rewriting / automatic Q&A sediment (ADR-015) switches |
| `ATLASGATE_WIKI_SYNC_DIR` | `knowledge` | md mirror directory; suggest `/data/knowledge` in a container to persist |

Full list in [CONFIGURATION.md](CONFIGURATION.md).

## Docker Compose

```bash
cp .env.example .env
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:4310/health
```

The image uses Node 24 Alpine, Python 3, a non-root user (`atlasgate`), and a `/data` persistent directory. Do not run `docker compose down -v` before confirming you want to delete data.

Day-to-day operations:

```bash
docker compose logs -f atlasgate          # service logs (startup/migration/mirror sync/queue failures)
docker compose restart atlasgate          # restart
docker compose exec atlasgate sh          # shell into the container to debug (data in /data/atlasgate.db)
```

> Note: the image defaults to `ATLASGATE_DEV_MODE=false`; `cp .env.example .env` brings back the dev defaults from `.env` (dev mode + default admin password). For production, edit `.env` to set `ATLASGATE_DEV_MODE=false`, configure `ATLASGATE_ADMIN_USERNAME/PASSWORD` and your own gateway key, and keep `.env` out of the repository.

## Persistence

- The only thing that must be persisted is **SQLite**: the Compose volume `atlasgate-data` mounts to `/data`, and the database lives at `/data/atlasgate.db` (WAL mode).
- **The md mirror is not persisted by default**: `ATLASGATE_WIKI_SYNC_DIR` defaults to a path relative to the project root, `/app/knowledge` in the container (writable but lost on container rebuild). To persist the mirror in a container, set `ATLASGATE_WIKI_SYNC_DIR=/data/knowledge`.
- Backup = consistent SQLite snapshot (checkpoint before copying, see [CONSOLE_OPS.md](CONSOLE_OPS.md) Section 2); knowledge pages, vectors, audit, keys, Skills, and Memory all live in the database.
- With `qdrant` mode enabled, the `qdrant-data` volume holds the vector collections and must be snapshotted together with SQLite.

## Qdrant

After configuring the retrieval and Embedding variables in `.env`:

```bash
docker compose --profile semantic up -d --build
```

Requirements: `ATLASGATE_RETRIEVAL_MODE=qdrant`, `ATLASGATE_QDRANT_URL=http://qdrant:6333`, `ATLASGATE_EMBEDDING_BASE_URL` (Qdrant itself does not provide Embedding; `ATLASGATE_EMBEDDING_BASE_URL` must be reachable from inside the AtlasGate container). `hybrid` mode does not need Qdrant; local dense vectors live in SQLite (the `semantic_vectors` table).

## Production topology

Put AtlasGate behind an authenticated reverse proxy in a trusted private network, with the proxy terminating TLS, restricting admin routes, and injecting keys. SQLite can only be a single-writer node. Multi-node high availability needs a new control-plane database, distributed rate limiting, and a persisted index queue — out of scope for now.

## Rollback and backup

1. Stop writes or enter a maintenance window.
2. Back up the database with a consistent SQLite snapshot; never copy half-written files during WAL writes.
3. Keep the image version and environment configuration together with the backup.
4. Roll back the image, restore a compatible database, and check health and knowledge-version reads after startup.

```bash
# Hot backup (checkpoint first, then copy)
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/atlasgate.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db
# Under Docker: docker compose exec atlasgate sh -c 'cp /data/atlasgate.db /data/atlasgate-$(date +%F-%H%M).db'
```

The project does not provide destructive automatic schema downgrades.

## Common deployment failures

| Symptom | Fix |
| --- | --- |
| Container exits immediately | Usually `ATLASGATE_DEV_MODE=false` without `ATLASGATE_ADMIN_PASSWORD` (AuthService errors at startup); `docker compose logs atlasgate` to see, edit `.env`, then `docker compose up -d` |
| Port conflict | Change `ATLASGATE_PUBLISHED_PORT` (Compose maps 4310 by default) or the local port |
| `health` never passes | `docker compose ps` for health state; `docker compose logs` for startup/migration/mirror sync errors |
| Changed `.env` has no effect | `docker compose up -d` rebuilds the container (`env_file` is read at container creation) |
