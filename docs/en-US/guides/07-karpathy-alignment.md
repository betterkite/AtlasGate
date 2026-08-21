# Alignment with Karpathy's LLM Wiki Pattern

> ID: `KAR-001`  
> Reference: [Karpathy's LLM Wiki gist](../../references/karpathy-gist.md)  
> Conclusion: `core pattern aligned; implementation differs`

## Conclusion

AtlasGate implements the core idea: raw material is compiled into a persistent, linked Wiki with schema, indexing, logging, query write-back, and health checks. It is not a literal directory-first Markdown repository. SQLite versioned Master data is authoritative; `knowledge/<id>/` is a read-only Markdown mirror.

| Pattern | AtlasGate | Assessment |
|---|---|---|
| Immutable raw sources | `wiki_sources` stores source content and hashes; forced re-ingest replaces the old row | Partial |
| Persistent linked Wiki | Versioned `knowledge_documents`, WikiLinks, frontmatter, and Markdown mirror | Core aligned |
| Schema-driven workflow | `schema.md` and `purpose.md` are passed to ingest prompts | Ingest aligned; query context partial |
| Ingest updates pages | Two-step compiler creates or updates source, entity, concept, and system pages | Aligned |
| `index.md` and `log.md` | Versioned system pages and `wiki_log` are maintained | Aligned |
| Query write-back | `save_to_wiki` creates a `queries/<slug>.md` Change | Aligned |
| Wiki health checks | Structural Lint is automatic; semantic Lint is LLM-assisted/manual | Partial |
| File/Git repository workflow | Obsidian mirror and ZIP export exist, but SQLite remains authoritative | Different implementation |

## Important gaps

- Forced re-ingest deletes the previous raw-source row, so the raw ledger is not strictly append-only.
- Ingest tests prove that purpose and schema enter analysis/generation prompts. The Agent query prompt does not currently inject them as fixed context.
- Contradiction, stale-claim, and knowledge-gap handling still depends partly on model output and human review.

The precise assessment is therefore: **AtlasGate is faithful to the method's core knowledge-compilation pattern, but only partially aligned with its strict raw-source and schema-driven workflow details.**

