# Knowledge Versions

This module governs **knowledge base imports, change governance, version publication, retrieval, and audit**. It backs the console view 03 "Knowledge Versions". Knowledge base pages are versioned in SQLite (the `knowledge_documents` table in `data/atlasgate.db`) — the single source of truth, because multi-user version governance, the conflict ledger, and audit all require it.

## 1. Core model: Change → Merge → Master

```text
edit/import/LLM compile ──▶ Pending Change (awaiting review, optimistic revision; LLM compile batches share a batch_id)
                            │  reaches merge_batch_size / timeout / manual (auto-merge only when ingest_mode=auto)
                            ▼
                  merge publication (atomic transaction)
                            │
                            ▼
              immutable Master vN (production read pointer)
                            │
                            ├─▶ retrieval chunks (title/paragraph-aware segmentation, 900 chars / 120 overlap)
                            └─▶ relation graph (documents/titles/tags/links + 5-signal related edges)
```

- **Agents read Master only**; every modification first becomes a Change, then merges — never a direct write.
- **Optimistic concurrency**: each pending Change carries a `revision`; modifications are validated with `expected_revision` to prevent overwriting another editor (mismatch returns HTTP 409 `revision_conflict`).
- **Conflict ledger**: a stale base (`stale_base_version`) or two Changes touching the same path in one batch (`concurrent_path_update`) is recorded in `knowledge_conflicts` with **latest-submitted-wins**, keeping resolution evidence (queryable at `/conflicts`).
- **Tombstone**: deletion is published through a delete Change; the deletion record is written to `knowledge_tombstones` instead of erasing live content.
- **Immutable versions**: historical versions stay independently retrievable and reviewable (`/versions/:version`, `/documents?version=`, `/document?path=&version=`, `/graph?version=`).

## 2. Imports

| Method | Description |
| --- | --- |
| "Document import" tab | Upload MD / TXT / PDF (PDF via Python `pypdf`; scanned PDFs require OCR); check "Publish now" to merge |
| "Ingest queue" tab | LLM Wiki compilation entry: paste text / URL / document (see [WIKI.md](WIKI.md)); compilations of the same material are a batch of Changes sharing one `batch_id` |
| Text paste | `import` API `text` field enters a Change directly |

- A successful import = parse → Change (status=pending), **without polluting Master**; with `publish:true` it merges into a new version.
- **ingest_mode (per-KB)**: `review` (default) — compiled/imported output stays pending, reviewed **per batch** in "Pending merges" (edit/revert individually, reject the whole batch, or merge-publish); `auto` — auto merges and publishes when `merge_batch_size` (default 3) or `merge_interval_minutes` (default 60) is reached (suited to personal bases).
- **SHA256 deduplication**: identical content is skipped (`ingest_cache`); re-uploading the same content reports "duplicate content skipped"; pass `force:true` to force re-ingestion and re-run compilation.

## 3. Pages and metadata

Every document page carries metadata (stored versioned):

- `page_type`: entity / concept / source / comparison / synthesis / query / overview / index / log / purpose / schema / note / wiki
- `title`, `confidence` (EXTRACTED / INFERRED / AMBIGUOUS / UNVERIFIED), `sources[]` (traceability), `frontmatter`

> System pages (purpose/schema/index/log/overview) are real document pages and participate in version governance; a new knowledge base is seeded with 5 system pages; upgrading an old base seeds them as Pending Changes.
>
> **Degraded page**: when LLM compilation fails or no routable real Provider exists, a raw archive page `sources/<slug>.md` is generated (frontmatter marked `atlasgate-degraded: true`), excluded from retrieval by default; visible in search/ask with `include_raw:true`; later pass `force:true` on that material to re-run compilation, and the degraded page is replaced by the compiled page on success.

## 4. Retrieval (Hybrid by default)

- Default **hybrid page-level retrieval** (`ATLASGATE_RETRIEVAL_MODE=hybrid`): lexical bigram page retrieval (python worker) + local dense vectors (the `semantic_vectors` table, SQLite cosine) fused by **RRF**; it **automatically degrades to pure lexical** when no embedding service is configured (same as the old behavior).
- Dense vectors: `ATLASGATE_EMBEDDING_BASE_URL` points to any OpenAI-compatible `/v1/embeddings` — local ONNX `bge-small-zh` (`python/atlasgate_agent/embedding_worker.py`, default model `bge-small-zh-v1.5`, 512 dims), or an external API (DeepSeek's official API has no embedding model). `qdrant` is an optional pure-vector backend (`retrieval_mode=qdrant`).
- **Pseudo re-rank**: after RRF fusion, pages with higher graph related-edge degree (more central) get a small boost — it only breaks ties, never overturns the ranking.
- **Zero-evidence query rewrite**: when the first retrieval round returns 0 hits and routing reaches a real model, the LLM rewrites the question into a more retrievable form and retries once (`ATLASGATE_QUERY_REWRITE_ENABLED` on by default, skipped under mock routing); the response carries `rewritten_question`.
- **Wikilink multi-hop expansion**: pages pointed to by `[[wikilink]]` on first-round hit pages (up to 3) are folded into evidence automatically (`multihop:false` disables), with zero extra LLM calls.
- **Evidence sufficiency**: when evidence is insufficient the Agent says so explicitly (no fabrication); 0 hits in the first round returns an explicit "insufficient evidence" answer.
- **System pages** (index/log/purpose/schema/overview) and degraded pages are **excluded by default**; `include_system=true` / `include_raw=true` include them.
- Evidence returns `path / heading_path / chunk_index / score`, so the Agent can cite precisely down to a section; the response `retrieval_mode` reflects the actual mode (hybrid / semantic_qdrant / chunk / page).

## 5. Audit attribution (important)

`usage_logs` records every call; each request in "audit evidence" shows the **caller key name + prefix**, and internal calls are marked "internal call". Deleting a key never deletes its audit trail. The knowledge-side audit chain is equally complete in Change / merge / conflict ledger / tombstone / version summaries (author, time, batch, resolution).

## 6. Maintenance

- `POST /maintenance`: expired Memory forgetting, duplicate-document detection, due merges (auto mode only).
- Semantic index: `POST /semantic-index` manually rebuilds vectors for the current version (body may specify `version`); `GET /semantic-index` inspects the task.
- Lint: structural lint (orphan pages / broken links / index consistency, pure SQL, free) runs automatically at every publication; LLM-level lint (contradictions / staleness / data gaps) is triggered manually (`POST /lint`, `mode:"llm"`).
- Knowledge base deletion cascades all versions / Changes / indexes.

## 7. Query sedimentation and skills (ADR-015)

- **Query sedimentation**: `/api/agents/knowledge/ask` with `save_to_wiki:true` / `sediment:true` sediments explicitly; or automatically when the same/similar question is asked ≥3 times and the answer meets quality rules (≥2 cited sources, no "insufficient evidence", content ≥80 chars) (`ATLASGATE_QUERY_SEDIMENT_ENABLED` on by default).
- The output is `queries/<slug>.md` (with `sources[]` traceability + `[[wikilink]]` smart links to RRF-matched concepts//entities/ pages), going through the standard Change audit chain and following ingest_mode (review leaves it pending, auto publishes directly); **the same slug reuses the pending change** (no duplicate accumulation); sedimented pages can be edited / deleted / rolled back.
- **Citation heat**: pages cited in Agent answers accumulate `query_hits` (30-day window); graph nodes and hover cards show "Cited N times in Q&A".
- **Skill retrieval strategy**: SKILL.md frontmatter may declare a `retrieval` field (`top_k` / `multihop` / `include_raw` / `directories`); once attached it injects retrieval parameters (any of `multihop`/`include_raw` being true turns the feature on, `top_k` takes the max, `directories` is unioned); explicit caller parameters win; `DELETE /api/skills/:id` is supported.

## 8. Common pitfalls

- **Never edit Master documents directly**: editing creates an upsert Change (the correct path); deletion creates a delete Change.
- **Pending changes can be reverted/edited**: use `expected_revision` to prevent overwrites; merged Changes are immutable.
- **Batch merge semantics**: one merge publishes all pending Changes (the merge API has no "merge only this batch"; to cherry-pick, PATCH/DELETE individually, or reject the whole batch). Changes from the same LLM material share a `batch_id`; view per batch with `GET /changes` filtering.
- **Conflicts**: a stale base_version or two Changes touching the same path in one batch → conflict ledger (latest-submitted-wins), `GET /conflicts` shows the resolution evidence.

## 9. End-to-end reproduction (curl, copy-paste to reproduce)

> Verified against the default dev config: after `npm start`, console http://127.0.0.1:4310 (admin / atlasgate-admin, gateway Key `atlasgate-dev-key`). Admin `/api/*` uses cookie sessions; gateway `/v1/*` uses Bearer.

### 9.1 Import a document → inspect pending → merge-publish → list versions

```bash
# 0) Admin login (cookie session)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 1) Create a knowledge base (ingest_mode=review: output stays pending for human review)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"版本演示库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 2) Import a document (parse → pending Change, no Master pollution)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","author":"tester","data_base64":"IyDmnq/kupXlupXnn7Plo4EKCuWQkemhtuWkqeWcqOaer+S6leW6leWPkeeOsOWNiuWdl+efs+Wjge+8jOS4iumdouWIu+edgOaooeeziueahOe6uei3r+OAgui/meaYr+acrOefpeivhuW6k+eahOesrOS4gOS7vee0oOadkOOAggoKLSDlhbPplK7or43vvJrnn7Plo4HjgIHmnq/kupXjgIHnurnot68KLSDlvZLlsZ7vvJrmtYvor5XntKDmnZA="}'

# 3) Inspect pending changes (includes revision / batch_id / author)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -m json.tool

# 4) Edit the pending Change (optimistic concurrency: expected_revision prevents overwrites)
CHG=$(curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
curl -b cookies.txt -X PATCH "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes/$CHG" \
  -H 'content-type: application/json' \
  -d '{"content":"# 枯井底石壁（修订）\n\n向顶天在枯井底发现半块石壁。","expected_revision":1}'
# If expected_revision is stale (revision already advanced to 2 by someone else) → 409 revision_conflict

# 5) Merge-publish (merges all pending at once; returns new version number and conflict count)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'
# → {"kb_id":"...","version":2,"parent_version":1,"change_count":1,"conflict_count":0}

# 6) List versions (Master advanced to v2; v1 was the system-page version created with the base)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions" \
  | python3 -m json.tool
```

### 9.2 LLM ingest batch (batch_id) and the knowledge Agent

```bash
# LLM Wiki ingest (two-step compilation; under the default mock route it degrades to a sources/ raw archive page; the output shares one batch_id)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。"}'
sleep 3   # queue polls for compilation (ATLASGATE_WIKI_INGEST_POLL_MS default 2000ms; retry after a moment if still running)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -m json.tool   # this batch has author=wiki-compiler and shares one batch_id
# A review base needs a manual merge of this batch (one merge publishes all pending)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"发布摄入批次"}'
# Review queue (items the LLM flagged as "needs human judgment" — a separate track from Change-batch review)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/reviews?status=open"

# Hybrid retrieval (lexical + vector RRF; auto-degrades to pure lexical when no embedding is configured)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"枯井底 石壁","top_k":5}'

# Knowledge Agent question + explicit sedimentation (ADR-015)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What was found at the bottom of the dry well?\",\"save_to_wiki\":true}"
# Response includes sources[] / retrieval_mode / rewritten_question / saved_to_wiki (queries/ page; stays pending in a review base)
```

### 9.3 Optimistic concurrency / conflict ledger / tombstone / version retrieval

```bash
# Two upserts on the same path (same base_version) → merge records a concurrent_path_update conflict
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"alice","content":"# 修订 A\n\nAlice 的版本。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"bob","content":"# 修订 B\n\nBob 后提交，latest-submitted-wins。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"并发提交合并"}'
# → conflict_count=1 (Bob's change wins)

# Conflict ledger: inspect resolution evidence (earlier/winning change, reason, resolution)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts" \
  | python3 -m json.tool

# Deletion goes through a delete Change + tombstone (live content is never erased directly)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"delete","author":"tester"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"删除入门.md"}'
# The page is removed from Master; the deletion record is written to knowledge_tombstones (kept for audit; no standalone API — query the DB directly)

# Version retrieval: historical versions are immutable and independently reviewable (v2 still contained 入门.md; current Master has deleted it)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions/2" \
  | python3 -m json.tool
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=入门.md" --data-urlencode "version=2"
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=入门.md"   # deleted on current Master → 404 document_not_found
```

### 9.4 Gateway endpoints (Bearer key, unrelated to the /api admin side)

```bash
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## 10. Related docs

- [API](API.md) (all `/api/knowledge-bases/*` endpoints)
- [WIKI.md](WIKI.md) (LLM compilation, graph, md mirror sync)
- [Architecture](ARCHITECTURE.md) (versioning model details)
