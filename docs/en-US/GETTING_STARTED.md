# Getting Started

This guide provides a reproducible local workflow. It uses the built-in mock Provider and does not require a real model service.

## Requirements

| Dependency | Version |
|---|---|
| Node.js | 24+ (`node:sqlite`) |
| Python | 3.11+; the application probes `python` and `python3` |
| Docker | Optional |

If only `python3` exists, set `ATLASGATE_PYTHON=python3 npm start`. The runtime also probes this automatically.

## Start

```bash
npm start
```

Open `http://127.0.0.1:4310`:

| Surface | Development credential |
|---|---|
| Console | `admin` / `atlasgate-admin` |
| Gateway `/v1/*` | Bearer `atlasgate-dev-key` |

For production-like use, set `ATLASGATE_DEV_MODE=false`, `ATLASGATE_ADMIN_USERNAME`, and `ATLASGATE_ADMIN_PASSWORD`.

## Minimal checks

```bash
curl http://127.0.0.1:4310/health
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

The complete knowledge-base workflow is documented in [Knowledge](KNOWLEDGE.md) and [LLM Wiki](WIKI.md).

## Tests

```bash
npm run test:node
python3 -m unittest discover -s python/tests -v
```

The package script currently invokes `python` directly for its Python portion; use `python3` explicitly on systems without a `python` alias.

