# Security

> Version baseline: **0.4.0**. The current release targets localhost or a trusted private network and must not be exposed directly to the public internet. The default console `admin / atlasgate-admin` and the dev gateway key `atlasgate-dev-key` only apply in dev mode (`ATLASGATE_DEV_MODE=true`).

## Threat model

The system must protect Provider credentials, client gateway keys, prompts, usage evidence, and published knowledge. Main risks: unauthorized calls, control-plane modification, key leakage, cross-tenant access, malicious imports, upstream SSRF, resource exhaustion, and log leakage of prompts.

## Implemented controls

- **Two authentication boundaries**: admin `/api/*` (except `/api/auth/*`) requires an administrator session — `HttpOnly` + `SameSite=Lax` cookie (`atlasgate_admin_session`), default 8 hours (`ATLASGATE_ADMIN_SESSION_TTL_MS`), and password changes invalidate all other sessions; gateway `/v1/*` requires `Authorization: Bearer <key>` or `X-Api-Key`.
- The dev gateway key `atlasgate-dev-key` is only auto-seeded when `ATLASGATE_DEV_MODE=true` (`db.js`); with production `false` it is not generated — issue your own keys.
- Client keys are stored as SHA-256 hashes and checked against scope, model whitelist, RPM/TPM, token quota, monthly budget, team/org budget, and the owning user's enabled state.
- Provider credentials are server-side only; the API returns existence or prefix metadata.
- Prompt previews are length-capped and redacted; risk mode can block suspected key leakage (private keys / long `sk-` strings marked critical).
- JSON, file size, Python timeout, worker queue, retry, and result counts are all bounded; the worker pool fast-fails (503) when unhealthy without leaking FDs.
- Knowledge collaboration uses optimistic revisions; published versions are immutable; the conflict ledger and tombstones preserve evidence; Q&A sediment (ADR-015) goes through the same Change audit chain and never bypasses review.
- Skill imports only accept UTF-8 `SKILL.md`/`skill.json` content (≤256 KB), never server-side paths.
- The container runs as a non-root user and sets basic security response headers.

## Quick verification (copy-paste)

With the default dev config (`npm start`, http://127.0.0.1:4310), verify both boundaries:

```bash
# Admin side: cookie session (HttpOnly + SameSite=Lax); unauthenticated /api/* returns 401
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/keys
curl http://127.0.0.1:4310/api/keys          # no cookie -> 401 admin_auth_required

# Gateway side: Bearer key for /v1/* (the dev key only exists in dev mode)
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/models          # no key -> 401 missing_api_key

# Change the admin password (new password >= 12 characters; all other sessions are invalidated)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"current_password":"atlasgate-admin","new_password":"a-strong-new-password-2026"}'
```

## Known gaps

The admin API does not yet provide administrator SSO/RBAC, CSRF protection (only `SameSite=Lax` mitigation), or TLS termination. Provider credentials are not application-layer encrypted, and Provider URL validation / DNS-rebinding protection is not a full egress firewall. Therefore bind to loopback, or use an authenticated reverse proxy and network egress policy.

The MCP endpoint `POST /mcp` is not under `/api/*` and does not require an admin session, but it only exposes the declared governed tool set (knowledge search/ask/graph/Change/merge/ingest/review/Lint/Memory/Skills) and never returns any keys (see [guides/06-console-and-mcp.md](guides/06-console-and-mcp.md)).

## Production hardening checklist

- Set `ATLASGATE_DEV_MODE=false`: no more `atlasgate-dev-key` seeding, and `ATLASGATE_ADMIN_USERNAME/PASSWORD` must be provided explicitly; do not reuse the default dev key/admin password (≥12 characters).
- Allow only the reverse proxy and administrators to reach port 4310; admin routes (`/api/*`, `/mcp`) can be further restricted by source.
- Add identity authentication in front of `/api/*` (put SSO/RBAC on the proxy if needed); `/v1/*` keeps using gateway keys.
- Store `.env` and Provider credentials in a Secret Manager or encrypted storage; tighten `ATLASGATE_ADMIN_SESSION_TTL_MS` as needed.
- Allow access only to approved Provider, Embedding, and Qdrant addresses (egress whitelist, anti-SSRF).
- Configure Qdrant authentication; do not expose port 6333 publicly.
- Monitor 401/403/429/5xx, worker restarts, queue saturation, balance failures, and conflict growth (`/api/logs`, `/api/provider-attempts`, `/api/knowledge-bases/:id/conflicts`).
