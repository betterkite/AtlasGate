# Alignment with Karpathy's LLM Wiki Pattern

> ID: `KAR-001`  
> Evaluation reference: [Karpathy LLM Wiki gist](../../references/karpathy-gist.md)  
> Evaluation version: 0.4.0 (tests Node 92 / Python 19)  
> Conclusion: `partially aligned, with a database-oriented extension`

## 1. Conclusion first

AtlasGate aligns with the core ideas of Karpathy's methodology, but not with its literal example shape.

It already implements the three-layer model of "raw material -> persistent Wiki -> schema/purpose", continuous ingest, interlinked pages, indexing, logging, query write-back (including ADR-015 auto-sedimentation), Lint, and the degraded-page mechanism. The main difference: Karpathy describes a Markdown repository living in a directory, while AtlasGate treats the versioned SQLite Master as its source of truth, and `knowledge/<id>/` is only a read-only mirror after publication.

The precise statement is therefore:

> AtlasGate is an LLM Wiki implementation with SQLite version governance at its core and Markdown as the derived interaction format — not an LLM Wiki whose source of truth is a filesystem/Git repository directly.

## 2. Comparison matrix

| Karpathy requirement | Current implementation | Assessment | Evidence |
|---|---|---|---|
| Raw Sources immutable | `wiki_sources` stores content, hash, and status; SHA256 deduplication; `force:true` deletes the old same-hash source and re-ingests | Partial | `src/db.js`, `src/services/wiki-compiler.js` |
| Wiki is persistent, interlinked Markdown pages | Pages stored in `knowledge_documents`, synced to Markdown after publication; WikiLink, page types, and frontmatter supported | Core aligned, different form | `knowledge.js`, `wiki-sync.js` |
| Schema guides the LLM workflow | Each knowledge base has `schema.md` and `purpose.md`, published through Changes | Partial | `knowledge/1/schema.md`, `knowledge.js` |
| Ingest updates entity, concept, and synthesis pages | Two-step compilation generates multiple page types (analysis → generation), batch review (`batch_id`), auto-maintains `index.md`, `log.md`, `overview.md` | Aligned | `wiki-compiler.js`, Wiki phase tests |
| `index.md` table of contents | System pages exist, updated after compilation; excluded from retrieval by default (`include_system` can open it) | Aligned | `systemPageTemplates()`, `knowledge/*/index.md` |
| `log.md` time log | `wiki_log` and the `log.md` mirror exist | Aligned | `src/db.js`, `wiki-compiler.js` |
| Query results can be written back | ADR-015: explicit `save_to_wiki`/`sediment`, or auto-sedimentation when similar questions occur ≥3 times and quality rules pass (≥2 source citations, no insufficient evidence, content ≥80 characters); output is a `queries/<slug>.md` Change on the audit chain, the same slug reuses the pending change, `ATLASGATE_QUERY_SEDIMENT_ENABLED` on by default | Aligned (with auto-sedimentation) | `src/services/wiki-compiler.js` (`autoSediment`), `test/wiki-phase7.test.js` |
| Degraded page (raw archive) | Without a real model, degrade to `sources/<slug>.md` carrying an `atlasgate-degraded` marker, excluded from retrieval by default (`include_raw` can open it) | Extension (not in the original) | `src/services/wiki-compiler.js` (`degradeIngest`), `knowledge.js` search |
| Lint finds contradictions, orphan pages, and gaps | Structural Lint runs automatically, LLM Lint runs manually; there is a report lifecycle | Partial | `src/services/lint.js` |
| Obsidian/Git direct browsing and versioning | Obsidian mirror and ZIP export exist; the mirror is not a write entry point, and Git collaboration is not the source of truth | Partial | `src/services/wiki-sync.js`, `wiki-export.js` |
| Humans own sources and direction, the LLM maintains the Wiki | `review` is the default human review, `auto` can publish automatically | Aligned, but `auto` needs caution | `../WIKI.md`, `knowledge.js` |
| Retrieval and evidence sufficiency (extension) | Default `hybrid` (lexical bigram + local dense vectors fused by RRF; auto-degrades to pure lexical without embeddings); pseudo-reranking, wikilink multi-hop, zero-evidence rewriting, insufficient evidence stated explicitly | Extension (the original does not specify a retrieval form) | `python/atlasgate_agent/engine.py`, `semantic-index.js` |

## 3. Key gaps

### 3.1 Does schema actually enter every LLM context

The ingest chain already has Python unit tests proving that the analysis prompt carries purpose, schema, index, and related pages, and the generation prompt carries schema, conventions, and the pages to update. Evidence lives in `python/tests/test_ingest.py`.

However, the Agent query prompt currently mainly contains retrieval results, Memory, and Skills; `python/atlasgate_agent/engine.py` does not inject `purpose.md`, `schema.md`, or `index.md` as fixed context (system pages are excluded from retrieval by default; `include_system` can open them). So "schema-driven ingest" holds, while "schema-driven every query" must still be marked `partial` — the existence of system pages in the database alone is not enough to claim full conformance.

To close the gap, add context selection and a length budget for the query prompt, plus tests proving:

- the query prompt contains the current Master's purpose and citation rules;
- after a schema version change, subsequent answers use the new rules;
- the index is used as a navigation table of contents without polluting the default evidence.

### 3.2 Immutability of raw sources

Current `force:true` ingest deletes the old `wiki_sources` record with the same hash and re-creates it (also clearing the corresponding ingest cache and queued tasks). It does not change existing Master pages, but strictly speaking it is not an append-only immutable ledger for raw sources. It would be better to keep the old source and add `supersedes_source_id` or `ingest_attempts`, so re-ingest remains auditable.

### 3.3 Is the directory index the Agent's primary navigation entry

The original methodology emphasizes that the Agent reads `index.md` first and then dives into specific pages. Current retrieval queries the database pages and vectors directly (default `hybrid`: page-level lexical bigram + local dense vectors fused by RRF); `index.md` is a system page excluded from retrieval by default. This is a reasonable performance and governance extension, but not a full replication of the original workflow, and the documentation should say so explicitly.

### 3.4 Repeated synthesis and contradiction maintenance

The current compiler can generate entities, concepts, summaries, and Review items and has Lint, but "new sources continuously revise old pages and explicitly handle mutually contradicting facts" still relies mostly on LLM output and human review. The existence of `confidence` or `conflict` fields alone is not enough to claim knowledge-level fact merging is complete.

### 3.5 The retrieval form is an extension, not a deviation

Karpathy's original text does not specify retrieval. AtlasGate defaults to `hybrid` retrieval (lexical + local ONNX-embedding dense vectors fused by RRF, auto-degrading to pure lexical when no embedding service is available), and adds pseudo-reranking (graph degree), wikilink multi-hop expansion, zero-evidence query rewriting, and evidence-sufficiency constraints. These are engineering extensions beyond the methodology and do not affect the core claim that "the compiled Wiki is the primary knowledge carrier".

## 4. Suggested strengthening order

1. Add prompt-tracking tests proving where schema/purpose/index are used.
2. Change raw-source re-ingest to append-style auditing instead of deleting historical sources.
3. Keep the source hash, generation run, schema version, and model information for every generated page.
4. Add end-to-end tests for "old pages revised by new sources" and "conflicts between new and old sources".
5. `/api/knowledge-bases/:id/pages` already returns sources, version, confidence, and content hash, but the generation batch/model information is still not exposed; complete it there.
6. Explicitly distinguish "structural Lint is implemented" from "semantic contradiction detection still relies on LLM/human".

## 5. Reproduction example: the query write-back (ADR-015) chain

Sedimentation is the concrete form of the "query write-back" comparison item. The following commands reproduce as-is on the default configuration (port 4310, default credentials):

```bash
# Log in and create a knowledge base
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Karpathy comparison KB","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Explicit sedimentation: save_to_wiki=true → response contains saved_to_wiki; output is a queries/<slug>.md Change
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"

# The sedimented page is a pending Change (review-mode KB does not auto-publish); repeat asks with the same slug reuse the same entry
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -m json.tool | grep -E '"(path|status|batch_id)"' | head

# After merging, the sedimented page enters the immutable Master and is mirrored as knowledge/<KB>/queries/<slug>.md
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"Publish sedimented page"}'
find knowledge/Karpathy\ comparison\ KB -path '*queries*' -name '*.md'
```

## 6. Final rating

| Dimension | Rating |
|---|---|
| Three-layer architecture idea | Aligned |
| Persistent, interlinked Wiki | Core aligned |
| Raw source strictly immutable | Partial |
| Schema-driven LLM | Needs prompt evidence; rated partial for now |
| Continuous maintenance after ingest | Basic chain aligned; semantic maintenance partially depends on the model |
| Index/log mechanism | Aligned |
| Query write-back | Aligned (including ADR-015 explicit/auto sedimentation) |
| Degraded pages and Lint maintenance | Structural capability aligned; semantic capability partially aligned |
| Retrieval and evidence sufficiency | Extension capability, not required by the original |
| File/Git repository form | Different implementation; should not claim full equivalence |
