# Knowledge Graph, Markdown Mirror, and Export

> IDs: `GRAPH-001`, `WIKI-002`  
> Status: `implemented`

The graph supports navigation, relation discovery, and health insights. Retrieval chunks are evidence units and are intentionally different from graph nodes.

| Layer | File | Responsibility |
|---|---|---|
| Relations | `src/core/relevance.js` | Link, source overlap, Adamic-Adar, and type affinity signals |
| Communities | `src/core/louvain.js` | Deterministic community discovery |
| Insights | `src/services/insights.js` | Orphans, sparse communities, and bridge nodes |
| Mirror | `src/services/wiki-sync.js` | Published Master to Markdown |
| Export | `src/services/wiki-export.js`, `src/core/zip.js` | Obsidian-compatible ZIP |
| UI | `web/graph.js` | Canvas interaction |

All graph nodes and edges carry knowledge-base and version identity. Historical graphs must not mix with the current Master. The Markdown mirror is derived output and direct edits do not enter the Change pipeline.

```bash
node --test test/graph-layout.test.js test/wiki-sync.test.js
```

