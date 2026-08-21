# 管理控制台与 MCP

> ID: `UI-001` / `API-001`  
> 状态: `implemented`（版本 0.4.0）

## 1. 目的与边界

原生 Web 控制台（免构建，8 个视图）为网关、知识库、Wiki、图谱、Agent、Skills/Memory 和运维提供操作界面；MCP 将少量受治理能力（知识检索/提问/图谱/Change/合并/摄入/审阅/Lint/Memory/Skills，共 12 个工具）以 JSON-RPC 暴露给外部 Agent。控制台当前适合回环或可信私网，不应直接视为公网管理员产品。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTML | `web/index.html` | 8 个 `data-view` 面板 | 视图容器（01 运行总览 / 02 知识 Agent / 03 知识版本 / 04 模型网关 / 05 路由策略 / 06 Skills 与 Memory / 07 审计证据 / 08 Wiki 知识库） |
| UI | `web/app.js` | view handlers | API 调用、状态和表单 |
| Wiki UI | `web/knowledge-tabs.js` | knowledge tabs | 页面、变更、导入、图谱和冲突视图 |
| Graph UI | `web/graph.js` | Canvas renderer | 图谱交互（ForceAtlas2 式布局、拖拽、社区着色、引用热度） |
| MCP | `src/services/mcp.js` | `McpService.handle()` | JSON-RPC 2.0：`initialize` / `tools/list` / `tools/call`（12 个受治理工具） |
| HTTP | `src/app.js` | `/mcp`、`/api/*`、`/v1/*` | 认证（管理 cookie / 网关 Bearer）、路由和错误响应 |

## 3. 控制台 8 个视图与操作步骤

| # | 视图 | 操作步骤（最小闭环） |
|---|---|---|
| 01 | 运行总览 | 打开即见：上游余额（自动刷新）+ 请求/Token 曲线（24h/7d/30d 切换，悬停看值）。背后 API：`GET /api/overview?range=` |
| 02 | 知识 Agent | 选知识库 → 输入问题 → 可选勾选 Memory（`use_memory`）与「回存 Wiki」（`save_to_wiki`）→ 提交。回答带 `sources` 引用；响应含 `rewritten_question`（零证据改写）与 `retrieval_mode` |
| 03 | 知识版本 | 建库（`ingest_mode` review/auto）→ 导入/摄入（粘贴/URL/文件）→ 待审 Change 按批次审阅（可整批打回）→ 合并发布为新 Master → 冲突账本/版本历史/摄入队列/Review 队列/Lint 体检 |
| 04 | 模型网关 | Provider 增删改 + 凭据池 + 模型映射 + 签发客户端密钥（scope/白名单/RPM/TPM/配额/预算）+ 测试/余额 |
| 05 | 路由策略 | 路由模拟：选模型看候选与排除原因（质量/成本/延迟/可靠性评分）；`POST /api/routing/simulate` |
| 06 | Skills 与 Memory | 上传技能（`SKILL.md` frontmatter 可声明 `retrieval`：top_k/multihop/include_raw/directories）→ attach 到 knowledge-agent → 提问验证参数注入（multihop/include_raw 任一 true 即开、top_k 取最大、调用方显式参数优先）；Memory 列表/新建/遗忘/替代（`supersede`） |
| 07 | 审计证据 | 逐条查看请求账本：调用方密钥（名称+前缀）、路由决策、用量、风险标记；`GET /api/logs`、`GET /api/provider-attempts` |
| 08 | Wiki 知识库 | 三栏阅读（页面树/Markdown/图谱）：浏览与编辑（走 Change）→ 图谱搜索/拖拽/悬停（含 `query_hits` 引用热度）→ 同步 md（`knowledge/<库>/`）→ 导出 zip |

## 4. MCP 工具与调用示例

端点 `POST /mcp`，JSON-RPC 2.0（协议 `2025-03-26`）。**不在 `/api/*` 之下、不需要管理会话**，但只暴露声明的受治理工具：`knowledge_search` / `knowledge_ask` / `knowledge_graph` / `knowledge_submit_change` / `knowledge_merge` / `memory_list` / `skill_list` / `wiki_ingest` / `wiki_reviews_list` / `wiki_reviews_resolve` / `wiki_lint_run` / `wiki_lint_list`。

```bash
# 1) 工具清单（默认开发配置 npm start，http://127.0.0.1:4310）
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 2) 调用受治理工具：搜索已发布 Master（$KB 为建库返回的 id，见 USAGE.md 示例）
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"knowledge_search\",\"arguments\":{\"kb_id\":\"$KB\",\"query\":\"石壁 线索\",\"top_k\":5}}}"

# 3) 知识 Agent 提问（structuredContent 含 sources 引用证据）
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"knowledge_ask\",\"arguments\":{\"kb_id\":\"$KB\",\"question\":\"脱锚术的副作用是什么\"}}}"

# 4) 提交受治理变更（走 Change 审计链，review 库留 pending）
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"knowledge_submit_change\",\"arguments\":{\"kb_id\":\"$KB\",\"path\":\"notes/示例.md\",\"operation\":\"upsert\",\"content\":\"---\\ntype: note\\ntitle: 示例\\n---\\n\\n内容\",\"author\":\"mcp-demo\"}}}"
```

## 5. 安全边界

- `/api/*` 除认证接口外需要管理员 session（HttpOnly + SameSite=Lax cookie）；`/v1/*` 需要 Bearer 网关 key；`/mcp` 无会话但仅暴露上述受治理工具集。
- Provider 密钥不能出现在 UI、API 响应、日志或错误体。
- 文件导入必须经过大小、编码、格式和路径校验。
- MCP 工具只能调用已声明的受治理能力，不返回任何密钥。

## 6. 当前限制

控制台没有独立的公网管理员身份系统、TLS 终止和细粒度多租户 UI 权限。因此本功能的界面完整性与公网安全性必须分开评价。

## 7. 验证

```bash
npm test    # 全量：Node 92 + Python 19，零 npm 运行依赖
node --test test/atlasgate.test.js test/graph-layout.test.js   # 网关/控制台 API + 图谱布局
```

端到端复现：`npm start` → 浏览器打开 http://127.0.0.1:4310（admin / atlasgate-admin）按第 3 节走一遍 8 个视图；第 4 节 MCP 命令照抄可跑（需先建库得到 `$KB`）。
