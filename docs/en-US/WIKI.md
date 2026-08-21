# LLM Wiki

This module corresponds to console view 08 "Wiki Knowledge Base" and "Knowledge Versions" for ingest/review/Lint. **If you are looking for "where the saved md files are", start with Section 1.**

## 1. Where do Wiki pages live? (Important)

AtlasGate knowledge base pages live in the **SQLite database** (`knowledge_documents` table in `data/atlasgate.db`) — this is the single source of truth, because multi-user version governance, the conflict ledger, and audit require it. Two "file forms" exist on disk:

| Form | Location | Description |
| --- | --- | --- |
| **Automatic md mirror** | `knowledge/<kb-name>/` (project root) | Auto-synced after every publish; openable directly in Obsidian; includes `.obsidian/` config; **read-only mirror — do not edit directly** (edit via the console, which enters version governance as a Change) |
| **Exported zip** | Console "Export zip" button | Master snapshot package (with frontmatter), downloadable anywhere and openable with Obsidian/git |

- Sync timing: new knowledge base → immediately; every merge publish → automatic; service start → full catch-up sync; console "Sync md" button → manual.
- Deleted pages are removed from the mirror (tracked by manifest).
- Disable the mirror: `ATLASGATE_WIKI_SYNC_DIR=""`; change directory: `ATLASGATE_WIKI_SYNC_DIR=/path/to/vault`.
- To manage the wiki with git: the directory is gitignored by default; use `git add -f knowledge/`.

**Copy-paste runnable**: sync the md mirror and export a zip (admin `/api/*` uses cookie sessions; `$KB` reuses the id returned by the KB creation example in Section 4):

```bash
# Manually trigger sync (every merge publish auto-syncs; this command is for manual catch-up, returns files/removed stats)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/sync" \
  -H 'content-type: application/json' -d '{}'

# Mirror directory: knowledge/<kb-slug>/ (includes .obsidian/ config and .atlasgate-manifest.json deletion tracking)
ls knowledge/wiki-demo/

# Export the Master snapshot zip (includes frontmatter; open directly with Obsidian after unzip)
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head
```

## 2. Three-layer model (Karpathy methodology)

```text
Raw Sources (immutable) -> wiki_sources table
        | LLM compilation (two steps)
        v
Wiki (LLM-maintained Markdown pages) -> knowledge_documents table (versioned) + knowledge/ mirror
        | obeys
        v
Schema (conventions and purpose) -> schema.md / purpose.md (editable; edits go through Change)
```

## 3. Page types

| Directory | type | Purpose |
| --- | --- | --- |
| `entities/` | entity | People / organizations / products / tools |
| `concepts/` | concept | Theories / methods / techniques |
| `sources/` | source | A summary page per source (`sources[]` provenance); **degraded raw archive pages live here too** (marked with `atlasgate-degraded: true`) |
| `comparisons/` `synthesis/` `queries/` | comparison/synthesis/query | Comparisons, syntheses, saved Q&A |
| Root | purpose/schema/index/log/overview | System pages (**index/log/overview are maintained by the compile pipeline after every ingest**; purpose/schema are edited collaboratively by human + LLM) |

Every page carries frontmatter: `type / title / sources[] / confidence / tags` (system navigation pages such as index/log/overview use `sources: []`).

**Compiled pages vs raw archives (degraded pages)**: after a successful two-step compilation, the written result is a **compiled page** (LLM-summarized knowledge that participates in normal queries); when the model is unavailable or compilation repeatedly fails, the pipeline degrades to a **raw archive page** (`sources/<slug>.md`, frontmatter carries `atlasgate-degraded: true`). Degraded pages do **not participate in default retrieval** (to avoid treating raw chunks as "compiled knowledge"), but they remain searchable in the Wiki (visible in search/query with `include_raw:true`); you can later check "force re-ingest" for that source to rerun compilation — on success, the degraded page is replaced by the compiled page.

## 4. Two-step compilation pipeline (Ingest)

```text
enqueue (paste/URL/document) -> SHA256 dedup -> ① analysis (LLM: entities/concepts/contradictions/page plan)
-> ② generation (LLM: writes pages with frontmatter) -> validation (path whitelist/secret drop/page budget)
-> batch Change (author=wiki-compiler, shared batch_id) -> review or auto merge
-> derived Review items / Research tasks / log update
```

- **No real Provider**: degrades to "source archive + raw page" (works offline).
- **LLM compilation failure fallback**: when the model repeatedly returns empty completions/truncated JSON, the pipeline automatically degrades to "raw archive page" (wiki_log records the reason); sources are never lost; afterwards you can check "force re-ingest" to retry.
- **Page budget**: ≤ `ATLASGATE_WIKI_MAX_PAGES_PER_SOURCE` per source (default 20).
- **System page maintenance**: on every successful compilation, the pipeline **must** also update `index.md` (TOC: one line link + summary per new page), `log.md` (timeline: `## [date] ingest | title`), and `overview.md` (global overview) — all three enter version governance with the same batch Change. This is the mechanism by which "navigation is continuously maintained by the compiler" (the index/log convention of the Karpathy methodology).
- **Security**: pages containing private keys/`sk-` secrets are dropped; path escapes are dropped; missing frontmatter is logged as a defect.
- **Dedup**: identical content is skipped (`ingest_cache`). **Re-uploading the same content reports "duplicate content skipped"** — if the previous compilation failed or you want to recompile, check "force re-ingest" in the ingest form or pass `force:true` in the API to bypass dedup and re-enqueue.
- **Failure retry**: queue failures auto-retry ≤2 times; pending work recovers after crash restart.

**Copy-paste runnable** (default dev config `npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin): paste ingest → watch queue/pages → force re-ingest → publish:

```bash
# 1) Login (admin API uses cookie sessions)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Create KB (ingest_mode=review: compiled output stays pending for manual review; use an ASCII name to avoid 500 on export zip filenames)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"wiki-demo","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) Paste a source -> enqueue (HTTP 202; resubmitting identical content returns skipped:true / reason:duplicate_content)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well, carved with the side effects of the anchor-detach technique: qi backlash."}'

# 4) Ingest queue: pending -> running -> done (serial per KB; failures auto-retry <=2 times)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5" \
  | python3 -m json.tool

# 5) Pages: in review mode this lists Master pages (system pages); the two-step compiled output is pending Changes,
#    visible in /changes (real model -> entities//concepts/ compiled pages; mock only -> sources/source.md degraded page);
#    they appear in /pages only after merge publish
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages" \
  | python3 -c 'import json,sys; [print(p["path"], p["page_type"]) for p in json.load(sys.stdin)]'

# 5b) Compiled output batch: shared batch_id, author=wiki-compiler (includes index/log/overview system page updates)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -c 'import json,sys; [print(c["path"], c["batch_id"], c["author"]) for c in json.load(sys.stdin) if c["status"]=="pending"]'

# 6) Force re-ingest: force:true bypasses SHA256 dedup and re-enqueues (use when the previous compilation failed / you want to recompile)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well, carved with the side effects of the anchor-detach technique: qi backlash.","force":true}'

# 7) Manually publish in a review KB (auto KBs auto-merge on merge_batch_size/interval); structural Lint and md mirror sync run automatically after publish
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"Publish Wiki compiled output"}'
```

## 5. Retrieval (Hybrid: lexical + local vectors, RRF fusion)

Knowledge Agent queries default to **Hybrid page-level retrieval** (`retrieval_mode="hybrid"`, RAG_PLAN.md / ADR-012):

```text
question
  -> Node vector retrieval (whole-page hits, semantic_vectors table + cosine)
  -> python lexical retrieval (bigram vocabulary overlap, _retrieve_pages)
  -> RRF fusion (score = sum 1/(60 + rank), zero-weight tuning)
  -> top-k whole-page evidence -> LLM (with [1][2] citations)
```

- **Lexical hits**: proper nouns, exact wording; **vector hits**: synonymous rewrites, semantically similar pages (asking about "pill backlash" can surface a page about "anchor-detach side effects").
- **Page-level**: one vector per page (`semantic_vectors` table, versioned); system pages and degraded archive pages are excluded (`include_system` / `include_raw` opt in).
- **Degradation**: automatically falls back to pure lexical when no embedding service is configured (identical to old behavior); `retrievalMode=local` disables vectors explicitly.
- **Deploying embedding (optional)**: start the local ONNX service with `python3 python/atlasgate_agent/embedding_worker.py --model <bge-small-zh dir>`, set `ATLASGATE_EMBEDDING_BASE_URL=http://127.0.0.1:8031/v1`; or connect any OpenAI-compatible `/v1/embeddings` API. DeepSeek has no official embedding model.
- **Pure vector**: `retrievalMode=qdrant` (requires a Qdrant service; kept as an optional backend).
- **Pseudo-rerank (stage 2)**: after RRF fusion, pages with higher graph related-edge degree (more central) receive a small boost — it only breaks ties, never overturns ranking (zero new dependencies).
- **Low-confidence query rewrite (stage 2)**: when the first retrieval round returns 0 hits and routing goes to a real model, the LLM rewrites the question into a more searchable form and retries once; the result is returned as `rewritten_question` (`ATLASGATE_QUERY_REWRITE_ENABLED` on by default, skipped automatically under mock routing).
- **Multi-hop expansion (stage 3)**: pages pointed to by `[[wikilink]]` in first-round hit pages (up to 3) are merged into the evidence automatically (`expansion="linked"`), zero extra LLM calls — the link graph is a springboard when assembling answers across pages (`multihop:false` disables this).
- **Evidence sufficiency (stage 3)**: the Agent is instructed to say so explicitly when the evidence is insufficient; a 0-hit first round returns an explicit "insufficient evidence" answer (no fabrication).
- The legacy chunk retrieval (BM25+vectors) is kept as an explicit fallback under `retrieval_mode="chunk"`.

## 6. Review and publication

- `ingest_mode=review` (default): compiled output stays Pending; view it by **batch** in "Changes to merge", edit/revert items individually, **reject the whole batch**, or merge-publish.
- `ingest_mode=auto`: auto merge-publish (suitable for personal KBs).
- Review queue: items the LLM flagged as "needs human judgment" (verify / create page / research); mark done, ignore, or process all.

## 7. Graph (enterprise-grade interaction)

- **Force-directed layout**: node size scales with the square root of link count, community coloring, related edges colored and thickened by weight.
- **Interaction**: drag a single node (position memory) / drag blank space to pan / scroll to zoom / hover preview card (name/path/type/degree/community) / click to select details ("Open page" in Wiki view) / search box to locate / minimap / fit button / title node toggle.

**Copy-paste runnable** (graph data + citation heat, `$KB` from the Section 4 example):

```bash
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); \
print("nodes:", len(d["nodes"]), "edges:", len(d["edges"])); \
print("communities:", [(c["id"], c["members"], c["cohesion"]) for c in d["communities"]]); \
print("insights:", {k: len(v) for k, v in d["insights"].items()}); \
print("query_hits:", [(n["document_path"], n["query_hits"]) for n in d["nodes"] if n["kind"]=="document" and n["query_hits"]>0])'
```

## 8. Lint health check

- Structural (orphan pages / broken links / index consistency) is pure SQL, free, and **runs automatically on every publish**; LLM-level (contradictions / staleness / data gaps) requires a real model and is triggered manually.
- Reports can be acked/ignored; missing_page reports support **one-click stub page creation** (via Change).

## 9. Q&A sedimentation (save_to_wiki / auto-sediment, ADR-015)

Sediment explicitly when the Knowledge Agent answers by checking "Save to Wiki" (or API `save_to_wiki:true` / `sediment:true`); **or automatically**: when the same/similar question has been asked ≥3 times and the answer meets quality rules (≥2 cited sources, no "insufficient evidence", substantive content). The output is `queries/<slug>.md` (with `sources[]` provenance + `[[wikilink]]` smart links to matching concept/entity pages), going through the standard Change audit chain (review leaves it pending, auto publishes directly), and is **editable, deletable, and rollback-able**. Switch: `ATLASGATE_QUERY_SEDIMENT_ENABLED` (on by default).

**Citation heat (memory is usage trace)**: every page cited by an Agent answer accumulates `query_hits` (30-day window); graph nodes and hover cards show "cited N times by Q&A", for identifying high-usage knowledge pages.

**Copy-paste runnable** (explicit sedimentation + citation heat, `$KB` from the Section 4 example):

```bash
# Ask and explicitly save back: the response includes saved_to_wiki (sediments to queries/<slug>.md; review KBs leave it pending through the audit chain)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What are the side effects of the anchor-detach technique\",\"save_to_wiki\":true}"

# A pending change with the same slug is updated in place, no duplicate accumulation (Q6A)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What are the side effects of the anchor-detach technique\",\"save_to_wiki\":true}"

# Citation heat: query_hits accumulate on pages cited by answers (30-day window), visible on graph nodes
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); \
print([(n["document_path"], n["query_hits"]) for n in d["nodes"] if n["kind"]=="document" and n["query_hits"]>0])'
```

## 10. Related docs

- [GETTING_STARTED.md](GETTING_STARTED.md) (hands-on "where are the KB md files")
- [KNOWLEDGE.md](KNOWLEDGE.md) (version governance details)
- [API.md](API.md) (`/ingest`, `/sync`, `/export`, `/lint`, `/reviews` endpoints)
- Methodology source: [references/karpathy-gist.md](../references/karpathy-gist.md)
