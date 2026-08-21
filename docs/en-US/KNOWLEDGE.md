# Knowledge Versions

The knowledge service governs imports, edits, publication, retrieval, and audit.

## Change to Master

```text
edit/import -> pending Change -> revision check
  -> atomic merge -> immutable Master vN
  -> chunks and graph rebuild -> versioned retrieval
```

Agents read only the current `master_version`. Pending edits are isolated. A merge copies the current Master, applies accepted Changes in creation order, records conflicts and tombstones, rebuilds derived data, and advances the pointer atomically.

## Conflict and immutability rules

- Stale `expected_revision` returns HTTP 409 instead of overwriting another editor.
- Same-path conflicts use the documented latest-submitted-wins policy.
- Published versions and merged Changes are immutable.
- Master deletion is a delete Change followed by a tombstone.
- Historical versions remain independently readable and searchable.

## Imports and metadata

MD, TXT, and text PDF imports enter the same Change lifecycle as manual edits. Scanned PDFs require OCR. Pages carry `page_type`, `title`, `confidence`, `sources[]`, and frontmatter.

System pages are excluded from evidence by default. Retrieval can use local lexical/page retrieval, hybrid dense retrieval, or optional Qdrant.

Never edit Master or the Markdown mirror directly. Submit a Change through the service or API.

