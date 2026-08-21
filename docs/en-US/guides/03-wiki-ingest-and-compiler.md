# Document Ingest and LLM Wiki Compilation

> IDs: `KB-002`, `WIKI-001`  
> Status: `implemented`

## Purpose and boundary

Ingest stores MD, TXT, text PDF, URL, or pasted content as an immutable raw source and compiles it into frontmatter-bearing Wiki pages. Without a real Provider, the system explicitly falls back to a raw archive page instead of pretending to have produced an LLM summary.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTTP | `src/app.js` | `/import`, `/ingest` | Receives sources and jobs |
| Parser | `src/services/document-parser.js` | `parse()` | UTF-8 and format validation |
| Queue | `src/services/ingest-queue.js` | `create()`, `retry()` | Bounded and recoverable queue |
| Compiler | `src/services/wiki-compiler.js` | `ingestOne()` | Analyze, generate, validate, stage |
| Metadata | `src/core/frontmatter.js` | `parseFrontmatter()` | Page contract |
| Publication | `src/services/knowledge.js` | `submitChange()`, `merge()` | Review and version governance |

## Compile flow

```text
raw source -> SHA256 deduplication -> ingest queue
  -> analysis -> generation -> path/frontmatter/secret/page-budget validation
  -> batch Changes -> review or auto merge -> index/log/overview update
```

Only one job runs per knowledge base. Failed jobs retry up to two times and pending work is recovered after restart.

Secrets, path escapes, invalid metadata, and excessive page counts are rejected. `review` is the default; `auto` is intended for low-risk personal bases.

See [LLM Wiki usage](../WIKI.md).

