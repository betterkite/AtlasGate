# AtlasGate Introduction

## One-line positioning

**AtlasGate is local LLM infrastructure for small engineering teams**: a multi-protocol OpenAI / Anthropic API gateway + a knowledge base with collaborative version governance, LLM auto-compilation, and a relation graph (LLM Wiki), plus a knowledge Agent that cites evidence by default.

## Problems addressed

- Teams integrate multiple LLMs (DeepSeek, OpenAI, Anthropic…); they need a unified entry point for **routing, rate limiting, budgets, and audit** instead of each service wiring its own SDK.
- Teams want to accumulate knowledge, but traditional RAG re-reads raw documents from scratch on every query — **knowledge does not accumulate**. AtlasGate follows Karpathy's LLM Wiki methodology: the **LLM "compiles" source material into continuously maintained wiki pages**, growing thicker with use.
- On-premise deployment needs **controlled, auditable, offline-capable** operation: data lives in local SQLite, keys are governed in two classes, and everything is traced.

## Three components

```
Business systems / Agent / MCP ──▶ ① protocol gateway (/v1/* OpenAI·Anthropic compatible)
                                     ├─ auth (client key) → limits/budget → capability filtering → scored routing → upstream Providers (DeepSeek etc.)
                                     └─ every call recorded: request, routing, usage, key ownership, risk (audit ledger)
② knowledge base (versioned + LLM Wiki)
    import material → Change (pending review) → merge publish → immutable Master vN → retrieval index (lexical bigram + dense vector RRF) + relation graph
    LLM compile pipeline: two steps (analyze → generate) turn material into entity pages / concept pages / summary pages / index / log
    Wiki pages are also mirrored to the knowledge/ directory on disk (directly openable in Obsidian)
③ knowledge Agent (resident Python worker)
    retrieve Master evidence → answer with citations; optional Memory / Skills; answers can be sedimented back as wiki pages
```

## Design principles

| Principle | Implementation |
| --- | --- |
| **DB is the source, disk is the mirror** | Knowledge base pages live in SQLite (versioned, auditable); the `knowledge/` md directory and the export zip are mirrors |
| **LLM writes always go through the audit chain** | The compile pipeline only generates Changes, never writes Master directly; review mode waits for human review, auto mode publishes automatically |
| **Two key classes are strictly separated** | Client keys (call `/v1/*`, token quota) ≠ administrator accounts (console, session Cookie) ≠ upstream API Keys (call DeepSeek, spend balance) |
| **Zero npm runtime dependencies** | The gateway and graph are fully native (including the pure-JS force-directed graph, Louvain communities, and ZIP writer) |
| **Offline verifiable** | The local mock model runs the whole chain; without a real Provider, LLM compilation degrades to "material archive + raw text as page" |

## Key numbers

- Version: **0.4.0**
- Full test suite: **Node 92 / Python 19** (`npm test` gate, all green)
- Tech stack: Node.js 24 (ESM, `node:sqlite`, zero npm runtime deps) + Python 3.11+ (Agent Core) + native HTML/Canvas console
- Deployment: single-machine modular monolith (Docker optional), data in `data/atlasgate.db` (WAL)
- Default entry: `npm start` → console http://127.0.0.1:4310, default account `admin / atlasgate-admin`, gateway Key `atlasgate-dev-key` (Bearer header)

## Glossary

| Term | Meaning |
| --- | --- |
| Gateway | `/v1/*` multi-protocol entry (Chat Completions / Responses / Anthropic Messages / Embeddings / SSE); auth, rate limiting, scored routing, and the audit ledger |
| Knowledge base (KB) | Versioned wiki page collection; page bodies live in SQLite `data/atlasgate.db`; each KB has its own `ingest_mode` and graph |
| Change | One pending modification (upsert / delete) carrying author and `base_version`; only merge affects the production read pointer |
| Master | Immutable production version (vN); advanced atomically on merge, with the conflict ledger / tombstones recorded alongside |
| System pages | `index.md` / `log.md` / `overview.md` maintained by the compile pipeline, `purpose.md` / `schema.md` human-collaborated; all participate in version governance |
| Degraded page | Without a real model, ingest degrades to "material archive + raw text as page", carrying the `atlasgate-degraded` marker; excluded from retrieval by default (visible only with `include_raw=true`) |
| Retrieval mode | `hybrid` (default): lexical bigram at page level + local dense page vectors fused by RRF; auto-degrades to pure lexical without embeddings; `qdrant` is an optional pure-vector backend |
| RRF | Reciprocal Rank Fusion: `score(p) = Σ 1/(60 + rank)`, fusing the lexical and vector hit streams with zero weight tuning |
| Pseudo-rerank | Breaks RRF ties with graph degree, promoting central pages (zero extra dependencies, Phase 2) |
| Query rewrite | On first-round zero evidence, a real LLM rewrites the question and retries once (`ATLASGATE_QUERY_REWRITE_ENABLED`, on by default) |
| Multi-hop | `[[wikilink]]` targets of first-round hit pages join the candidates and are re-ranked for one round, zero extra LLM calls (Phase 3) |
| Evidence sufficiency | When evidence is insufficient the answer explicitly says "insufficient evidence in the current knowledge base", never fabricates (Phase 3) |
| `query_hits` | Citation heat of a page from Q&A (last-30-day window); visible on graph nodes, console tints by citation frequency |
| Sediment | Q&A written to `queries/<slug>.md` through the Change audit chain: explicit `save_to_wiki` / `sediment`, or ≥3 similar questions + quality rules (ADR-015) |
| Skill | SKILL.md package; frontmatter can declare a `retrieval` field (`top_k` / `multihop` / `include_raw` / `directories`), injecting retrieval parameters after attach (ADR-015) |
| ADR | Architecture Decision Record (001–015), the authoritative account of important technical decisions in this repository |
| MCP | Model Context Protocol tool entry (`POST /mcp`), exposing knowledge base retrieval / Q&A to external Agents |

## Complete data flow of one question (reproducible)

Walk the three components with "create KB → import material → publish → ask → sediment" (the admin API logs in first to save the session; the gateway side uses a Bearer Key):

```bash
# ① Log in to the admin side (save the session cookie)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# ② Create a KB (review mode, default; the returned id feeds $KB)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Sample KB","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# ③ Import material → generates a pending Change (knowledge platform)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"intro.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUgSW50cm9kdWN0aW9uCgpBdGxhc0dhdGUgaXMgYW4gb3Blbi1zb3VyY2UgTExNIGluZnJhc3RydWN0dXJlIGZvciBzbWFsbCBlbmdpbmVlcmluZyB0ZWFtczogYW4gb3BlbiBnYXRld2F5ICsgYSBsb2NhbC1maXJzdCBMTE0gV2lraSArIGEga25vd2xlZGdlIEFnZW50Lgo=","author":"tester"}'

# ④ merge publish → immutable Master v2 (version governance)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"First publish"}'

# ⑤ Knowledge Agent asks (explicit sedimentation; response contains answer / sources / retrieval_mode / saved_to_wiki)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"

# ⑥ Sediment artifact: the queries/ page becomes a pending Change (a review KB does not auto-publish); the graph records citation heat
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits|community)"' | head
```

Equivalent gateway-side call (Bearer Key, no login):

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## References

- Methodology: [Karpathy: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (the original is archived under docs/references/)
- Reference implementations: [sdyckjq-lab/llm-wiki-skill](https://github.com/sdyckjq-lab/llm-wiki-skill), [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) (capability comparison in docs/REFERENCE_MATRIX.md)

## Next steps

- New here? Start with [Getting Started (reproduce from scratch)](GETTING_STARTED.md)
- Capability list and quick start: [README](../../README.md)
- How each module is used: [docs/zh-CN/README.md](README.md) (Chinese navigation home)
