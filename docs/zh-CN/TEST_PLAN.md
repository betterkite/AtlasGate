# 测试计划

状态：基础测试计划（版本 0.4.0）。目标是验证 AtlasGate 是受治理的 LLM 网关和版本化知识 Agent 平台，而不只是验证进程能够启动。当前证据：**Node 92 项 + Python 19 项**，覆盖 wiki-phase0~8 全阶段（LLM Wiki 编译、RAG 混合检索、ADR-015 问答沉淀/图谱热度/技能检索）。

## 1. 发布范围

本版本声明覆盖：

- OpenAI Chat Completions、Responses、Embeddings 和 Anthropic Messages 兼容接口，以及三种 envelope 的 SSE 流式输出与模型列表。
- Provider、模型、凭据池、路由、余额、有界 Failover 和用量治理。
- MD、TXT、文本 PDF 导入，以及 Change、Master、冲突、删除 tombstone 和历史版本；per-KB `ingest_mode`（`review` 默认 / `auto`）与批次审阅（`batch_id`）。
- LLM Wiki：两步编译（analysis→generation）、SHA256 去重与 `force:true` 强制重新摄入、降级页（`atlasgate-degraded`，默认不参与检索）、结构级自动 Lint + LLM 级手动 Lint、`index.md`/`log.md`/`overview.md` 系统页（编译器维护，`purpose`/`schema` 人工协同）、md 镜像单向同步（Obsidian 可开、gitignore）与 ZIP 导出。
- 混合检索（hybrid 默认）：词法 bigram 页面级 + 本地稠密向量（`semantic_vectors` 表，SQLite 余弦）按 RRF 融合，伪重排（图谱度数）、零证据查询改写、wikilink 多跳扩展与证据充分性约束；未配置 embedding 时自动降级为纯词法；qdrant 可选后端。
- 问答沉淀与技能检索策略（ADR-015）：`save_to_wiki`/`sediment` 显式或相似问题≥3次+质量规则自动沉淀，产物走 Change 审计链并跟随 `ingest_mode`；图谱节点 `query_hits` 引用热度（30 天窗口）；SKILL.md 声明 `retrieval` 字段，attach 后注入检索参数。
- Knowledge Agent、Memory、Skills、Python worker pool、本地检索和可选 Qdrant。
- 管理控制台、Docker 镜像和 MCP JSON-RPC。

不声明：多节点高可用、公网管理员安全、透明上游 token 流、扫描 PDF OCR、完整支付订阅和参考商业产品的功能等价。

## 2. 测试分组

| 分组 | 关注内容 |
|---|---|
| 功能测试 | 鉴权、额度、路由、Failover、Provider 生命周期、知识合并、冲突、导入、Agent、Memory、Skills、检索、ADR-015 沉淀与技能注入 |
| API 测试 | OpenAI/Anthropic envelope、SSE、错误码、请求 ID、健康检查和 MCP |
| LLM Wiki 测试 | wiki-phase0~8：系统页安装、两步编译、去重、降级、Lint、图谱、导出、hybrid RRF、伪重排/改写、沉淀、热度、技能检索 |
| 性能测试 | 网关延迟、检索、worker 复用、队列饱和、崩溃恢复、关闭和导入上限 |
| 安全测试 | 密钥隔离、风险阻断、scope、白名单、包校验、路径安全 |
| 交互测试 | 控制台视图、导入、图谱、Review、余额刷新和密钥显示 |

## 3. 业务规则

- 未授权或 scope 不足的请求必须在上游调用前失败。
- 视觉请求不能到达文本模型。
- 每次 Provider attempt 都必须进入审计。
- pending Change 不得进入 Master 检索。
- 发布必须让读者看到完整旧版本或完整新版本。
- 历史版本和已合并 Change 不可变。
- Agent 必须引用已发布证据，证据不足时明确拒绝猜测。
- `use_memory=false` 时不得读写 Memory。
- 本地 feature vector 不得被标记为语义 Embedding。
- 系统页（`index.md`/`log.md`/`overview.md`）由编译器维护，`purpose`/`schema` 由人工协同；`atlasgate-degraded` 降级页默认不参与检索。
- 问答沉淀只允许两种入口：显式 `save_to_wiki`/`sediment`，或相似问题≥3次且通过质量规则（≥2 来源引用、无证据不足标记、内容≥80 字）；同 slug 复用 pending Change，不得堆积重复。
- 技能 `retrieval` 声明（`top_k`/`multihop`/`include_raw`/`directories`）attach 后注入检索参数：`multihop`/`include_raw` 任一为 true 即开启，`top_k` 取最大值；调用方显式参数优先。
- hybrid 检索在未配置 embedding 时必须自动降级为纯词法，不得静默失败。

## 4. 运行命令

```bash
npm test          # Node + Python 全量（Node 92 / Python 19）
npm run test:node # 仅 Node（node --test）
python3 -m unittest discover -s python/tests -v   # 仅 Python
npm run test:performance  # 性能基准（test/performance.bench.js）
npm run check     # 语法检查 + 全量测试门禁
```

`package.json` 的 npm 脚本字面量调用 `python`；没有该别名的环境应显式使用 `python3`。运行期服务本身会通过 `ATLASGATE_PYTHON` 或自动探测 `python`/`python3`，但 npm 测试脚本不会。

## 5. 可复现示例

### 5.1 启动服务并冒烟（默认端口 4310、默认凭据）

```bash
npm start   # 控制台 http://127.0.0.1:4310；admin/atlasgate-admin；网关 key atlasgate-dev-key

# 管理端：先登录保存会话，后续用 -b cookies.txt
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/overview | python3 -m json.tool

# 网关端：Bearer 鉴权
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
curl http://127.0.0.1:4310/health
```

### 5.2 跑全量测试

```bash
# 全量（推荐）：Node 92 项 + Python 19 项
npm test

# 分步执行等价命令
npm run test:node
python3 -m unittest discover -s python/tests -v
npm run test:performance
```

## 6. 发布门禁

每个 `implemented` 能力必须有对应代码、测试和边界说明。真实 Provider、Embedding、Qdrant、Docker 和浏览器测试必须标注实际运行环境，不能把 mock 或 fallback 结果写成生产质量证据。
