# Feature Implementation Matrix

Status values: `implemented` has code and tests; `partial` has an explicit production boundary; `fallback` is only available on a degraded path; `planned` is not implemented.

| ID | Feature | Guide | Entry/core code | Main API | Main tests | Status |
|---|---|---|---|---|---|---|
| SYS-001 | HTTP runtime and SQLite | [00](00-system-runtime.md) | `src/server.js`, `src/app.js`, `src/db.js` | `/health`, `/api/auth/login` | `test/atlasgate.test.js` | implemented |
| GW-001 | Multi-protocol conversion | [01](01-gateway-and-governance.md) | `src/services/protocol.js` | `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/embeddings` | `test/atlasgate.test.js` | implemented |
| GW-002 | Routing, credential pools, and failover | [01](01-gateway-and-governance.md) | `src/services/gateway.js` | `/api/routing/simulate` | `test/atlasgate.test.js` | implemented |
| GOV-001 | Keys, quotas, limits, and audit | [01](01-gateway-and-governance.md) | `src/services/auth.js`, `gateway.js`, `platform.js` | `/api/keys`, `/api/logs` | `test/atlasgate.test.js` | implemented |
| KB-001 | Change, Master, and version merges | [02](02-knowledge-versioning.md) | `src/services/knowledge.js`, `src/db.js` | `/api/knowledge-bases/:id/changes`, `/merge` | `test/wiki-phase*.test.js` | implemented |
| KB-002 | MD/TXT/PDF ingest | [03](03-wiki-ingest-and-compiler.md) | `document-parser.js`, `python/.../ingest.py` | `/import` | `test/wiki-phase0.test.js` | implemented |
| WIKI-001 | Two-step LLM compilation and Review | [03](03-wiki-ingest-and-compiler.md) | `wiki-compiler.js`, `ingest-queue.js` | `/ingest`, `/reviews` | `test/wiki-phase1.test.js` | implemented |
| RAG-001 | Hybrid retrieval (default) | [04](04-retrieval-and-agent.md) | `semantic-index.js`, `engine.py` | `/search`, `/api/agents/knowledge/ask` | `test/wiki-phase5.test.js`, `python/tests/test_engine.py` | implemented |
| RAG-002 | Qdrant dense backend | [04](04-retrieval-and-agent.md) | `semantic-index.js` | `ATLASGATE_RETRIEVAL_MODE=qdrant` | `test/wiki-phase5.test.js` | partial |
| RAG-003 | Zero-evidence query rewriting | [04](04-retrieval-and-agent.md) | `agent.js` | `/api/agents/knowledge/ask` | `test/wiki-phase6.test.js` | implemented |
| AG-001 | Evidence-first Knowledge Agent | [04](04-retrieval-and-agent.md) | `agent.js`, `python-agent.js`, `engine.py` | `/api/agents/knowledge/ask`, `/status`, `/api/agents/runs` | `python/tests/test_engine.py`, `test/wiki-phase6.test.js` | implemented |
| AG-002 | Query sedimentation (ADR-015) | [04](04-retrieval-and-agent.md) | `wiki-compiler.js` (`autoSediment`) | `/api/agents/knowledge/ask` (`save_to_wiki`/`sediment`) | `test/wiki-phase7.test.js` | implemented |
| AG-003 | Graph citation heat query_hits (ADR-015) | [04](04-retrieval-and-agent.md) | `knowledge.js` (`recordQueryHits`) | `/graph` | `test/wiki-phase8.test.js` | implemented |
| AG-004 | Skills and retrieval parameter injection (ADR-015) | [04](04-retrieval-and-agent.md) | `agent.js` (`retrievalParamsFromSkills`, `deleteSkill`) | `/api/skills*`, `POST /api/agents/:agentId/skills/:skillId` (including `DELETE /api/skills/:id`) | `test/wiki-phase8.test.js` | implemented |
| GRAPH-001 | Relations, communities, and insights | [05](05-graph-sync-and-export.md) | `relevance.js`, `louvain.js`, `insights.js` | `/graph` | `test/graph-layout.test.js` | implemented |
| WIKI-002 | Markdown mirror and ZIP export | [05](05-graph-sync-and-export.md) | `wiki-sync.js`, `wiki-export.js`, `zip.js` | `/sync`, `/export` | `test/wiki-sync.test.js` | implemented |
| UI-001 | Management console | [06](06-console-and-mcp.md) | `web/app.js`, `web/graph.js` | `/api/*` | `test/graph-layout.test.js` | partial |
| API-001 | MCP tool adapter | [06](06-console-and-mcp.md) | `src/services/mcp.js` | `/mcp` | `test/atlasgate.test.js` | implemented |
| KAR-001 | Karpathy three-layer model | [07](07-karpathy-alignment.md) | `wiki-compiler.js`, `knowledge.js`, `db.js` | Wiki management APIs | Wiki phase tests | partial |

## Maintenance rules

- Add the matrix row first when introducing a feature, then create or update the guide.
- Changing a status from `partial` to `implemented` requires test evidence.
- File moves, API changes, and data-table changes must be checked against the code map in the matrix.
- Before every release, run `npm test` (current baseline **Node 92 / Python 19**, version 0.4.0) and manually verify this matrix is still accurate.
- Test evidence for the ADR-015 rows (AG-002 / AG-003 / AG-004) is concentrated in `test/wiki-phase7.test.js` and `test/wiki-phase8.test.js`.
