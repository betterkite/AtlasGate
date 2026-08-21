# System Runtime and Service Boundaries

> ID: `SYS-001`  
> Status: `implemented`

## Purpose and boundary

AtlasGate is a modular monolith. Node.js hosts the HTTP control plane, gateway, knowledge version service, and Agent adapter. Python workers prepare Agent retrieval and local extractive answers. SQLite is the control-plane source of truth.

This feature does not provide multi-node high availability, distributed transactions, or public administrator identity.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| Startup | `src/server.js` | `main()` | Creates the app and listens |
| Router | `src/app.js` | `createApp()` | Registers APIs, auth, and errors |
| Config | `src/config.js` | `loadConfig()` | Loads environment and defaults |
| Storage | `src/db.js` | `createDatabase()` | Initializes SQLite and migrations |
| Python bridge | `src/services/python-agent.js` | `PythonAgentBridge` | Pool, timeout, and worker recovery |

## Runtime flow

```text
server.js -> config/db/services -> createApp -> HTTP router
                                      |-> Node service
                                      |-> PythonAgentBridge -> JSON Lines worker
```

SQLite uses WAL and foreign keys. The Python pool is bounded, workers are recycled after crashes or timeouts, and repeated spawn failures mark the pool unhealthy and return 503.

## Invariants and verification

- API errors use stable status codes and error codes.
- Python unavailability fails fast instead of respawning forever.
- A failed database transaction cannot advance the Master version.
- `/health` reports process, database, worker, and retrieval state; it does not prove every upstream Provider is healthy.

```bash
npm test
npm run check
```

