# Console Operations

## Backups

Back up `data/atlasgate.db` with a SQLite-aware snapshot procedure and preserve WAL state. The `knowledge/` directory is a derived mirror and can be regenerated, but it is useful for human inspection and Obsidian workflows.

## Upgrades

Stop the process, snapshot the database, deploy the new code, and start the service. The startup migration path upgrades Wiki metadata and repairs derived chunks. Verify `/health`, the console login, the database version, and a knowledge search.

## Provider maintenance

Use Provider test and balance refresh actions. Disable a Provider before maintenance. Historical attempts and usage logs remain available after credential or Provider lifecycle changes where the service protects them.

## Troubleshooting

| Symptom | Check |
|---|---|
| Port in use | Set `ATLASGATE_PORT` or stop the old process |
| Agent unavailable | Check `python3 --version`, `ATLASGATE_PYTHON`, and `/health` worker state |
| Missing Wiki files | Pages are in SQLite; `knowledge/<id>/` is the generated mirror |
| No synthesized answer | Configure a real Provider; mock mode is extractive |
| Qdrant unavailable | Check retrieval mode and embedding/Qdrant configuration |

