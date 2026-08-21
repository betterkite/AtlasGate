# Architecture Decisions

| ID | Decision | Reason |
|---|---|---|
| ADR-001 | Modular monolith first | Preserve low-cost domain and publication experiments before service decomposition |
| ADR-002 | SQLite WAL | Transactions, portability, and a local Docker volume |
| ADR-003 | Stable Master plus isolated Changes | Atomic publication, auditability, and conflict evidence |
| ADR-004 | Persistent Python worker pool | Process isolation without per-request startup |
| ADR-005 | Named retrieval modes | hybrid default: lexical + local dense vectors fused with RRF, auto-degrade to pure lexical without embeddings, qdrant as optional backend |
| ADR-006 | Uploaded Skill packages | Portable content packages without executing client archives |
| ADR-007 | Honest compatibility claims | Protocol compatibility is tested without claiming hosted-product parity |
| ADR-008 | LLM Wiki three-layer model | Raw Sources -> Wiki -> Schema with versioned system pages |
| ADR-009 | Wiki writes use the audit chain | Compiler output becomes a Change, never a direct Master write |
| ADR-010 | Pure-JS graph enhancements | Preserve the zero-runtime-dependency principle |
| ADR-011 | Bounded Python respawn | Fail fast and stop descriptor leaks when Python cannot start |
| ADR-012 | Hybrid retrieval with RRF | Combine lexical precision and dense paraphrase matches |
| ADR-013 | Structural rerank and query rewrite | Improve precision without introducing heavy dependencies |
| ADR-014 | WikiLink multi-hop and evidence sufficiency | Expand linked evidence and refuse unsupported answers |
| ADR-015 | Memory × knowledge × graph × skill-retrieval integration | Q&A auto-sediments into the Wiki, graph citation heat, skills declaring retrieval strategies |

## ADR-015: Memory × knowledge × graph × skill-retrieval integration

Grilling Q1~Q8 (three directions).

**A — query sedimentation (memory → knowledge loop)**: when a question has been asked ≥3 times (bigram Jaccard ≥0.3 similarity over the last-30-day `agent_runs` history) or is explicitly requested (`save_to_wiki` / `sediment`), and the answer satisfies the "high-quality" rules (≥2 source citations, no "insufficient evidence" marker, content ≥80 characters), the Q&A is sedimented into the Wiki. Classification is smart (Q4C): first match the question against existing `concepts/`/`entities/` pages with hybrid RRF — a strong match (score ≥0.2) creates/updates `queries/<slug>.md` and `[[wikilink]]`s that page (relate, never rewrite the human-maintained concept page); otherwise it lands in `queries/`. Sedimentation goes through the standard Change audit chain and follows the KB `ingest_mode` (Q5A); when a same-theme sedimented page already exists it is updated in place (Q6A); sedimented pages are normal wiki pages — editable, deletable, rollback-able (tombstone).

**B — memory as part of the graph (usage trace)**: knowledge page nodes carry a `query_hits` citation-heat count (last-30-day window, Q8A); the graph API returns the heat so the console tints by citation frequency (Q7B) — memory is the usage trace of knowledge, no extra memory nodes are created.

**C — skill × retrieval strategy**: SKILL.md frontmatter gains a structured `retrieval` field (`multihop` / `top_k` / `include_raw` / `directories`, or preset aliases); activated skills inject retrieval parameters into Agent requests (Q3A), turning a skill from "pure prompt text" into something that can influence the retrieval strategy.

Each decision has an explicit production boundary. Later changes should add a new ADR or update the affected decision with migration and test impact.

## Reproducible examples (matching the decisions on this page)

The admin API logs in first to save a session (`curl -c cookies.txt`), then calls with `-b cookies.txt`; the gateway `/v1/*` uses `Authorization: Bearer atlasgate-dev-key`. The following commands are verified against the default dev config (port 4310, default credentials); `$KB` takes the id returned by KB creation.

### ADR-003/008/009: Change → merge → immutable Master

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Sample KB","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Submit an upsert Change (stays pending in a review KB)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"notes/hello.md","operation":"upsert","content":"# Hello\n\nAtlasGate sample page.","author":"tester"}'

# merge publish → Master v2; the Change list stays auditable
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"Publish sample page"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions"
```

### ADR-015 A: Q&A sedimentation loop (explicit request, stays pending in a review KB)

```bash
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"
# Response contains saved_to_wiki (queries/<slug>.md sedimented as a pending Change, following ingest_mode)

curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages?page_type=query"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits|community)"' | head
```

### ADR-015 C: a skill declares a retrieval strategy and gets attached

```bash
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-8","description":"Deep retrieve 8 pages","instructions":"Answer from evidence","retrieval":{"top_k":8,"multihop":true}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'
# After attach, ask: multihop enabled, top_k=8; explicit caller parameters take precedence
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"top_k\":3}"
```

### ADR-012/013/014: hybrid retrieval + multi-hop + evidence constraint

```bash
# hybrid retrieval (lexical + vector RRF)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"stone wall clue","top_k":5}'

# Multi-hop question: assemble the answer across pages; when evidence is insufficient the answer explicitly says "insufficient evidence in the current knowledge base"
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"Cross-page question: how does the clue on page A relate to the character on page B\",\"multihop\":true}"
# Response retrieval_mode=hybrid; rewritten_question is non-empty after a zero-evidence rewrite
```
