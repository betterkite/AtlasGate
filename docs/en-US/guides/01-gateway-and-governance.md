# Gateway, Protocols, and Governance

> IDs: `GW-001`, `GW-002`, `GOV-001`  
> Status: `implemented`

## Purpose and boundary

The gateway normalizes OpenAI Chat Completions, Responses, Anthropic Messages, and Embeddings requests into an internal request (SSE streaming and token counting also go through `/v1/*`), then selects an upstream according to capabilities, allowlists, quotas, and Provider state. It owns routing evidence, credential pools, bounded failover, usage, and audit. It does not own model reasoning quality.

Identity comes in two flavors: the admin surface `/api/*` uses administrator cookie sessions (`src/services/auth.js`); the gateway surface `/v1/*` uses client-key Bearer auth (`src/services/gateway.js#authenticate`), with keys governed by scope/model allowlist/RPM/TPM/quota/monthly budget.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTTP | `src/app.js` | `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/embeddings`, `/v1/models` | Protocol entry and response envelope |
| Conversion | `src/services/protocol.js` | `fromOpenAIChat()`, `fromResponses()`, `fromAnthropic()`, `chatToAnthropic()`, `chatToResponse()` | Request/response protocol normalization |
| Streaming | `src/core/sse.js` | `sendOpenAIStream()`, `sendResponsesStream()`, `sendAnthropicStream()` | SSE streaming envelopes |
| Routing | `src/services/gateway.js` | `completeRequest()`, `plan()`, `simulate()`, `pickCredential()` | Candidate scoring, credential selection, and failover |
| Auth | `src/services/auth.js` / `src/services/gateway.js` | `require()` (admin) / `authenticate()` (gateway) | The two identity checks |
| Audit | `src/db.js` | `routing_decisions`, `provider_attempts`, `usage_logs`, `provider_balance_snapshots` | Call evidence retention |

## Routing flow

```text
auth/scope/quota -> capability and risk scan -> explicit provider:model or auto candidates
  -> vision capability filtering -> profile scoring
  -> credential pool selection -> bounded Provider attempts
  -> record routing, usage, latency, and errors
```

Embeddings and token counting reuse the same routing decision. Only retryable 408/429, 5xx, and timeout failures advance to the next candidate; client errors do not unconditionally cascade.

## Invariants

- Provider API keys stay server-side; APIs expose only `has_api_key`.
- Client API keys are stored only as hashes and shown in plaintext only at issuance.
- Vision requests cannot reach Providers that do not support vision.
- Every attempt has an audit record, including failed attempts.
- Deleting a client key does not delete historical usage logs.
- The built-in mock Provider (`prv_local_demo`) is protected and cannot be deleted.

## Verification

```bash
npm start   # 0.4.0: console http://127.0.0.1:4310 (admin / atlasgate-admin), gateway key atlasgate-dev-key
npm test    # full suite: Node 92 + Python 19, no npm runtime dependencies
```

Gateway behavior is concentrated in `test/atlasgate.test.js`; knowledge versions/Wiki are covered by `test/wiki-phase*.test.js`; the python worker is covered by `python/tests`. Coverage should span protocol envelopes (Chat/Responses/Anthropic/Embeddings), model allowlists, RPM/TPM and quota/budget, risk blocking, explicit routing, auto routing, bounded failover, Provider/credential lifecycle, and key isolation.

## End-to-end reproduction (copy-paste)

```bash
# 1) Admin login (cookie session)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Issue a client key (plaintext only returned at issuance)
KEY=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/keys \
  -H 'content-type: application/json' \
  -d '{"name":"dev-cli","scopes":["gateway:invoke"],"requests_per_minute":60,"tokens_per_minute":100000,"quota_tokens":1000000}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
echo "KEY=$KEY"

# 3) Gateway call (Bearer client key; atlasgate-dev-key also works before a key is created)
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'

# 4) Audit evidence: every attempt and usage
curl -b cookies.txt "http://127.0.0.1:4310/api/provider-attempts?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/usage/breakdown"
```

Detailed user behavior is in [`docs/en-US/GATEWAY.md`](../GATEWAY.md) (DeepSeek Provider, balance, client keys, full examples); the rationale is in [`docs/en-US/DECISIONS.md`](../DECISIONS.md).
