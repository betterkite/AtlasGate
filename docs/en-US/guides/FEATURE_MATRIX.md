# Feature Implementation Matrix

Status values: `implemented` has code and tests; `partial` has an explicit production boundary; `fallback` is only a degraded path; `planned` is not implemented.

| ID | Feature | Guide | Entry/core code | Main API | Main tests | Status |
|---|---|---|---|---|---|---|
| SYS-001 | HTTP runtime and SQLite | [00](00-system-runtime.md) | `src/server.js`, `src/app.js`, `src/db.js` | `/health` | `test/atlasgate.test.js` | implemented |
| GW-001 | Multi-protocol conversion | [01](01-gateway-and-governance.md) | `src/services/protocol.js` | `/v1/*` | `test/atlasgate.test.js` | implemented |
| GW-002 | Routing, credential pools, and failover | [01](01-gateway-and-governance.md) | `src/services/gateway.js` | `/api/routing/simulate` | `test/atlasgate.test.js` | implemented |
| GOV-001 | Keys, quotas, limits, and audit | [01](01-gateway-and-governance.md) | `auth.js`, `gateway.js`, `platform.js` | `/api/keys`, `/api/logs` | `test/atlasgate.test.js` | implemented |
| KB-001 | Changes, Master, and version merges | [02](02-knowledge-versioning.md) | `knowledge.js`, `db.js` | `/changes`, `/merge` | `test/wiki-phase*.test.js` | implemented |
| KB-002 | MD/TXT/PDF ingest | [03](03-wiki-ingest-and-compiler.md) | `document-parser.js`, `python/.../ingest.py` | `/import` | Wiki phase tests | implemented |
| WIKI-001 | Two-step compilation and review | [03](03-wiki-ingest-and-compiler.md) | `wiki-compiler.js`, `ingest-queue.js` | `/ingest`, `/reviews` | Wiki phase tests | implemented |
| RAG-001 | Hybrid, local, and Qdrant retrieval | [04](04-retrieval-and-agent.md) | `semantic-index.js`, `engine.py` | `/search` | Wiki phase tests | partial |
| AG-001 | Evidence-first Knowledge Agent | [04](04-retrieval-and-agent.md) | `agent.js`, `python-agent.js`, `engine.py` | `/api/agents/knowledge/ask` | Python tests | partial |
| GRAPH-001 | Relations, communities, and insights | [05](05-graph-sync-and-export.md) | `relevance.js`, `louvain.js`, `insights.js` | `/graph` | `test/graph-layout.test.js` | implemented |
| WIKI-002 | Markdown mirror and ZIP export | [05](05-graph-sync-and-export.md) | `wiki-sync.js`, `wiki-export.js`, `zip.js` | `/sync`, `/export` | `test/wiki-sync.test.js` | implemented |
| UI-001 | Management console | [06](06-console-and-mcp.md) | `web/app.js`, `web/graph.js` | `/api/*` | Graph and API tests | partial |
| API-001 | MCP adapter | [06](06-console-and-mcp.md) | `src/services/mcp.js` | `/mcp` | `test/atlasgate.test.js` | implemented |
| KAR-001 | Karpathy three-layer model | [07](07-karpathy-alignment.md) | `wiki-compiler.js`, `knowledge.js`, `db.js` | Wiki APIs | Wiki phase tests | partial |

