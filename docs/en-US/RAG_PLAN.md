# RAG Retrieval Upgrade Implementation Plan (RAG_PLAN)

> Status: **all three phases implemented and accepted** (current state of 0.4.0 — Phase 1 hybrid RRF: lexical bigram + local dense page vectors (SQLite `semantic_vectors`, ONNX bge-small-zh or any OpenAI-compatible embedding API), auto-degrade to pure lexical without embeddings; Phase 2 pseudo-rerank (graph degree) + zero-evidence query rewrite (`ATLASGATE_QUERY_REWRITE_ENABLED`, on by default); Phase 3 WikiLink multi-hop expansion + evidence sufficiency. Full test suite **Node 92 / Python 19** green; online semantic-hit acceptance requires configuring a real embedding service. bge-reranker (ONNX cross-encoder re-ranking) is not implemented and deferred).
> Corresponds to all decisions of the grilling design tree Q1~Q11 (the user confirmed the recommendations).
> Project convention: after this file is reviewed and confirmed, implement Phase by Phase in order 1 → 2 → 3, and only move to the next Phase after each Phase is accepted (Q21).

## 1. Background and problem

> This section describes the baseline before implementation (0.3.x); see the status at the top and §4 for the current state.

Before implementation, knowledge Agent retrieval (`retrieval_mode="page"`, default) was **pure lexical**: Chinese bigram vocabulary overlap scores whole pages and takes top-k whole pages as evidence. Limitations:

- **No semantic matching**: asking "erysipelas backlash" cannot match a page that writes "anchor-detach side effects" (synonym rewording fails)
- **No re-ranking**: hit order only counts word overlap, so noisy pages can rank first
- **No multi-hop**: cross-page questions cannot be verified step by step
- **No autonomy**: the model cannot decide "whether to retrieve, and whether the evidence is enough"

Current state (after implementation, 0.4.0): `semantic-index.js` provides `embed()` → index → retrieval; the default **local backend** stores page-level vectors in SQLite `semantic_vectors` (in-process cosine; qdrant is the optional backend); `ATLASGATE_RETRIEVAL_MODE=hybrid` is the default (auto-degrade to pure lexical without embeddings); on the Python side the `precomputed_sources` contract carries Node's page-level vector hits and fuses them with lexical hits inside Python via RRF (`_rrf_fuse`).

## 2. Goals (Q1: three phases)

| Phase | Goal | Technique |
| --- | --- | --- |
| **Phase 1** | Fill the semantic gap (highest priority) | Dense vector retrieval + lexical/vector hybrid (Hybrid RRF) |
| **Phase 2** | Improve precision | Reranker (pseudo-rerank first, then bge-reranker) + low-confidence query rewrite |
| **Phase 3** | Complex questions + autonomy | WikiLink multi-hop expansion + evidence sufficiency (lightweight Self-RAG) |

## 3. Decision record (Q1~Q11)

| # | Decision | Conclusion |
| --- | --- | --- |
| Q1 | Goal | E: all of them, split into three phases (table above) |
| Q2 | Vector dependency | C: local ONNX primary + external API optional (DeepSeek has no embedding, verified) |
| Q3 | Fusion method | B: Hybrid + RRF (reciprocal rank fusion, zero weight tuning) |
| Q4 | Vectorization unit | A: whole page (aligned with index-driven whole-page reading) |
| Q5 | Vector storage | A: SQLite vector table (drop the hard Qdrant dependency; keep Qdrant as an optional backend) |
| Q6 | Model selection | A: bge-small-zh-v1.5 (512 dims, ONNX ≈50–100MB), configurable to base/API |
| Q7 | Default mode | A: hybrid by default, auto-degrade to pure lexical without embeddings (current behavior unchanged) |
| Q8 | Reranker | First C (multi-signal pseudo-rerank, zero new deps) then A (bge-reranker ONNX); **C implemented, A deferred** |
| Q9 | Query rewrite | B: only rewrite-and-retry once with the LLM on first-round low confidence |
| Q10 | Multi-hop | A: extract `[[wikilink]]` from first-round hit pages and expand retrieval for one round (zero extra LLM calls) |
| Q11 | Self-RAG | A: lightweight evidence sufficiency (enough → answer with citations; not enough → rewrite retry or explicitly say insufficient) |

## 4. Architecture design

### 4.0 Retrieval data flow (Phase 1 target state)

```
question
  → Node semanticIndex.search (vector, whole-page hits) ──┐
  → python _retrieve_pages (lexical, whole-page hits) ────┼─ RRF fusion (python side)
                                                          └→ top-k whole-page evidence → LLM
```

- Lexical hits live in python (existing `_retrieve_pages`), vector hits in Node (`semanticIndex.search` switched to whole-page level), **fusion happens in python**: `precomputed_sources` semantics are upgraded to "vector retrieval hits (whole page)"; in page mode python fuses them with lexical hits via RRF.
- Without an embedding service, `semanticIndex.enabled()=false` → `precomputed_sources` is undefined → pure lexical (exactly the same as today, Q7).

### 4.1 Local embedding service (Q2/Q6)

- **New** `python/atlasgate_agent/embedding_worker.py`: ONNX Runtime loads bge-small-zh-v1.5 (≈50–100MB), exposes an OpenAI-compatible `/v1/embeddings` (reuses the existing worker mechanism; `pypdf` already established the vendor convention).
- Node `embed()` **zero changes**: `ATLASGATE_EMBEDDING_BASE_URL` points at the local service or an external API.
- Dependency: `onnxruntime` (the only new pip dependency; ADR-010 only constrains JS).

### 4.2 Vector storage and indexing (Q4/Q5)

- **New table** `semantic_vectors` (versioned): `kb_id, version, path, dims, vector_json, updated_at`, unique on `(kb_id, version, path)`.
- `semantic-index.js`:
  - `indexVersion`: switched to indexing **pages** (`knowledge_documents` instead of `knowledge_chunks`), backend=`local` (SQLite) or `qdrant` (existing path kept).
  - `search`: whole-page vector retrieval → returns **page-level** sources (`path` + whole-page `content` + `vector_score`) as `precomputed_sources`.
  - `enabled()`: enabled when `retrievalMode === "hybrid"` or `"qdrant"`; false when embedding is not configured (degrade).
- Config: `ATLASGATE_RETRIEVAL_MODE=hybrid` (default, Q7), `ATLASGATE_EMBEDDING_BASE_URL`, `ATLASGATE_EMBEDDING_MODEL=bge-small-zh-v1.5`, `ATLASGATE_EMBEDDING_DIMENSIONS=512`.

### 4.3 Hybrid RRF fusion (Q3)

- python `prepare_knowledge_run` page mode: lexical hits `_retrieve_pages` + vector hits `precomputed_sources` → RRF: `score(p) = Σ 1/(60 + rank)`, dedupe, take top-k whole pages.
- `_validate_precomputed_sources` upgraded: accepts page-level sources (path/content/vector_score), no longer requires chunk fields.

### 4.4 Phase 2: pseudo-rerank → reranker + query rewrite (Q8/Q9)

- **Pseudo-rerank (implemented)**: after RRF, re-rank top-k with multi-signal weights — reuse graph related edges (page degree, community cohesion, related-edge weights against the question's hit words), zero new dependencies (python `_rerank_by_graph_degree` breaks RRF ties).
- **bge-reranker-base (deferred, not implemented)**: a python worker loads an ONNX cross-encoder model and re-ranks top-k (e.g. 20) question pairs down to top-5; `ATLASGATE_RERANK_ENABLED` is a placeholder switch and is not landed in the current version.
- **Query rewrite (implemented)**: when the first-round RRF has no hits or the max score is below threshold, the LLM rewrites the question into a retrievable form (reuses `completeText`, deepseek-chat) → retry once; still low-confidence → `fallback_answer`.

### 4.5 Phase 3: multi-hop + evidence judgment (Q10/Q11)

- **Multi-hop (A)**: first-round hit pages parse `[[wikilink]]` → existing target pages join the candidates (re-rank one more round by vector/lexical) → whole-page evidence; zero extra LLM calls.
- **Evidence sufficiency (A)**: the LLM gets a new system-prompt instruction — when evidence is insufficient, explicitly answer "insufficient evidence in the current knowledge base" (making the existing fallback explicit); optional: trigger one query-rewrite retry when judged "insufficient" (connecting to Q9).

## 5. Configuration summary (after implementation)

| Config | Default | Description |
| --- | --- | --- |
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | `local` (pure lexical) / `hybrid` (lexical + vector RRF, default) / `qdrant` (pure vector) |
| `ATLASGATE_EMBEDDING_BASE_URL` | empty | `/embeddings` of the local ONNX service or an external API; empty → hybrid auto-degrades to pure lexical |
| `ATLASGATE_EMBEDDING_MODEL` | `bge-small-zh-v1.5` | model name (passed through for external APIs) |
| `ATLASGATE_EMBEDDING_DIMENSIONS` | `512` | vector dimensions |
| `ATLASGATE_EMBEDDING_API_KEY` | empty | for external APIs |
| `ATLASGATE_QUERY_REWRITE_ENABLED` | `true` | Phase 2: real LLM rewrites and retries once on first-round zero evidence (no-op without a real Provider) |
| `ATLASGATE_QUERY_SEDIMENT_ENABLED` | `true` | ADR-015: Q&A sedimented into the Wiki (explicit request or ≥3 similar questions + quality rules) |
| `ATLASGATE_RERANK_ENABLED` | `false` | **Not implemented (deferred placeholder)**: bge-reranker ONNX re-ranking switch |
| `ATLASGATE_WIKI_MAX_PAGES_PER_SOURCE` | `20` | Kept (ingest page budget / retrieval top-k cap) |

## 6. Testing and acceptance

**Phase 1 gates** (accepted, full test suite **Node 92 / Python 19** green):
1. `semantic_vectors` table index/retrieval roundtrip (node tests)
2. Hybrid RRF: construct a "lexical hits page A, vector hits page B" scenario, assert the fused top-k is correct and deduped (node + python tests)
3. Degrade: behavior without embedding config is exactly the same as the current state (covered by the full test suite)
4. End-to-end: once the local ONNX service is up, `/api/agents/knowledge/ask` asking "anchor-detach side effects" hits the page that writes "anchor detach" (semantic-match acceptance; requires configuring a real embedding service)
5. Online KB2 regression: two-chapter compiled page retrieval is unaffected

**Phase 2/3 gates** (accepted): new tests each + full regression (pseudo-rerank / query rewrite / multi-hop / evidence sufficiency, see `test/wiki-phase5~8.test.js`).

**Acceptance commands (reproducible)**: the admin side logs in first to save the session, `$KB` takes the id returned by KB creation:

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Sample KB","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# ① hybrid retrieval: lexical + vector RRF fusion (auto-degrades to pure lexical without embedding config)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"stone wall clue","top_k":5}'

# ② semantic index (requires ATLASGATE_EMBEDDING_BASE_URL; returns 400 when not configured)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'

# ③ ask: response contains retrieval_mode (hybrid) / rewritten_question (non-empty after zero-evidence rewrite) / saved_to_wiki
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"

# ④ multi-hop: assemble the answer across pages (zero extra LLM calls)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"Cross-page question: how does the clue on page A relate to the character on page B\",\"multihop\":true}"
```

## 7. Risks and trade-offs

- **Local ONNX dependency**: adds `onnxruntime` + model weights (≈100MB), slow first load; follows the project's "vendor when you can" convention, no heavy frameworks.
- **Vector dimension consistency**: switching models (bge-base/API) requires rebuilding the index (`semantic_index_jobs` already distinguishes by `embedding_model`, naturally supporting rebuilds).
- **RRF parameters**: k=60 is the conventional default; any tuning is centralized in one constant.
- **Old-version vectors**: stored per version, so historical versions remain traceable; only master participates in retrieval (same as today).
- **Qdrant kept**: SQLite primary, Qdrant optional backend (`retrievalMode=qdrant` reuses existing code, not deleted).

## 8. Milestones

- ✅ M1 (Phase 1): implemented and accepted — full test suite green (Node 92 / Python 19); semantic-hit acceptance requires configuring a real embedding service
- ✅ M2 (Phase 2): implemented and accepted — pseudo-rerank (graph degree) + zero-evidence query rewrite; bge-reranker (option A) deferred
- ✅ M3 (Phase 3): implemented and accepted — WikiLink multi-hop expansion + evidence sufficiency ("cross-page answer assembly" scenario)
