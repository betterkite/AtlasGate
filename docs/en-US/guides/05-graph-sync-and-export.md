# Knowledge Graph, Markdown Mirror, and Export

> IDs: `GRAPH-001`, `WIKI-002`  
> Status: `implemented` (v0.4.0)

## Purpose and boundary

The graph supports navigation, relation discovery, and knowledge-health insights; retrieval chunks are evidence units for recall, and the two are intentionally not the same kind of node. After publishing the Master, the system can sync pages into an Obsidian-readable Markdown mirror or export a read-only ZIP.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| Relations | `src/core/relevance.js` | `computeRelatedEdges()` | 5-signal related edges: direct_link×3 / source_overlap×4 / Adamic-Adar×1.5 / type_affinity×1 / lexical_overlap×1.5 |
| Communities | `src/core/louvain.js` | `louvain()` | Deterministic community discovery |
| Insights | `src/services/insights.js` | `computeGraphInsights()` | Orphans, sparse communities, bridge nodes, cross-community edges |
| Graph | `src/services/knowledge.js` | `graph()` | Versioned nodes/edges + community summary + insights + `query_hits` citation heat |
| Heat | `src/services/knowledge.js` | `recordQueryHits()` | ADR-015: Q&A citation counts (30-day window, `wiki_query_hits` table) |
| Mirror | `src/services/wiki-sync.js` | `syncKnowledgeBase()` | Master to Markdown (manifest-tracked deletions, auto-sync on publish hook) |
| Export | `src/services/wiki-export.js`, `src/core/zip.js` | `exportZip()` | Obsidian repository ZIP export |
| HTTP | `src/app.js` | `/graph`, `/sync`, `/export` | Graph query, manual sync, and export APIs |
| Frontend | `web/graph.js` | Canvas renderer | ForceAtlas2-style layout, drag, search, zoom, community coloring, and heat markers |

## Version boundaries

Graph nodes and edges both carry `kb_id` and `version`. Historical versions must be read independently (`/graph?version=`, `/export?version=`, `/documents?version=`) and must not be mixed into the current Master's relations. The mirror is a derived artifact of publication, not a database source of truth; editing the mirror directly does not enter the Change pipeline. Deletions of the md mirror are tracked by `.atlasgate-manifest.json` under `knowledge/<kb>/`; when a page is deleted, the next sync removes it from disk.

## Verification

```bash
npm test    # full suite: Node 92 + Python 19, zero npm runtime dependencies
node --test test/graph-layout.test.js test/wiki-sync.test.js test/wiki-phase8.test.js   # layout / sync / citation heat
```

## End-to-end reproduction (create KB → ingest and publish → graph query → sync md → export zip)

Verified against the default dev config (`npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin). Admin `/api/*` uses cookie sessions:

```bash
# 1) Login
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Create KB (ingest_mode=auto: auto merge-publish once ingest finishes -> triggers graph rebuild and md mirror sync;
#    use an ASCII name: non-ASCII characters in the export zip content-disposition header 500 in the current version)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"graph-demo","ingest_mode":"auto"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) Ingest a source (without a real Provider it degrades to sources/source.md raw archive page, published the same way)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well, carved with the side effects of the anchor-detach technique: qi backlash."}'

# 3b) Wait for the queue to finish (serial per KB, failures retry <=2; auto KBs merge-publish automatically when done)
until [ "$(curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5" \
  | python3 -c 'import json,sys; print([q["status"] for q in json.load(sys.stdin)][0])')" = "done" ]; do sleep 2; done

# 4) Graph data: nodes/edges/community summary/insights
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); \
print("nodes:", len(d["nodes"]), "edges:", len(d["edges"])); \
print("communities:", [(c["id"], c["members"], c["cohesion"]) for c in d["communities"]]); \
print("insights:", {k: len(v) for k, v in d["insights"].items()})'

# 5) Manually sync the md mirror (auto-synced on publish; returns files/removed stats)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/sync" \
  -H 'content-type: application/json' -d '{}'
ls knowledge/graph-demo/   # openable in Obsidian; edits go through the console (enter version governance as a Change)

# 6) Export the Master snapshot zip (includes frontmatter and .obsidian/ config)
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head

# 7) Q&A citation heat: pages cited by answers accumulate query_hits (30-day window), visible on graph nodes
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What are the side effects of the anchor-detach technique\"}"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); \
print([(n["document_path"], n["query_hits"]) for n in d["nodes"] if n["kind"]=="document" and n["query_hits"]>0])'

# 8) Gateway /v1/* uses a Bearer key (unrelated to the graph; shows the gateway auth pattern)
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

User-facing notes: see [LLM Wiki usage](../WIKI.md), Sections 1, 7, and 9.
