# Operations

AtlasGate is a single-node modular monolith. Keep the service on loopback or behind a trusted reverse proxy, persist SQLite, and monitor process, database, Python worker, Provider, queue, and index state.

Operational checks should include:

- `/health` and readiness behavior.
- SQLite file, WAL size, free disk, and backup freshness.
- Provider health, balance snapshot age, and failover attempts.
- Ingest queue failures, review backlog, and Lint reports.
- Python worker pool state, queue depth, restarts, and timeouts.
- Semantic index job state and version alignment.

Do not edit the Wiki Markdown mirror directly. Use the Change API or console so publication, conflict, and audit semantics remain intact.

