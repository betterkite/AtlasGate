# Gateway Usage

The gateway provides a unified API entry point, authentication, limits, intelligent routing, usage audit, and upstream balance snapshots.

## Request path

```text
client key -> /v1 protocol endpoint -> scope/allowlist/limits/budget
  -> capability and risk scan -> route scoring -> credential pool
  -> Provider -> response and attempt audit
```

## Core objects

| Object | Purpose |
|---|---|
| Provider | Upstream service with URL, models, capabilities, and health |
| Credential | A weighted API key inside a Provider pool |
| Mapping | Client model alias to an upstream model |
| Client key | Caller identity with scopes, allowlists, limits, quota, and budget |

`auto` scores quality, cost, latency, reliability, and small affinity signals. Explicit `provider:model` routes only to the requested route. Vision requests remove text-only candidates before scoring.

429, 5xx, and timeout failures use bounded failover. Every attempt is recorded; non-retryable client errors do not automatically cascade.

## Balance snapshots

DeepSeek Providers automatically use `/user/balance`. OpenRouter and generic endpoints are normalized into snapshots. A failed refresh preserves the last successful amount and records the error.

## Security rules

- Client keys authorize applications to call `/v1/*`; they do not authorize the console.
- Administrator sessions authorize management APIs; they do not authorize `/v1/*`.
- Provider credentials remain server-side and are never returned by management APIs.

See [API](API.md), [Configuration](CONFIGURATION.md), and [Operations](CONSOLE_OPS.md).

