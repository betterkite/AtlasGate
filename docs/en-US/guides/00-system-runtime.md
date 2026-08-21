# System Runtime and Service Boundaries

> ID: `SYS-001`  
> Status: `implemented` (version 0.4.0, tests Node 92 / Python 19)

## 1. Purpose and boundary

AtlasGate is a modular monolith. The Node.js process hosts the HTTP control plane, the model gateway, the knowledge version service, and the Agent adapter; the Python worker hosts Agent retrieval preparation, local extractive answers, two-step compilation prompt construction, and Lint (`python/atlasgate_agent/`). SQLite is the control-plane source of truth (default `data/atlasgate.db`).

Default development configuration: port **4310** (`ATLASGATE_PORT`), console `admin / atlasgate-admin` (`ATLASGATE_ADMIN_USERNAME/PASSWORD`), gateway key `atlasgate-dev-key` (`ATLASGATE_DEV_KEY`, Bearer header). The project has **zero npm runtime dependencies**; `package.json` only declares scripts.

This feature does not provide multi-node high availability, distributed transactions, or public administrator identity.

## 2. Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| Startup | `src/server.js` | `main()` | Creates the app and listens on the port |
| Router | `src/app.js` | `createApp()` | Registers APIs, auth, and error handling |
| Config | `src/config.js` | `loadConfig()` | Loads environment variables and defaults |
| Storage | `src/db.js` | `openDatabase()` | Initializes the SQLite schema and migrations |
| Python bridge | `src/services/python-agent.js` | `PythonAgentBridge` | Manages the worker pool, timeouts, and restarts |

## 3. Runtime flow

```text
server.js -> config/db/services -> createApp -> HTTP router
                                      |-> Node service
                                      |-> PythonAgentBridge -> JSON Lines worker
```

## 4. Implementation principles

Services are split by domain but share one SQLite connection and explicit service interfaces. The database uses WAL and foreign keys. The Python worker uses a bounded queue (`ATLASGATE_PYTHON_WORKER_QUEUE_LIMIT`) so Python is not restarted per request; workers are rebuilt after crashes, and repeated spawn failures mark the pool unhealthy and return 503 (a full queue also returns 503). `/health` returns `version: "0.4.0"`, the Python pool status, and the retrieval backend status (`semanticIndex.status()`).

## 5. Invariants and failure behavior

- API errors are returned with stable HTTP statuses and error codes.
- When the Python worker is unavailable, Agent requests fail fast (503 `python_agent_unavailable`) instead of respawning forever.
- A failed database transaction cannot advance the Master version.
- `/health` describes process, database, and worker state; it does not prove every upstream Provider is healthy.

## 6. Verification

```bash
npm test          # Node 92 + Python 19 (zero npm runtime dependencies)
npm run check     # syntax + full gate
```

Runtime smoke (default port 4310, default credentials; copy-paste reproducible):

```bash
npm start

# Health check: version 0.4.0 + python pool + retrieval status
curl http://127.0.0.1:4310/health

# Log in as admin, then call any admin API (example: /api/overview)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/overview"

# Gateway side uses the Bearer key (local mock, works offline)
curl http://127.0.0.1:4310/v1/models \
  -H "Authorization: Bearer atlasgate-dev-key"
```

Key tests live in `test/atlasgate.test.js`, `python/tests/test_engine.py`, and `python/tests/test_ingest.py`.
