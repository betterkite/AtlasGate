# Deployment

## Local process

```bash
npm start
```

Keep the default host bound to `127.0.0.1` unless an authenticated reverse proxy and network policy are in place.

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:4310/health
```

Persist the SQLite database and `knowledge/` mirror through volumes. Back up SQLite with a SQLite-aware snapshot procedure, including WAL state.

## Production boundary

Set `ATLASGATE_DEV_MODE=false`, provide a strong administrator username and password, replace the development gateway key, and keep Provider credentials in a secret manager or encrypted storage. AtlasGate does not terminate TLS and is not a public administrator identity system.

Qdrant mode requires both Qdrant and embedding configuration. A local ONNX embedding worker is optional.

