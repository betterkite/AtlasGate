# Retrieval and Knowledge Agent

> ID: `RAG-001` / `AG-001`  
> Status: `implemented` (version 0.4.0)

## 1. Purpose and boundary

The Agent retrieves evidence from the published Master, produces cited answers, and can explicitly opt in to reading/writing session Memory, loading Skills, and saving answers as Wiki Changes. It must not treat pending Changes as knowledge, nor pretend to know the answer without evidence (a zero-evidence first round tries query rewriting; if still nothing, it says the evidence is insufficient).

## 2. Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTTP | `src/app.js` | `/api/agents/knowledge/ask`, `/api/agents/knowledge/status`, `/api/agents/runs`, `/api/skills*`, `/api/memories*` | Agent / Skills / Memory API |
| Node | `src/services/agent.js` | `ask()`, `retrievalParamsFromSkills()` | Orchestrates retrieval, model, Memory, Skills, and audit; injects skill retrieval params |
| Bridge | `src/services/python-agent.js` | `prepare()` | Calls the Python worker (bounded queue, timeout, restart on failure) |
| Python | `python/atlasgate_agent/engine.py` | `prepare_knowledge_run()`, `_rrf_fuse()`, `_rerank_by_graph_degree()`, `_expand_linked_pages()` | Page-level lexical retrieval, RRF fusion, pseudo-rerank, multi-hop expansion, extractive fallback |
| Vectors | `src/services/semantic-index.js` | `search()`, `indexVersion()` | Local SQLite dense vectors or Qdrant |
| Sediment | `src/services/wiki-compiler.js` | `autoSediment()`, `saveQueryAnswer()`, `similarQuestionCount()` | Explicit/automatic Q&A sedimentation, `[[wikilink]]` smart classification |
| Heat | `src/services/knowledge.js` | `recordQueryHits()`, `graph()` | `query_hits` accumulation and graph node heat |

## 3. Retrieval flow

```text
question -> Master version check
  -> page lexical retrieval (bigram vocabulary overlap, whole-page reading)
  -> hybrid: dense page retrieval (semantic_vectors table, SQLite cosine) -> RRF fusion
  -> pseudo-rerank (graph related edge degree, α=0.05, only breaks RRF ties)
  -> wikilink multi-hop expansion ([[wikilink]] follow-up, zero extra LLM calls)
  -> zero-evidence first round -> LLM query rewrite -> retry once
  -> Memory recall (use_memory=true) -> Skills injection (instructions + retrieval)
  -> citation prompt (evidence numbers [1][2]...)
  -> model or extractive fallback
  -> citation validation / agent_runs ledger / query_hits accumulation / optional sediment
```

Default `ATLASGATE_RETRIEVAL_MODE=hybrid`: lexical + dense vectors fused by RRF (k=60), no weight tuning. Without an embedding service (`ATLASGATE_EMBEDDING_BASE_URL` unset) it degrades automatically to pure lexical page retrieval and `retrieval_mode` returns `page`. The local ONNX embedding service lives in `python/atlasgate_agent/embedding_worker.py` (bge-small-zh-v1.5, 512 dims, OpenAI-compatible `POST /v1/embeddings`, default port 8031); any OpenAI-compatible embedding can be configured (DeepSeek has no embedding). `ATLASGATE_RETRIEVAL_MODE=qdrant` is the Qdrant dense backend and requires real embeddings + Qdrant; local feature hashing is not semantic embedding.

System pages (index/log/purpose/schema/overview) and degraded pages (`atlasgate-degraded`) do not participate in retrieval by default; `include_system` / `include_raw` can open them; `retrieval_mode=chunk` uses the chunk-level BM25 path.

## 4. Memory, Skills, and sedimentation boundary

- With `use_memory=false` Memory is neither read nor written; with `use_memory=true` + session, recall ranks by content relevance (updates `access_count` / `last_accessed_at`) and writes episodic memory.
- Only enabled, attached Skills enter the prompt; their `retrieval` declarations (top_k / multihop / include_raw / directories) inject retrieval params at ask time — multihop/include_raw turn on when either is true, top_k takes the max, directories take the union; **explicit caller params win over the skill**.
- `save_to_wiki=true` / `sediment=true` sediments explicitly, or similar questions (30-day window, bigram Jaccard ≥0.3) asked ≥3 times + quality rules (≥2 source citations, no insufficient-evidence marker, content ≥80 characters) sediment automatically; the output is a `queries/<slug>.md` Change (`[[wikilink]]` links to `concepts/` / `entities/` pages), never a direct Master edit; same slug reuses the pending change.
- Every answer accumulates `query_hits` on cited pages (30-day window: pages unreferenced for over 30 days reset to 1), and graph nodes carry heat.

## 5. Current limitations

- Without a real Provider, local extractive answers are used (mock / `local_extractive`), with no simulated reasoning.
- hybrid needs an embedding service; without embeddings it degrades to pure lexical and there is no semantic matching.
- End-to-end answer quality depends on a real Provider / embedding; offline mock tests prove an explainable offline chain (rewrite, sediment, RRF, multi-hop, heat, skill injection), not model answer quality.

## 6. Verification

```bash
npm test    # Full suite: Node 92 + Python 19, zero npm runtime dependencies
node --test test/wiki-phase6.test.js test/wiki-phase7.test.js test/wiki-phase8.test.js   # query rewrite / Q&A sediment / query_hits+skill retrieval
python -m unittest discover -s python/tests -v   # Python-side engine (lexical/RRF/multi-hop/fallback) and lint
```

## 7. End-to-end reproduction (ask -> hybrid retrieval -> explicit sediment -> skill injection)

Verified against the default dev config (`npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin). Admin `/api/*` uses cookie sessions (login first to get the cookie, then reuse with `-b cookies.txt`); `$KB` carries the id returned by KB creation.

```bash
# 1) Login
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Create a KB (auto mode: compiled ingestion output publishes automatically, so the Agent can retrieve evidence)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"retrieval-demo","ingest_mode":"auto"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) Ask (hybrid by default; without embeddings it degrades to pure lexical and retrieval_mode returns page)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What are the side effects of de-anchoring?\",\"top_k\":5}" \
  | python3 -m json.tool
# Note: with only mock, the compiled output is a sources/ degraded archive page (atlasgate-degraded),
#       which does not participate in retrieval by default, so the answer says "no sufficiently
#       relevant evidence found"; with a real Provider configured, compiled pages become evidence.

# 4) Explicit sediment (save_to_wiki=true): answer + cited pages sediment as queries/<slug>.md
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"How are changes merged?\",\"save_to_wiki\":true,\"session_id\":\"guide-1\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("saved_to_wiki"))'

# 5) Sediment output: auto is published; review stays pending (visible after merge)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages" \
  | python3 -c 'import json,sys; [print(p["path"]) for p in json.load(sys.stdin) if p["path"].startswith("queries/")]'

# 6) Create a skill with a retrieval strategy and attach (multihop on, top_k takes the max, caller params win)
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-retrieval","description":"Deep multi-hop retrieval","instructions":"Prefer a multi-hop evidence chain and cite each piece as [n].","retrieval":{"multihop":true,"top_k":8}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What are the side effects of de-anchoring?\",\"multihop\":false}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("skills:", [s["name"] for s in d["skills"]], "| sources:", len(d["sources"]))'

# 7) Gateway /v1/* uses the Bearer key (same process as the Agent; shows the gateway auth mode)
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

For detailed behavior see [`docs/en-US/AGENT.md`](../AGENT.md) and [`docs/en-US/RAG_PLAN.md`](../RAG_PLAN.md).
