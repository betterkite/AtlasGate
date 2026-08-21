# API Reference

All JSON mutation endpoints require `Content-Type: application/json`. Gateway endpoints require a client API key. Management endpoints require the administrator session cookie.

## Data plane

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/models` | List authorized models |
| POST | `/v1/chat/completions` | OpenAI-compatible chat and SSE |
| POST | `/v1/responses` | OpenAI Responses-compatible API and SSE |
| POST | `/v1/messages` | Anthropic Messages-compatible API |
| POST | `/v1/messages/count_tokens` | Token estimate |
| POST | `/v1/embeddings` | Embeddings through a configured Provider |
| POST | `/mcp` | MCP JSON-RPC initialize, list, and call |

Responses expose `x-atlas-request-id`, `x-atlas-routing-decision-id`, and `x-atlas-provider`. Routing headers include `x-atlas-routing-profile`, `x-atlas-session-id`, and `x-atlas-risk-mode`.

## Management API groups

- `/api/auth/*`: administrator session and password change.
- `/api/providers/*`, `/api/model-mappings`, `/api/keys`: gateway control.
- `/api/organizations`, `/api/teams`, `/api/users`: tenant governance.
- `/api/knowledge-bases/*`: Changes, versions, imports, search, graph, ingest, review, lint, index, sync, and export.
- `/api/agents/knowledge/ask`, `/api/skills`, `/api/memories`: Agent runtime.

See `src/app.js` for the complete endpoint list and stable error codes. Pending Changes are never returned as production evidence.

