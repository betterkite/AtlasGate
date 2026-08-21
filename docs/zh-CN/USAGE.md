# AtlasGate 使用总览

> 版本基线：**0.4.0**（测试 Node 92 / Python 19；零 npm 运行依赖；启动 `npm start`，控制台 http://127.0.0.1:4310，默认 `admin / atlasgate-admin`，网关 key `atlasgate-dev-key`）。本文是控制台的使用导览与常见任务流程。分模块的深度文档见 [导航主页](README.md)。

## 控制台 8 个视图

| 视图 | 入口 | 作用 |
| --- | --- | --- |
| **运行总览** | 01 | 上游 API Key 余额（自动刷新）+ API 请求数/Token 两张可悬停曲线图（24h/7d/30d） |
| **知识 Agent** | 02 | 向知识库提问：引用证据回答、可选 Memory、"回存 Wiki"把好答案沉淀为页面（ADR-015：显式 `save_to_wiki`/`sediment`，或相似问题≥3次+质量规则自动沉淀） |
| **知识版本** | 03 | 知识库管理：导入、Change 待审、合并发布、版本/冲突账本、关系图、Wiki 设置（ingest 模式 review/auto）、摄入队列、Review 队列、Lint 体检 |
| **模型网关** | 04 | Provider/凭据/模型映射/客户端密钥/余额/健康测试 |
| **路由策略** | 05 | 路由模拟与排除诊断（评分信号：质量/成本/延迟/可靠性） |
| **Skills 与 Memory** | 06 | 技能包上传/版本/启停/删除；SKILL.md frontmatter 可声明 `retrieval` 检索策略（attach 后注入）；Memory 生命周期 |
| **审计证据** | 07 | 请求账本：**每条请求显示调用方密钥**、路由决策、用量、风险 |
| **Wiki 知识库** | 08 | 三栏阅读（页面树/Markdown/图谱）：浏览、编辑（走 Change）、图谱搜索/拖拽/悬停、同步 md、导出 zip |

## 照抄可跑：最小示例

默认开发配置（`npm start`）实测通过。管理端 `/api/*` 用 cookie 会话（先登录保存 `cookies.txt`），网关 `/v1/*` 用 `Authorization: Bearer atlasgate-dev-key`：

```bash
# 0) 登录（后续管理端请求都带 -b cookies.txt）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 1) 网关调用（内置 atlas-mini mock，离线可验证全链路）
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"

# 2) 建库（review 模式：编译产物留 pending 等人工审阅；库名用 ASCII，避免导出 zip 文件名报错）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"usage-demo","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) 摄入素材（无真实 Provider 时降级为 sources/素材.md 原文存档页，同样可发布）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。"}'

# 4) 审阅批次（共享 batch_id、author=wiki-compiler）→ 发布（自动跑结构级 Lint 并同步 md 镜像）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" | python3 -m json.tool
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'

# 5) 知识 Agent 提问并显式沉淀（ADR-015：响应含 saved_to_wiki，产物 queries/<slug>.md 走 Change 审计链）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"save_to_wiki\":true}"

# 6) Lint 体检（结构级免费自动跑；LLM 级需真实模型，手动触发）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint" \
  -H 'content-type: application/json' -d '{"mode":"structural"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint-reports?status=open"
```

## 常见任务流程

### 接入一个新模型（DeepSeek 示例）
1. 「模型网关」→ 添加 Provider：name=`deepseek`、kind=`openai`、base_url=`https://api.deepseek.com`、API Key=你的 key、models=`deepseek-chat, deepseek-reasoner`。
2. 「测试」确认健康 → 「余额」拉取账户余额（DeepSeek 自动走官方 `/user/balance`，总览页会显示）。
3. 需要时添加凭据池（多 key 轮换）与模型映射（别名→上游模型）。

### 让业务系统调用网关
1. 「模型网关」→ 签发**客户端密钥**：设置 scope（`gateway:invoke`）、模型白名单、RPM/TPM、token 配额、月预算。
2. 把密钥交给调用方，用 `Authorization: Bearer <key>` 调 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/embeddings`（开发环境也可直接用 `atlasgate-dev-key`）。
3. 「审计证据」里能看到每条请求是**哪个密钥**调的（密钥名称+前缀），内部调用标记"内部调用"。

### 沉淀知识（LLM Wiki 编译 + ADR-015 问答沉淀）
1. 「知识版本」→ 建知识库（review 模式，默认）。
2. 「摄入队列」tab：粘贴文本 / URL 抓取 / 上传 md·txt·pdf；相同内容按 SHA256 去重跳过，`force:true` 强制重新摄入。
3. 无真实模型：素材存档 + 原文成页（降级页带 `atlasgate-degraded` 标记，默认不参与检索）；配置 DeepSeek 等真实模型后：两步编译（analysis→generation）自动产出实体/概念/摘要页，产物进 Pending。
4. 「待合并变更」里按批次审阅（可整批打回）→「发布合并」→ 新不可变 Master。
5. 「Wiki 知识库」浏览/编辑；「同步 md」把页面镜像到 `knowledge/<库名>/`（单向，Obsidian 可开）；「导出 zip」打包给 Obsidian。
6. **问答沉淀（ADR-015）**：提问时勾选「回存 Wiki」或在 API 传 `save_to_wiki:true`/`sediment:true` 显式沉淀；或同一相似问题被问 ≥3 次且答案满足质量规则（≥2 来源引用、无"证据不足"、内容 ≥80 字）自动沉淀。产物为 `queries/<slug>.md`，自动 [[wikilink]] 关联 concepts//entities/ 页，走 Change 审计链（review 库留 pending）；同 slug 的 pending change 原地更新不堆积。沉淀页可在 Wiki 视图编辑/删除/回滚。可用 `ATLASGATE_QUERY_SEDIMENT_ENABLED=false` 关闭自动沉淀。

### 体检知识库
1. 「知识版本 → Lint 体检」：结构级检查（孤立页/断链/index 一致性）纯 SQL、免费、**每次发布自动跑**；LLM 级（矛盾/过时/数据缺口）需要真实模型，手动触发。
2. 报告可 ack / 忽略 / 一键创建缺失页（走 Change）。

## 权限与密钥速记（重要）

- **管理员账号**（`admin`）→ 登录控制台，管理一切；只能走浏览器/API 会话（HttpOnly cookie），不能调 `/v1/*`。
- **客户端密钥** → 调 `/v1/*`；带 token 配额/限流/预算；不能登录控制台；**没有"用户账号登录"这回事**（`users` 只是密钥的归属记账实体）。
- **上游 API Key**（DeepSeek 等）→ 网关调上游用；余额在总览显示，与客户端密钥配额无关。

## 更多
- 网关深度：[GATEWAY.md](GATEWAY.md)
- 知识版本深度：[KNOWLEDGE.md](KNOWLEDGE.md)
- LLM Wiki 深度（含 md 文件在哪）：[WIKI.md](WIKI.md)
- Agent 深度（Memory/Skills/沉淀）：[AGENT.md](AGENT.md)
- 运维与排查：[CONSOLE_OPS.md](CONSOLE_OPS.md)
- 控制台与 MCP：[guides/06-console-and-mcp.md](guides/06-console-and-mcp.md)
