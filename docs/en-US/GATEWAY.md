# Gateway Usage

The gateway module owns: **unified entry point + authentication/limits + intelligent routing + usage audit + upstream balance**. It backs console views 04 "Model Gateway" and 05 "Routing Policy".

> Runtime facts (version 0.4.0): `npm start` boots the console at **http://127.0.0.1:4310** with default administrator `admin / atlasgate-admin`; the gateway development key is `atlasgate-dev-key` (`Authorization: Bearer` header); there are no npm runtime dependencies. The first start ships a built-in mock Provider (`prv_local_demo`) and the development key, so the full chain can be verified offline.

## Concept map

```text
Caller ──Bearer client key──▶ /v1/* protocol entry (Chat Completions / Responses / Anthropic Messages / Embeddings / SSE / Token counting)
        │ ①authentication (scope/allowlist/limits/quota/budget)
        │ ②capability scan (vision requests only reach vision models)
        │ ③route scoring (quality/cost/latency/reliability + affinity tuning)
        ▼
    Provider credential pool (multi-key rotation, cooldown, Failover)
        ▼
    DeepSeek / OpenAI / Anthropic / local mock
```

## Objects and configuration

| Object | What it is | Key fields |
| --- | --- | --- |
| **Provider** | An upstream service | kind (openai/anthropic/mock), base_url, api_key, models, quality/cost/latency/reliability scores, health status, balance (balance_amount/currency/status/checked_at) |
| **Credentials** | Multiple keys under a Provider | weight (weighted rotation), quota, cooldown, error_count |
| **Mappings** | Client alias → upstream model | alias, upstream_model, priority, capabilities (text/vision/tools/embeddings) |
| **Client keys** (api_keys) | Caller identity + governance | scopes, allowed_models, RPM/TPM, token quota, monthly budget, team/user ownership |

> Adding a Provider auto-creates a mapping per model (alias = model name) and, for DeepSeek / OpenRouter, auto-fills the balance endpoint; `api_key` lands as a "Primary" credential. The built-in mock `prv_local_demo` provides two models, `atlas-mini` and `atlas-vision`; once real Providers are configured, `auto` routing automatically ignores it.

### Client key details

- **Scope**: `gateway:invoke` (default) or `*`; keys can only call `/v1/*`, never the console.
- **Rate limits**: `requests_per_minute` (RPM), `tokens_per_minute` (TPM) on a per-minute window.
- **Quota/budget**: `quota_tokens` (total token cap), `monthly_budget_cents` (monthly budget); keys owned by a team/organization additionally stack team- and organization-level monthly budget checks.
- **Lifecycle**: revoke (enabled=false) → invalid immediately; restore; permanent removal — **historical usage audit is retained** (`retained_usage_logs`).

## Routing behavior

- `model: "auto"`: scores all candidates by profile weight (quality/balanced/economy/latency, default balanced); the profile can be set via the `x-atlas-routing-profile` request header or the `routing_profile` body field; **excludes mock demo Providers** (when real upstreams exist).
- `model: "provider:model"`: explicit routing.
- Vision requests: automatically filters down to models declaring the `vision` capability.
- Failure retry: candidates are tried in order; retryable 408/429, 5xx and timeouts trigger Failover (bounded with `x-atlas-max-attempts`, default 4); **every attempt is recorded**.
- `/v1/models` lists `auto`, all mapping aliases, and full `provider:model` names.

## Upstream balance (DeepSeek auto-detection)

- When a Provider's `base_url` is `api.deepseek.com`, no balance endpoint is needed — the official `https://api.deepseek.com/user/balance` is used automatically (Bearer with the same key); OpenRouter (`openrouter.ai`) is likewise auto-detected as `/api/v1/credits`.
- Results are stored in `providers.balance_amount/currency/status/checked_at` plus an append-only snapshot table `provider_balance_snapshots`.
- The "Runtime overview" top card shows the **upstream API key balance**, refreshed automatically on entry (at most once per minute), or via the "Refresh balance" button.
- To customize the endpoint: set `balance_endpoint` on the Provider (overrides auto-detection); supports three response formats — DeepSeek `balance_infos[].total_balance`, OpenAI-style `data.total_credits`, and generic `balance`.

## Health and diagnostics

- "Test" (`POST /api/providers/:id/test`): calls `{base_url}/models`, writes health status and latency.
- "Routing Policy → Simulate" (`POST /api/routing/simulate`): feed any request and see the **final selection + all candidate scores + exclusion reasons** (unmapped model / insufficient capability / mock suppression, etc.).
- "Audit evidence": every request's routing decision (`routing_decisions`), attempts (`provider_attempts`), usage (`usage_logs`), risk level, and **caller key**.

## Reproducible examples (copy-paste)

> The admin API requires a login session first, then uses `-b cookies.txt`; the gateway side uses a Bearer client key. Default port 4310, default credentials `admin / atlasgate-admin`.

### Admin login

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"atlasgate-admin"}'
```

### Add a DeepSeek Provider (auto-creates model mappings and balance endpoint)

```bash
PROVIDER=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"deepseek","kind":"openai","base_url":"https://api.deepseek.com","api_key":"sk-your-DeepSeekKey","models":["deepseek-chat","deepseek-reasoner"]}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "PROVIDER=$PROVIDER"
```

### Check upstream balance (DeepSeek auto-detects /user/balance)

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/providers/$PROVIDER/balance" \
  -H 'content-type: application/json' -d '{}'
# Response contains amount/currency/status/checked_at; the balance fields are also readable via GET /api/providers
```

### Create a client key (plaintext only returned at issuance)

```bash
KEY=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/keys \
  -H 'content-type: application/json' \
  -d '{"name":"my-app","scopes":["gateway:invoke"],"allowed_models":["deepseek-chat"],"requests_per_minute":60,"tokens_per_minute":100000,"quota_tokens":1000000}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
echo "KEY=$KEY"
```

### Gateway call (Bearer client key on the gateway side)

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}'

# With no real Provider configured, verify offline with the built-in mock (dev key is atlasgate-dev-key)
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

### Other protocol entries (multi-protocol gateway)

```bash
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"

curl http://127.0.0.1:4310/v1/responses -H "Authorization: Bearer atlasgate-dev-key" \
  -H 'content-type: application/json' -d '{"model":"auto","input":"ping"}'

curl http://127.0.0.1:4310/v1/messages -H "Authorization: Bearer atlasgate-dev-key" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'

curl http://127.0.0.1:4310/v1/embeddings -H "Authorization: Bearer atlasgate-dev-key" \
  -H 'content-type: application/json' -d '{"model":"auto","input":"AtlasGate"}'

# SSE streaming (stream: true)
curl -N http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"ping"}]}'
```

## Common pitfalls

- **Client key ≠ administrator**: keys do not work on `/api/*`; administrators do not work on `/v1/*`.
- **auto never picks the mock**: once real Providers exist, `auto` automatically ignores the demo Provider; the local extractive fallback is used only when mock is the only option.
- **Balance shows "not configured"**: the Provider has no balance endpoint and `base_url` is not deepseek/openrouter; or "Balance" was never clicked.
- **Key quota exhausted**: `quota_exhausted`/`budget_exhausted` returns 429; check used/quota on the key list.
- **Built-in mock is not deletable**: `prv_local_demo` is a protected Provider; deletion returns 409.

## Related docs

- [Configuration](CONFIGURATION.md) (`ATLASGATE_*` environment variables)
- [API](API.md) (`/api/providers`, `/api/keys`, `/v1/*` endpoints)
- [Operations](CONSOLE_OPS.md) (key rotation, Provider maintenance)
