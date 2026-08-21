# LLM Wiki

## Where pages live

Authoritative Wiki pages are versioned in SQLite, especially `knowledge_documents`. After publication, AtlasGate produces a read-only Markdown mirror under `knowledge/<id>/`. ZIP export creates an Obsidian-compatible snapshot.

## Three-layer model

```text
Raw Sources -> wiki_sources -> two-step compilation
Wiki pages -> knowledge_documents + Markdown mirror
Schema and purpose -> schema.md / purpose.md
```

## Page types

- `entities/`: people, organizations, products, and tools.
- `concepts/`: theories, methods, and technical concepts.
- `sources/`: summaries and degraded raw archives.
- `comparisons/`, `synthesis/`, `queries/`: derived analysis and saved answers.
- Root system pages: `purpose.md`, `schema.md`, `index.md`, `log.md`, and `overview.md`.

Every page uses frontmatter with `type`, `title`, `sources[]`, `confidence`, and `tags`.

## Compilation

```text
enqueue -> SHA256 deduplication -> analysis -> generation
  -> path/frontmatter/secret/page-budget validation
  -> batch Changes -> review or auto merge
  -> index/log/overview maintenance
```

Without a real Provider, ingest stores the source and stages a raw archive page. Failed jobs retry up to two times and recover after restart.

## Retrieval, review, and lint

System pages and degraded raw archives are excluded by default. Hybrid mode combines lexical and dense page hits with RRF when an embedding service is configured. Structural Lint runs after publication; LLM Lint is manual and requires a real Provider.

Answers can be saved to `queries/<slug>.md`, but they enter the normal Change and publication process.

