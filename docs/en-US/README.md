# AtlasGate Documentation

This directory contains the English edition of the project documentation. The Chinese edition is maintained separately under [`docs/zh-CN/`](../zh-CN/README.md).

[Chinese documentation](../zh-CN/README.md)

Choose an entry point by reader role:

> Current baseline: **version 0.4.0**, tests **Node 92 / Python 19**, zero npm runtime dependencies; default port **4310**, console `admin / atlasgate-admin`, gateway key `atlasgate-dev-key` (Bearer header). All examples are based on this baseline and can be reproduced as-is.

## 🚀 Newcomers / reproduction

- [Project overview](../../README.md) — positioning, capability overview, one-minute startup
- [Getting started (reproduce from scratch)](GETTING_STARTED.md) — environment requirements + verified command checklist, follow it and it works
- [Introduction](INTRODUCTION.md) — positioning, design philosophy, three-layer model, the two key types, glossary

## 🧭 Users (console and module usage)

- [Usage](USAGE.md) — tour of the 8 console views + common task flows
- [Gateway](GATEWAY.md) — Provider / routing / client keys / upstream balances / rate limits
- [Knowledge versioning](KNOWLEDGE.md) — import / Change / merge / conflicts / retrieval / audit attribution
- [LLM Wiki](WIKI.md) — **where the md files live** / compilation pipeline / review / graph / sync and export
- [Knowledge Agent](AGENT.md) — ask / citations / query sedimentation (ADR-015) / Memory / Skills retrieval strategy

### Common reproduction prerequisites (shared by all examples)

Admin APIs require logging in once and saving the session; the gateway `/v1/*` uses a Bearer key. These two lines are the prerequisite for every example:

```bash
# Health check (returns version: 0.4.0 plus python pool and retrieval backend status)
curl http://127.0.0.1:4310/health

# Admin login, save the session (default admin / atlasgate-admin)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# Gateway verification (local mock, works offline)
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## 🔧 Developers / operations

- [Architecture](ARCHITECTURE.md) — modules, data model, compilation pipeline, graph
- [Developer feature guides](guides/README.md) — per-feature-block purpose, code, principles, data, boundaries, and tests
- [Feature matrix](guides/FEATURE_MATRIX.md) — features, code, APIs, tests, and implementation status
- [Karpathy alignment](guides/07-karpathy-alignment.md) — conformance and differences of the current implementation vs. the original methodology
- [API](API.md) — full HTTP / MCP endpoint set
- [Configuration](CONFIGURATION.md) — all environment variables
- [Deployment](DEPLOYMENT.md) — Docker / Compose / persistence
- [Operations](CONSOLE_OPS.md) — backup / upgrade / troubleshooting
- [Security](SECURITY.md)
- [Architecture decisions (ADR)](DECISIONS.md) — includes ADR-015 memory × knowledge × graph × skills retrieval
- [Roadmap](ROADMAP.md)

## 📚 References and history

- [references/](../references/) — archived copies of Karpathy's LLM Wiki original text and reference projects (llm-wiki-skill, llm_wiki)
- [archive/](../archive/) — historical implementation documents (LLM Wiki refactor Phase 0-4 records)
- [Test plan](TEST_PLAN.md) / [Test report](TEST_REPORT.md)
