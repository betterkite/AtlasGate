# 功能实现追踪矩阵

状态含义：`implemented` 已有实现和测试；`partial` 有实现但存在明确生产边界；`fallback` 仅在降级路径提供；`planned` 尚未实现。

| ID | 功能块 | 指南 | 入口/核心代码 | 主要接口 | 主要测试 | 状态 |
|---|---|---|---|---|---|---|
| SYS-001 | HTTP 运行时与 SQLite | [00](00-system-runtime.md) | `src/server.js`、`src/app.js`、`src/db.js` | `/health` | `test/atlasgate.test.js` | implemented |
| GW-001 | 多协议转换 | [01](01-gateway-and-governance.md) | `src/services/protocol.js` | `/v1/chat/completions`、`/v1/responses`、`/v1/messages` | `test/atlasgate.test.js` | implemented |
| GW-002 | 路由、凭据池与 Failover | [01](01-gateway-and-governance.md) | `src/services/gateway.js` | `/api/routing/simulate` | `test/atlasgate.test.js` | implemented |
| GOV-001 | Key、额度、限流与审计 | [01](01-gateway-and-governance.md) | `src/services/auth.js`、`gateway.js`、`platform.js` | `/api/keys`、`/api/logs` | `test/atlasgate.test.js` | implemented |
| KB-001 | Change、Master 与版本合并 | [02](02-knowledge-versioning.md) | `src/services/knowledge.js`、`src/db.js` | `/api/knowledge-bases/:id/changes`、`/merge` | `test/wiki-phase*.test.js` | implemented |
| KB-002 | MD/TXT/PDF 摄入 | [03](03-wiki-ingest-and-compiler.md) | `document-parser.js`、`python/.../ingest.py` | `/import` | `test/wiki-phase0.test.js` | implemented |
| WIKI-001 | 两步 LLM 编译与 Review | [03](03-wiki-ingest-and-compiler.md) | `wiki-compiler.js`、`ingest-queue.js` | `/ingest`、`/reviews` | `test/wiki-phase1.test.js` | implemented |
| RAG-001 | Hybrid/本地/Qdrant 检索 | [04](04-retrieval-and-agent.md) | `semantic-index.js`、`engine.py` | `/search` | `test/wiki-phase*.test.js` | partial |
| AG-001 | 引用式 Knowledge Agent | [04](04-retrieval-and-agent.md) | `agent.js`、`python-agent.js`、`engine.py` | `/api/agents/knowledge/ask` | `python/tests/test_engine.py` | partial |
| GRAPH-001 | 关系图、社区与洞察 | [05](05-graph-sync-and-export.md) | `relevance.js`、`louvain.js`、`insights.js` | `/graph` | `test/graph-layout.test.js` | implemented |
| WIKI-002 | Markdown 镜像与 ZIP 导出 | [05](05-graph-sync-and-export.md) | `wiki-sync.js`、`wiki-export.js`、`zip.js` | `/sync`、`/export` | `test/wiki-sync.test.js` | implemented |
| UI-001 | 管理控制台 | [06](06-console-and-mcp.md) | `web/app.js`、`web/graph.js` | `/api/*` | `test/graph-layout.test.js` | partial |
| API-001 | MCP 工具适配 | [06](06-console-and-mcp.md) | `src/services/mcp.js` | `/mcp` | `test/atlasgate.test.js` | implemented |
| KAR-001 | Karpathy 三层模型 | [07](07-karpathy-alignment.md) | `wiki-compiler.js`、`knowledge.js`、`db.js` | Wiki 管理 API | Wiki phase tests | partial |

## 维护规则

- 新增功能先新增矩阵行，再创建或更新指南。
- 状态从 `partial` 改为 `implemented` 前必须有测试证据。
- 文件移动、接口变化、数据表变化都要检查矩阵中的代码地图。
- 每次发布前运行 `npm test`，并人工检查本矩阵是否仍然准确。

