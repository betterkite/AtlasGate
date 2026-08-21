# Gateway, Protocols, and Governance

> IDs: `GW-001`, `GW-002`, `GOV-001`  
> Status: `implemented`

## Purpose and boundary

The gateway normalizes OpenAI, Responses, and Anthropic requests, then selects an upstream according to capabilities, allowlists, quotas, and Provider health. It owns routing evidence, credential pools, bounded failover, usage, and audit. It does not own model reasoning quality.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTTP | `src/app.js` | `/v1/*` | Protocol entry and response envelope |
| Conversion | `src/services/protocol.js` | `fromOpenAIChat()`, `fromAnthropic()` | Request/response normalization |
| Routing | `src/services/gateway.js` | `completeRequest()`, `simulate()` | Scoring, credentials, and failover |
| Auth | `src/services/auth.js` | `require()` | Administrator sessions |
| Audit | `src/db.js` | routing and usage tables | Routing and attempt evidence |

## Routing flow

```text
auth/scope/quota -> capability and risk scan -> candidate routes
  -> capability filtering -> profile scoring -> credential selection
  -> bounded Provider attempts -> usage, latency, and error evidence
```

429, 5xx, and timeout failures may advance to the next candidate. Client errors do not automatically cascade.

## Invariants

- Provider keys stay server-side and are exposed only through `has_api_key`.
- Client API keys are stored as hashes and shown in plaintext only at creation.
- Vision requests cannot reach text-only Providers.
- Every attempt, including failed attempts, is auditable.
- Removing a client key does not remove historical usage logs.

See [Gateway usage](../GATEWAY.md) and [architecture decisions](../DECISIONS.md).

