# Reference Capability Matrix

This matrix records capabilities with code and test evidence. Reference projects are used only for capability comparison; they do not represent a promise to replicate their hosted products.

| Capability | AtlasGate status | Current boundary |
|---|---|---|
| OpenAI Chat Completions | Implemented | Streaming and non-streaming both supported; `auto` routing with the local mock is verifiable offline |
| OpenAI Responses | Implemented | Request, response, and SSE streaming conversion paths are covered |
| Anthropic Messages | Implemented | Messages, `/v1/messages/count_tokens`, and tool conversion are covered |
| Embeddings | Implemented | Gateway forwards upstream `/v1/embeddings`; Agent dense retrieval uses local ONNX `bge-small-zh` or an OpenAI-compatible service |
| SSE streaming responses | Implemented | Server-side chunked output for all three envelopes (OpenAI/Responses/Anthropic); upstream completes before streaming starts; transparent token forwarding and disconnect propagation are not done |
| Provider and model mapping | Implemented | Capability-aware mapping + model allowlist; more vendor-specific adapters remain extensible |
| Credential pools | Implemented | Multiple keys, weights, quotas, and cooldowns; application-layer encryption not done |
| Routing and failover | Implemented | Capability filtering, scoring policy, bounded retries, attempt audit |
| Tenant governance | Implemented (foundation) | Organizations/teams/users with scoped keys; OIDC and admin RBAC UI not done |
| Billing subscriptions | Partial | Usage, cost estimates, and upstream balance only; no payments, invoices, or subscription service |
| MD/TXT/PDF import | Implemented | Text PDFs; scanned-PDF OCR and Office formats not done |
| Git/URL/directory ingest | Partial | URL ingest is supported (Wiki compiler `fetchUrl`); Git/directory auto-ingest remains limited |
| LLM Wiki compilation | Implemented | Two-step compilation (analysis→generation), per-KB `review`/`auto`, batch review, SHA256 dedupe, `force:true`, degraded pages, two-level Lint, md mirror, ZIP export |
| Hybrid retrieval | Implemented | hybrid default (lexical bigram + dense RRF), auto-degrade to pure lexical without embeddings, pseudo-rerank, zero-evidence rewrite, wikilink multi-hop; semantic quality requires a real embedding service |
| Knowledge graph | Implemented | Pure-JS ForceAtlas2 + Louvain communities, 5-signal related edges, `query_hits` citation heat (30-day window), isolated per knowledge base and Master version |
| Multi-user knowledge governance | Implemented (foundation) | Change→merge→immutable Master, conflict ledger, tombstones, batch review; external identity providers not yet integrated |
| Q&A sedimentation and skill retrieval (ADR-015) | Implemented | Explicit/auto sedimentation through the audit chain, same-slug reuse, `query_hits` heat, SKILL.md `retrieval` attach injection; signing and evaluation gates not done |
| Agent, Memory, Skills | Implemented | Local fallback is not model-synthesized reasoning; skill signing and evaluation gates not done |
| MCP | Partial | Governed tools are provided, but the tool surface is smaller than the reference product |
| High availability | Not implemented | No multi-node control plane, distributed locks, or persistent distributed queues |

New capabilities must add automated tests, documentation, and an explicit production boundary at the same time.

## Reproducible examples (verify against the Implemented rows above)

```bash
# Admin: cookie login
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# Gateway: Bearer calls (Chat Completions / model list / Embeddings require a real upstream)
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'

# LLM Wiki compilation + Hybrid retrieval + ADR-015 ($KB carries the id returned by KB creation)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"wiki-demo","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well."}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"stone slab clue","top_k":5}'
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"
```
