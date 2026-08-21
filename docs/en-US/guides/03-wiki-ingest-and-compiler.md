# Document Ingest and LLM Wiki Compilation

> IDs: `KB-002`, `WIKI-001`  
> Status: `implemented` (v0.4.0)

## Purpose and boundary

Ingest stores MD, TXT, text PDF, URL, or pasted content as an immutable raw source and compiles it into frontmatter-bearing Wiki pages. Without a real Provider, the system explicitly degrades to a raw archive page instead of pretending to have produced an LLM summary.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTTP | `src/app.js` | `/import`, `/ingest`, `/ingest-queue`, `/ingest-queue/:jobId/cancel\|retry`, `/sources`, `/reviews`, `/research-jobs` | Receives sources, compile requests, and queue/review APIs |
| Parser | `src/services/document-parser.js` | `parse()` | Validates UTF-8, MD/TXT/PDF |
| Queue | `src/services/ingest-queue.js` | `create()`, `claimNext()`, `fail()`, `recoverRunning()` | Bounded, serial, persistent ingest queue (failures retry ≤2, restart recovery) |
| Compiler | `src/services/wiki-compiler.js` | `enqueue()`, `ingestOne()`, `validatePages()`, `degradeIngest()` | SHA256 dedup, two-step compilation, validation, degradation, system page maintenance |
| Sediment | `src/services/wiki-compiler.js` | `saveQueryAnswer()`, `autoSediment()` | ADR-015: Q&A sedimentation and `[[wikilink]]` smart categorization |
| Metadata | `src/core/frontmatter.js` | `parseFrontmatter()` | Page contract |
| Publication | `src/services/knowledge.js` | `submitChange()`, `merge()` | Unified review and version governance |

## Compile flow

```text
raw source -> SHA256 dedup (ingest_cache; force:true bypasses)
  -> ingest queue (serial per KB, failures retry <=2, restart recovers pending)
  -> ① analysis: entities/concepts/contradictions/page plan (LLM)
  -> ② generation: page JSON (LLM)
  -> validation: path, frontmatter, secret, page budget (Node is authoritative)
  -> batch Change(batch_id, author=wiki-compiler)
  -> derived Review items / Research tasks + maintain index/log/overview system pages
  -> review leaves pending or auto merges
  -> after publish: structural Lint runs automatically, md mirror syncs (semantic_vectors rebuilt depending on embedding config)
```

Only one job runs per knowledge base at a time. Failed jobs retry at most twice, and pending work is recovered after a process restart. Without a real Provider or when compilation fails, the pipeline degrades to "raw archive page" (`sources/<slug>.md`, frontmatter carries `atlasgate-degraded: true`) — sources are never lost.

## Security and degradation

- Raw sources are stored via `wiki_sources`; the content hash is used for dedup.
- Private keys, `sk-` strings, and path escapes in generated output are dropped.
- When the LLM is unavailable, a `sources/<slug>.md` degraded page is generated and the reason is recorded.
- Degraded raw pages do not participate in retrieval by default; `include_raw` opts in explicitly.
- Degraded pages carry the `atlasgate-degraded: true` marker; after configuring a real model, re-ingest with `force:true` — a successful compilation replaces the degraded page with the compiled page.
- `review` is the default publication policy; `auto` is only suitable for low-risk personal KBs.

## Verification

```bash
npm test    # full suite: Node 92 + Python 19, zero npm runtime dependencies
node --test test/wiki-phase0.test.js test/wiki-phase1.test.js test/wiki-phase4.test.js   # system pages / two-step compile / queue / research tasks
python -m unittest discover -s python/tests -v   # Python-side ingest analysis/generation prep and lint
```

## End-to-end reproduction (paste ingest → queue/pages → force re-ingest → publish)

Verified against the default dev config (`npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin). Admin `/api/*` uses cookie sessions (log in first to get the cookie, then reuse it with `-b cookies.txt`):

```bash
# 1) Login
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Create KB (ingest_mode=review: compiled output stays pending for manual review; use an ASCII name to avoid 500 on export zip filenames)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"compile-demo","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) Paste a source -> enqueue (HTTP 202; resubmitting identical content returns skipped:true / reason:duplicate_content)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well, carved with the side effects of the anchor-detach technique: qi backlash."}'

# 4) Ingest queue: pending -> running -> done (serial per KB, failures auto-retry <=2 times)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5" \
  | python3 -m json.tool

# 5) The two-step compiled output is a pending Change sharing batch_id with author=wiki-compiler:
#    real model -> entities//concepts/ compiled pages + index/log/overview system pages;
#    mock only -> sources/source.md degraded raw archive page (atlasgate-degraded: true)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -c 'import json,sys; [print(c["path"], c["status"], c["batch_id"], c["author"]) for c in json.load(sys.stdin) if c["status"]=="pending"]'

# 6) Master pages: in review mode this lists only published pages (system pages); compiled pages appear in /pages after merge
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages" \
  | python3 -c 'import json,sys; [print(p["path"], p["page_type"]) for p in json.load(sys.stdin)]'

# 7) Degraded page check (only exists in the mock degradation scenario; absent after a successful real compile):
#    frontmatter carries atlasgate-degraded: true, excluded from retrieval by default (include_raw opts in)
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=sources/source.md" | python3 -m json.tool | grep -i degraded

# 8) Force re-ingest: force:true bypasses SHA256 dedup and re-enqueues (use when the previous compile failed / you want to recompile;
#    the same path gains an extra pending Change; merge resolves it by latest-submitted-wins and records it in the conflict ledger)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well, carved with the side effects of the anchor-detach technique: qi backlash.","force":true}'

# 9) Merge and publish (manual in a review KB; auto KBs auto-merge on merge_batch_size/interval)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"Publish compiled output"}'

# 10) System pages: index/log/overview are maintained by the compile pipeline with the same batch (visible in /pages after publish)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages?page_type=index" \
  | python3 -c 'import json,sys; print([p["path"] for p in json.load(sys.stdin)])'

# 11) Gateway /v1/* uses a Bearer key (unrelated to the compile pipeline; shows the gateway auth pattern)
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

Detailed compilation rules: see [LLM Wiki usage](../WIKI.md).
