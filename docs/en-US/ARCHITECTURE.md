# AtlasGate Architecture

## 1. Design goals

The first release chooses a modular monolith instead of splitting microservices immediately. The reason: the gateway, knowledge publishing, and Agent runtime share many domain contracts that need to stabilize first; inside a single process the data model, failure semantics, and audit boundaries can be validated at low cost. Each module interacts only through service interfaces and database tables, and can be split later as shown below.

| Current module | Future service boundary | Split trigger |
| --- | --- | --- |
| `GatewayService` | gateway-plane | Multi-instance traffic, independent scaling, SSE long connections |
| `KnowledgeService` | knowledge-control + index-worker | Document volume exceeds single-machine indexing, more async ingest jobs |
| Python `atlasgate_agent` + Node adapter | agent-runtime | Multiple harnesses, long-running tasks, human approval nodes |
| `PlatformService` | evidence-query | Audit retention period and query load affect the data plane |

## 2. Gateway routing

The routing order is fixed:

1. Authenticate and check Scope, model whitelist, RPM/TPM, Key/team/organization quotas.
2. Scan message content for capability requirements and risk signals.
3. Build candidates by explicit `provider:model`, exact model, or `auto`.
4. Drop Providers that do not support requested capabilities such as vision before scoring.
5. Compute quality, cost, latency, reliability, and a tiny stable affinity using profile weights.
6. Pick an available Key from the Provider credential pool by weight, skipping over-quota or cooled-down credentials.
7. Persist candidates and selection reasons, call Providers in bounded candidate order; 429/5xx trigger Failover.
8. Persist every attempt, usage, latency, risk level, and error.

The four profiles `quality`, `balanced`, `economy`, `latency` are versioned policy inputs only; they are never auto-trained or weight-changed inside the request path.

Reproducible example (gateway side uses a Bearer Key, no login needed):

```bash
# Model list
curl http://127.0.0.1:4310/v1/models \
  -H "Authorization: Bearer atlasgate-dev-key"

# Chat Completions (answered offline by the built-in atlas-mini mock under the default config)
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## 3. Knowledge version model

`knowledge_bases.master_version` is the production read pointer. `knowledge_changes` stores the `base_version`, path, operation, author, revision, and time of every independent modification. Publication happens when `merge_batch_size` is reached, `merge_interval_minutes` is exceeded, or on manual action.

The merge transaction executes:

1. `BEGIN IMMEDIATE` locks the current publish action.
2. Copy the current master documents to `vN+1`.
3. Apply changes old-to-new by `created_at,rowid`.
4. Mark a conflict when the baseline is not the current master, or the same path is modified twice within the same batch.
5. Later-applied accepted changes overwrite older values.
6. Record the conflict winner, reason, latest-submitted-wins resolution, and delete tombstones.
7. Rebuild the `vN+1` retrieval slices, indexes, and knowledge relation graph.
8. Atomically update the master pointer and commit the transaction.

This strategy lets online Agents keep reading the complete `vN` throughout publication and never observe a half-updated state. Current latest-wins is an explicit business policy, not a universal truth; high-risk knowledge bases should add reviewer/approval states and domain-level merge functions.

Reproducible example (admin-side cookie session; `$KB` takes the id returned by KB creation):

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Sample KB","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# Import material → pending Change; inspect Changes and the conflict ledger
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"intro.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUgSW50cm9kdWN0aW9uCgpBdGxhc0dhdGUgaXMgYW4gb3Blbi1zb3VyY2UgTExNIGluZnJhc3RydWN0dXJlIGZvciBzbWFsbCBlbmdpbmVlcmluZyB0ZWFtczogYW4gb3BlbiBnYXRld2F5ICsgYSBsb2NhbC1maXJzdCBMTE0gV2lraSArIGEga25vd2xlZGdlIEFnZW50Lgo=","author":"tester"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts"

# merge publish → Master v2; version list and graph are traceable per version
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"First publish"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions"
```

## 4. Retrieval

### 4.1 LLM Wiki pages and chunk boundaries

Knowledge bases use the LLM Wiki style page model: the Markdown file path is the page ID, the heading hierarchy is the page table of contents, `[[WikiLink]]`/relative links are page references, and frontmatter/body tags are reusable entities. Pages, headings, tags, and references enter the versioned relation graph; the graph is not drawn by character count, and every retrieval chunk is not forced into a graph node.

When Master is published, page content generates retrieval chunks. The splitter first recognizes heading and paragraph boundaries, then aggregates within the same heading path; any single paragraph exceeding the maximum length is hard-split at the max character count with limited overlap. Each `knowledge_chunks` record contains:

- `chunk_index`: stable 0-based order within the page;
- `heading_path`: the heading hierarchy path, e.g. `Operations / Alert handling`;
- `char_count`: the character count of the stored content;
- `content`: the text used for BM25 or Embedding.

Defaults are `maxChars=900`, `overlap=120`. These boundaries give page structure, the relation graph, and the retrieval index each a single responsibility: the graph for navigation and entity relations, chunks for recall and evidence locating.

Retrieval defaults to **hybrid** (`ATLASGATE_RETRIEVAL_MODE=hybrid`, ADR-012): two signals are fused on the Python side with RRF —

- lexical: Chinese bigram page-level scoring (python `_retrieve_pages`), pure SQL, zero dependencies;
- vector: page-level dense vectors stored in the `semantic_vectors` table (SQLite, in-process cosine similarity), produced by the local ONNX `bge-small-zh` service (`python/atlasgate_agent/embedding_worker.py`, exposing an OpenAI-compatible `/v1/embeddings`) or any OpenAI-compatible embedding API (`ATLASGATE_EMBEDDING_BASE_URL`).

The fusion formula `score(p) = Σ 1/(60 + rank)` (RRF, k=60) dedupes and takes top-k whole pages as evidence, then applies a **pseudo-rerank** (graph degree breaks ties, `_rerank_by_graph_degree`). When no embedding is configured, `semanticIndex.enabled()=false` and retrieval auto-degrades to pure lexical (same as legacy behavior); `qdrant` is an optional pure-vector backend: vectors are generated in batches and collections are created per knowledge base and Master version, `semantic_index_jobs` records model, dimensions, status, and failure reason, and this mode does not silently degrade on failure.

Later RAG stages (see RAG_PLAN) layer on top of this: zero-evidence query rewrite (`ATLASGATE_QUERY_REWRITE_ENABLED`, on by default; when the first round has no hits a real LLM rewrites and retries once), WikiLink multi-hop expansion (the `[[wikilink]]` targets of first-round hit pages join the candidates for one more re-rank round, zero extra LLM calls), and evidence sufficiency (when evidence is insufficient the answer says so explicitly, never fabricates).

Reproducible example (hybrid retrieval and semantic index; `$KB` continues from the KB created above):

```bash
# Hybrid retrieval (lexical + vector RRF); the response contains each component
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"stone wall clue","top_k":5}'

# Build the semantic index for the current Master (returns 400 when embedding is not configured)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'
```

## 5. Agent, Skills, and Memory

The knowledge Agent's core runtime uses Python; Node keeps the gateway and HTTP control plane. A fixed-size resident Python worker pool receives requests over JSON Lines, with a bounded queue, timeouts, crash replacement, request-count recycling, and graceful shutdown. Python reads the same SQLite snapshot; in Qdrant mode Node supplies precomputed semantic evidence consistent with the current Master version. Node then completes model routing, Provider calls, and audit writes.

The knowledge Agent harness is:

```text
validate -> retrieve master -> optional memory recall -> load attached skills
         -> build governed prompt -> route model -> validate citations -> ledger
```

The local mock Provider uses an extractive fallback instead of pretending to be model inference. Once a real Provider is configured, the Agent reuses the same gateway and routing evidence.

Memory reads and writes share one hard condition: this request has `use_memory === true`. Memory is session-scoped and stores sanitized summaries with the source run id. When disabled, neither reads nor writes happen.

Skills are a local versioned registry supporting attach/detach, enable/disable, recommendation, usage events, versions, and multi-skill merging; `DELETE /api/skills/:id` is supported. SKILL.md frontmatter can declare a structured `retrieval` field (`top_k` / `multihop` / `include_raw` / `directories`); once attached it injects retrieval parameters into the Agent request — `multihop`/`include_raw` are enabled when either is true, `top_k` takes the maximum across all active skills, `directories` takes the union; explicit caller parameters take precedence (ADR-015 C). Memory records type, scope, importance, expiry, recall count, and replacement/forgetting events. The future online platform still needs signatures, eval sets, merge lineage, rollback, and organization policies; un-evaluated self-evolving results must not go straight to production.

Reproducible example (the full chain of one ask, with retrieval parameters and skill injection):

```bash
# Ask (explicit sedimentation + Memory session; response contains answer / sources / retrieval_mode / rewritten_question / saved_to_wiki)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"use_memory\":true,\"session_id\":\"demo-1\",\"save_to_wiki\":true}"

# A skill declares a retrieval strategy (ADR-015 C) and gets attached
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-8","description":"Deep retrieve 8 pages","instructions":"Answer from evidence","retrieval":{"top_k":8,"multihop":true}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'
```

## 6. Document ingestion and the relation graph

MD/TXT use strict UTF-8 decoding; PDFs extract text with `pypdf` in a separate Python worker. Uploads first enter `knowledge_imports`; once parsed successfully they generate a normal Change, so they share review, conflict, and publish semantics with manual edits. Scanned PDFs explicitly require OCR later; no silent empty documents are produced.

The graph of each Master is built from documents, Markdown headings, frontmatter/body tags, relative links, and `[[WikiLink]]`s. Nodes and edges carry version numbers, and historical versions can be read independently.

## 7. Knowledge modification and deletion

- Knowledge base: name, description, and merge policy can be modified; deletion cascades to clean up all versions, Changes, and indexes via foreign keys.
- Pending Change: content, path, and author can be modified; a Change can also be reverted.
- Merged Change / Version: immutable as audit evidence.
- Master documents: edits generate `upsert Changes`; deletions generate `delete Changes`. Both must pass merge before the production read pointer changes.

## 8. Security boundaries

- Provider Keys are stored server-side only; the control plane returns only `has_api_key`.
- The request ledger keeps only a truncated, sanitized prompt preview.
- risk mode can block requests that leak private keys / API Keys.
- Client Keys are stored only as SHA-256 hashes; plaintext is returned only at issuance.
- The console is currently only suitable bound to `127.0.0.1`; external deployments must add control-plane identity authentication first.

## 9. LLM Wiki three-layer model (Phase 0 baseline)

Knowledge bases evolve into three layers per the Karpathy LLM Wiki methodology: **Raw Sources (immutable material layer) → Wiki (LLM-maintained Markdown pages) → Schema (conventions and purpose)**. The current version (0.4.0) has landed the data contracts, system pages, and the complete LLM compile pipeline (Ingest / Lint / query sedimentation, see §10–§11).

- Every knowledge base owns five system pages (`purpose.md` / `schema.md` / `index.md` / `log.md` / `overview.md`); they are real document pages that participate in version governance. New knowledge bases publish directly at v1; existing knowledge bases are seeded with pending Changes on upgrade. `index.md` / `log.md` / `overview.md` are auto-maintained by the compile pipeline; `purpose.md` / `schema.md` are human-collaborated (staged as Changes through the `PUT` interface).
- `knowledge_documents` gains page metadata columns: `page_type` (entity/concept/source/comparison/synthesis/query/overview/index/log/purpose/schema/note/wiki), `title`, `frontmatter_json`, `confidence` (EXTRACTED/INFERRED/AMBIGUOUS/UNVERIFIED), `sources_json` (provenance). Existing documents infer their type from the path.
- New tables carry the wiki workload: `wiki_sources` (immutable material), `ingest_queue`/`ingest_cache` (ingest queue and SHA256 dedup), `review_items` (async human review), `lint_reports`, `research_jobs`, `wiki_log` (persisted mirror of log.md).
- Retrieval excludes system pages by default (Q11); `include_system=true` includes them explicitly. schema/purpose modifications go through the `PUT` interface and are staged as Changes, never written directly to Master.
- Ingest mode is per-KB: `ingest_mode=review` (default; compiler output stays pending for human review) or `auto` (output merged and published directly); `force:true` forces re-ingest (bypasses SHA256 dedup).
- Frontmatter parsing/serialization stays behavior-consistent on both ends — `src/core/frontmatter.js` and `python/atlasgate_agent/frontmatter.py` — and is the contract basis for page metadata and the later compile pipeline.

## 10. LLM Wiki compile pipeline (Phase 1)

- A persisted ingest queue (`ingest_queue`) is consumed serially (one running job per knowledge base at a time); after a crash it restores to pending on startup and failures auto-retry ≤2 times; SHA256 dedup (`ingest_cache`), `force:true` forces re-ingest.
- Two-step compilation: ① analysis (Python reads wiki context to assemble a prompt → Node calls the gateway LLM → structured analysis JSON) → ② generation (the same chain produces page JSON) → Node validation (path whitelist, required frontmatter, confidence enum, key/path escalation dropped, page budget ≤ `maxPagesPerSource`) → staged as Changes with `author=wiki-compiler` + `batch_id` → derives `review_items` / `research_jobs` → auto-merges when `ingest_mode=auto` (in review mode the console reviews by `batch_id` batches).
- `merge()` derives `page_type/title/confidence/sources_json` from content frontmatter at publish, keeping compiler page metadata with the version.
- Without real model routing (mock only), ingest degrades to "material archive + raw text as page" (Q6): the degraded page carries the `atlasgate-degraded` marker and is excluded from retrieval by default (visible only with `include_raw=true`); the offline demo chain is unaffected. URL ingest uses the built-in lightweight HTML→text fetch.
- `compile_model` can be overridden per knowledge base; empty means the gateway `auto` route (Q10). Deep Research jobs are only persisted as a reservation; execution lands in a later phase (D6).

Reproducible example (ingest → queue → artifacts; without a real model it auto-degrades to raw archive pages):

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"material.md","text":"Xiang Dingtian found half a stone wall at the bottom of a dry well."}'

# Inspect the ingest queue and published pages
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages"

# Force re-ingest (bypasses SHA256 dedup)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"material.md","text":"Xiang Dingtian found half a stone wall at the bottom of a dry well.","force":true}'
```

## 11. Lint and query sedimentation (Phase 2)

- Structural lint (orphan pages, broken links, index consistency) is pure SQL with zero token cost, auto-run **after every merge publish** via `knowledge.publishHooks` (Q17-B); system pages are excluded from orphan/broken-link determination, and reports are deduped by (kb, kind, paths, open).
- LLM-level health checks (contradictions, stale claims, missing pages, data gaps) are manually triggered (`lint.py` assembles a prompt → gateway LLM → report persisted) and need a real model Provider; the report lifecycle is open → acked/fixed/dismissed, and `missing_page` reports can "one-click create" a stub page Change.
- Query sedimentation / Q&A sediment (D8 + ADR-015 A): explicit `save_to_wiki` / `sediment`, or ≥3 similar questions (bigram Jaccard ≥0.3 over the last-30-day `agent_runs` history) plus quality rules (≥2 source citations, no "insufficient evidence" marker, content ≥80 characters) auto-sediment. Answers are deterministically assembled as `queries/<slug>.md` (frontmatter carries `sources[]` provenance), first matched against `concepts/`/`entities/` pages with hybrid RRF — a strong match associates via `[[wikilink]]` (never rewriting human-maintained pages), otherwise it lands in `queries/` — then staged as a Change following `ingest_mode` (review stays pending, auto merges and publishes); a pending change with the same slug is updated in place rather than stacking (Q6A); `ATLASGATE_QUERY_SEDIMENT_ENABLED` is on by default; sedimented pages are normal wiki pages — editable, deletable, rollback-able.

## 12. Graph enhancements and Wiki browsing (Phase 3)

- **5-signal relevance**: page-level `related` edge weight = direct links ×3 + material overlap ×4 + Adamic-Adar ×1.5 + type affinity ×1.0 + lexical overlap ×1.5 (`src/core/relevance.js`), written into the versioned graph on every rebuild; old versions lazily rebuild on read (`ensureRelatedEdges`).
- **Pure-JS Louvain** (`src/core/louvain.js`, ADR-010 zero npm deps): deterministic community detection; the degree sum and original m run through recursive aggregation, outputting the community of every page.
- **Citation heat** (ADR-015 B): graph nodes carry `query_hits` (Q&A citation count, last-30-day window); the console tints by citation frequency — memory is the usage trace of knowledge, no extra memory nodes are created.
- **Insights** (`src/services/insights.js`): orphan pages (degree ≤1), sparse communities (cohesion <0.15 and ≥3 pages), bridge nodes (connecting ≥3 communities), unexpected cross-community connections.
- `graph()` response adds `communities` (member count/cohesion) and `insights`; document nodes carry `community`; the console colors the graph by community and draws `related` edge thickness by weight.
- The console adds a "Wiki knowledge base" three-pane view: page directory tree / Markdown reading (frontmatter badges, confidence, `sources[]` provenance, wikilink navigation, edits go through Changes) / graph + communities + insights.

Reproducible example (graph + citation heat):

```bash
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits|community)"' | head
```

## 13. Export and ecosystem (Phase 4)

- **Read-only zip export** (Q8): `GET /api/knowledge-bases/:id/export` packages Master pages into an Obsidian-compatible Markdown vault (with `.obsidian/` minimal config, README, frontmatter preserved), using the zero-dependency ZIP writer in `src/core/zip.js` (store mode). Two-way directory sync is a future enhancement.
- **md mirror**: `knowledge/<kb>/` is a one-way Markdown mirror generated after publish (directly openable in Obsidian, gitignored); `POST /api/knowledge-bases/:id/sync` manually triggers a rebuild.
- **Deep Research interface reserved** (D6): `research_jobs` derived at ingest (topic + pre-generated queries) are only persisted and queryable; the execution engine (Tavily/SerpApi/SearXNG) is plugged in on demand.
- **URL ingest** (Q16) landed in Phase 1 with the compile pipeline (built-in HTML→text fetch); the Web Clipper browser extension is an optional follow-up (see `docs/WEB_CLIPPER.md`); DOCX/XLSX/EPUB multi-format parsing stays optional per D5.

Reproducible example (mirror sync and ZIP export):

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/sync" \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head
```

See [architecture decisions](DECISIONS.md) for the reasons behind these choices.
