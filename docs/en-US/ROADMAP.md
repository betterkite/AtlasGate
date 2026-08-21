# Roadmap

## Delivered foundation

- OpenAI Chat, Responses, Anthropic Messages, Embeddings, and compatible SSE envelopes (including `/v1/models`, `/v1/messages/count_tokens`).
- Capability-aware model mapping, weighted credential pools, bounded failover, and attempt evidence.
- Organization, team, and user governance, plus client keys with scopes, rate limits, quotas, and budgets.
- Multi-user knowledge Changes, optimistic revisions, scheduled merges, conflict ledger, tombstones, and versioned documents/graph.
- MD/TXT/PDF import, Knowledge Agent, Memory, Skills, and MCP.
- Admin console (no-build), Docker image, backup/operations documentation, and regression tests (Node 92 / Python 19).

## LLM Wiki delivered capabilities

- `wiki_sources`, `ingest_queue`, `ingest_cache`, `review_items`, `lint_reports`, `research_jobs`, and `wiki_log`.
- Page types, titles, frontmatter, confidence, and source provenance.
- Two-step compilation (analysis→generation with real models such as deepseek-chat), persistent ingest queue, SHA256 dedupe, and `force:true` forced re-ingest.
- Per-KB `ingest_mode` (`review` default / `auto`) and batch review (`batch_id`); review bases keep changes pending, auto bases merge directly.
- `index.md`, `log.md`, `overview.md` are compiler-maintained, `purpose.md`/`schema.md` human co-authored; degraded pages carry the `atlasgate-degraded` marker and are excluded from retrieval by default.
- Two-level Lint: structural (automatic after publish) and LLM-level (manually triggered); one-way `knowledge/<base>/` md mirror sync (Obsidian-ready, gitignored) and ZIP export.

## RAG hybrid retrieval and ADR-015 delivered capabilities

- Hybrid retrieval (hybrid, default): lexical bigram page-level + local dense vectors (`semantic_vectors` table, SQLite cosine) fused via **RRF**; auto-degrades to pure lexical without embeddings; optional qdrant backend.
- Local ONNX `bge-small-zh` embedding worker (`python/atlasgate_agent/embedding_worker.py`) or any OpenAI-compatible `/v1/embeddings` (`ATLASGATE_EMBEDDING_BASE_URL`); DeepSeek has no embedding endpoint.
- Pseudo-rerank (graph degree), zero-evidence query rewrite (`ATLASGATE_QUERY_REWRITE_ENABLED`, real model), wikilink multi-hop expansion, evidence sufficiency (explicit when evidence is insufficient).
- ADR-015 Q&A sedimentation: explicit `save_to_wiki`/`sediment`, or similar question ≥3 times + quality rules (≥2 source citations, no insufficient evidence, content ≥80 characters) automatic; artifacts land in `queries/<slug>.md`, smart categorization matches `concepts/`/`entities/` pages via RRF and links them with `[[wikilink]]`; goes through the Change audit chain following `ingest_mode` and reuses the pending Change for the same slug; sedimented pages can be edited/deleted/rolled back; `ATLASGATE_QUERY_SEDIMENT_ENABLED` on by default.
- Graph `query_hits` Q&A citation heat (30-day window).
- Skill retrieval strategy: SKILL.md frontmatter declares a `retrieval` field (`top_k`/`multihop`/`include_raw`/`directories`), injected as retrieval parameters after attach (`multihop`/`include_raw` activate when either is true, `top_k` takes the max); explicit caller parameters take priority; `DELETE /api/skills/:id` is supported.

## Next priorities

- Append-only raw-source re-ingest history and stronger generation lineage.
- Schema/purpose context injected into Agent query prompts (currently only into compilation prompts) with prompt version tracking.
- Human approval gates and domain-specific merge functions for high-risk bases.
- OCR and optional DOCX/XLSX/EPUB parsers.
- Admin SSO, RBAC, CSRF, TLS integration, and stricter Provider egress controls.
- Service decomposition and distributed storage only when operational scale justifies it.

## Later Agent components

- Data Agent: question planning, data-catalog discovery, sandboxed queries, data validation, chart artifacts.
- Ops Agent: alert integration, runbook retrieval, risk classification, read-only diagnostics, post-approval remediation.
- Local inference controller: vLLM/SGLang model inventory, GPU scheduling, load routing.
- Skills platform: signed packages, evaluation rankings, org-level scopes, merge lineage, rollback.
- Harness registry: versioned workflows, tool permissions, budgets, checkpoints, traces, human approval.

## Non-negotiable release rules

Any component that can modify production state must pass:

```text
observe -> shadow -> approval-required -> canary -> active
```

P0 priorities cannot bypass authorization, idempotency, bounded scope, and rollback evidence.

## Reproducible examples for delivered capabilities (default port 4310, default credentials)

```bash
# Admin login (reuse the session with -b cookies.txt afterwards)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# Create a review-mode KB -> import -> publish
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"wiki-demo","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"getting-started.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUg5YWl6ZeoCgpBdGxhc0dhdGUg5piv6Z2i5ZCR5bCP5Z6L5Zui6Zif55qE5pys5ZywIExNTSDln7rnoYDorr7mlr3vvJrlpJrljY/orq7nvZHlhbMgKyDniYjmnKzljJYgTExNIFdpa2kgKyDnn6Xor4YgQWdlbnTjgIIK","author":"tester"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"First publish"}'

# LLM Wiki two-step compilation ingest
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well."}'

# Hybrid retrieval (hybrid RRF) and graph citation heat (ADR-015 B)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"stone slab clue","top_k":5}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits|community)"' | head

# Ask the Agent and sediment (ADR-015 A; review bases keep it pending)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"

# Skill declares a retrieval strategy and attaches it (ADR-015 C)
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-8","description":"Deep-fetch 8 pages","instructions":"Answer based on evidence","retrieval":{"top_k":8,"multihop":true}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'

# Gateway Bearer example
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```
