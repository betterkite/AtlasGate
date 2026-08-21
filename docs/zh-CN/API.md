# API 参考

所有 JSON 修改接口都要求 `Content-Type: application/json`。网关接口需要客户端 API Key（默认 `Authorization: Bearer atlasgate-dev-key`），管理接口需要控制台管理员会话 Cookie（`atlasgate_admin_session`，HttpOnly）。管理端 `/api/*` 中除 `/api/auth/*` 外都要求管理员会话。

## 数据面接口

| 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|
| GET | `/v1/models` | API Key | 返回可用模型和 `auto` 别名 |
| POST | `/v1/chat/completions` | API Key | OpenAI Chat Completions 兼容接口和 SSE |
| POST | `/v1/responses` | API Key | OpenAI Responses 兼容接口和 SSE |
| POST | `/v1/messages` | API Key | Anthropic Messages 兼容接口 |
| POST | `/v1/messages/count_tokens` | API Key | 输入 token 估算 |
| POST | `/v1/embeddings` | API Key | 通过 Provider 生成 Embedding |
| POST | `/mcp` | MCP 客户端 | JSON-RPC 初始化、工具列表和工具调用 |
| GET | `/health` | 无 | 健康检查（版本、数据库、Python 池、检索状态） |

响应会返回 `x-atlas-request-id`、`x-atlas-routing-decision-id` 和 `x-atlas-provider`。路由相关请求头包括 `x-atlas-routing-profile`、`x-atlas-session-id` 和 `x-atlas-risk-mode`。

网关示例（默认端口 4310、开发 Key `atlasgate-dev-key`，照抄可复现）：

```bash
curl http://127.0.0.1:4310/v1/models \
  -H "Authorization: Bearer atlasgate-dev-key"

curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## 管理接口分组

管理端统一用 cookie 会话：先登录保存会话，后续请求带 Cookie（见下方「调用示例」）。

### 认证与会话

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/login` | 管理员登录；body `{"username","password"}`，设置 HttpOnly cookie |
| POST | `/api/auth/logout` | 登出并作废会话 |
| GET | `/api/auth/session` | 查询当前会话 |
| POST | `/api/auth/password` | 修改密码；body `{"current_password","new_password"}`（新密码至少 12 字符） |

### 平台与用量

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/overview?range=7d` | 控制台总览（趋势、团队分布等） |
| GET | `/api/logs?limit=100` | 最近操作/事件日志 |
| GET | `/api/usage/breakdown` | 用量分组统计 |
| GET | `/api/provider-attempts?limit=100` | 每次上游 attempt 留痕 |
| GET | `/health` | 健康检查（无认证） |

### 组织 / 团队 / 用户

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/organizations` | 列出 / 创建组织 |
| GET / POST | `/api/teams` | 列出 / 创建团队 |
| POST | `/api/teams/:id/members` | 添加团队成员 |
| GET / POST | `/api/users` | 列出 / 创建用户 |

### Provider、模型映射与密钥

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/providers` | 列出 / 创建 Provider（`kind`: `openai` / `anthropic` / `mock`） |
| PATCH / DELETE | `/api/providers/:id` | 启用/停用（body `{"enabled"}`）/ 删除 Provider |
| POST | `/api/providers/:id/test` | 连通性测试 |
| POST | `/api/providers/:id/balance` | 刷新上游余额（如 DeepSeek） |
| GET / POST | `/api/providers/:id/credentials` | 凭据池：列出 / 新增 |
| PATCH | `/api/providers/:id/credentials/:credentialId` | 启用/停用凭据 |
| GET / POST | `/api/model-mappings` | 列出 / 创建模型映射 |
| PATCH / DELETE | `/api/model-mappings/:id` | 编辑 / 删除模型映射 |
| POST | `/api/routing/simulate` | 路由决策诊断模拟 |
| GET / POST | `/api/keys` | 客户端密钥：列出 / 创建 |
| PATCH / DELETE | `/api/keys/:id` | 启用/停用 / 删除客户端密钥 |

Provider 密钥只在服务端保存，接口不会返回密钥内容。

### 知识库与版本治理

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/knowledge-bases` | 列出 / 创建知识库（body 可含 `name`、`description`、`ingest_mode`（`review`/`auto`）、`merge_batch_size`、`merge_interval_minutes`、`compile_model`） |
| PATCH / DELETE | `/api/knowledge-bases/:id` | 更新知识库配置 / 删除知识库 |
| POST | `/api/knowledge-bases/:id/import` | 导入文档为 pending Change（body `filename`、`media_type`、`data_base64`、`author`，可选 `path`、`publish`） |
| GET | `/api/knowledge-bases/:id/imports` | 导入记录 |
| GET | `/api/knowledge-bases/:id/documents?version=` | 当前（或指定版本）文档列表 |
| GET | `/api/knowledge-bases/:id/document?path=&version=` | 单个文档内容 |
| GET | `/api/knowledge-bases/:id/pages?page_type=&version=` | 页面列表（可筛 `page_type`） |
| GET | `/api/knowledge-bases/:id/versions` | 不可变 Master 版本列表 |
| GET | `/api/knowledge-bases/:id/versions/:version` | 指定版本快照 |
| GET / POST | `/api/knowledge-bases/:id/changes` | 列出 pending Changes / 提交 Change（body `base_version`、`path`、`operation`（`upsert`/`delete`）、`content`、`author`，可选 `batch_id`） |
| PATCH / DELETE | `/api/knowledge-bases/:id/changes/:changeId` | 编辑 / 删除 Change |
| GET | `/api/knowledge-bases/:id/changes/:changeId/revisions` | Change 修订历史 |
| POST | `/api/knowledge-bases/:id/merge` | 合并 pending Changes 为新的不可变 Master（body `summary`） |
| POST | `/api/knowledge/merge-due` | 手动触发到期自动合并（仅 `auto` 模式库） |
| POST | `/api/knowledge-bases/:id/maintenance` | 维护任务（清理过期 Memory、重复 chunk 检测、到期合并） |
| GET / PUT | `/api/knowledge-bases/:id/schema` | 读取 / 更新 schema.md（人工协同，走 Change 链） |
| GET / PUT | `/api/knowledge-bases/:id/purpose` | 读取 / 更新 purpose.md（人工协同，走 Change 链） |
| GET | `/api/knowledge-bases/:id/conflicts` | 冲突账本 |
| GET / POST | `/api/knowledge-bases/:id/collaborators` | 协作成员列表 / 设置成员角色（body `user_id`、`role`） |

### LLM Wiki 摄入、审阅、Lint、同步与导出

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/knowledge-bases/:id/ingest` | 入队摄入（返回 202）；body `kind`（`document`/`paste`/`url`）、`filename`、`text`/`url`/`data_base64`+`media_type`，可选 `force: true` 强制重新摄入、`author` |
| GET | `/api/knowledge-bases/:id/ingest-queue?limit=` | 摄入队列 |
| POST | `/api/knowledge-bases/:id/ingest-queue/:jobId/cancel` | 取消摄入任务 |
| POST | `/api/knowledge-bases/:id/ingest-queue/:jobId/retry` | 重试摄入任务 |
| GET | `/api/knowledge-bases/:id/sources` | 已摄入素材列表 |
| GET | `/api/knowledge-bases/:id/research-jobs?status=` | 编译器提出的调研任务 |
| GET | `/api/knowledge-bases/:id/reviews?status=open` | 批次审阅项（默认 `open`） |
| PATCH | `/api/knowledge-bases/:id/reviews/:reviewId` | 处理审阅项（body `status`：`open`/`resolved`/`dismissed`，可选 `action`） |
| POST | `/api/knowledge-bases/:id/reviews/resolve` | 批量处理审阅项（body `ids`，可选 `action`） |
| POST | `/api/knowledge-bases/:id/lint` | 运行 Lint（body `mode`：`structural` 自动 / `llm` 手动，需真实模型） |
| GET | `/api/knowledge-bases/:id/lint-reports?status=open` | Lint 报告（默认 `open`） |
| PATCH | `/api/knowledge-bases/:id/lint-reports/:reportId` | 更新报告状态 |
| POST | `/api/knowledge-bases/:id/lint-reports/:reportId/create-page` | 由 Lint 报告一键生成页面（201） |
| POST | `/api/knowledge-bases/:id/sync` | 发布后触发 `knowledge/<库>/` md 镜像同步 |
| GET | `/api/knowledge-bases/:id/export?version=` | 导出 ZIP（`application/zip` 附件） |

### 检索与语义索引

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/knowledge-bases/:id/search` | 混合检索（默认）：body `query`、`top_k`（≤20）、`min_score`、`keyword_weight`、`vector_weight`、`path_glob`、`include_raw`（含降级页）、`include_system`（含系统页）；未配置 embedding 时退化为纯词法 |
| GET | `/api/knowledge-bases/:id/semantic-index` | 语义索引任务列表 |
| POST | `/api/knowledge-bases/:id/semantic-index` | 为指定 `version`（默认 Master）重建向量索引（202） |

### Agent、Skills 与 Memory

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/agents/knowledge/ask` | 知识 Agent 提问；body `kb_id`、`question`，可选 `model`、`save_to_wiki`/`sediment`（显式沉淀）、`query_title`、`use_memory`、`session_id`、`memory_importance` 及检索参数 `top_k`/`multihop`/`include_raw`/`directories`。返回 `run_id`/`answer`/`sources`/`routing`/`memory`/`skills`/`runtime`/`retrieval_mode`/`rewritten_question`，沉淀成功时含 `saved_to_wiki` |
| GET | `/api/agents/knowledge/status?model=auto` | Agent 实际路由到的模型与执行模式 |
| GET | `/api/agents/runs?limit=20` | 运行记录（问题/答案/引用来源/用时） |
| GET / POST | `/api/skills` | 列出 / 创建技能（body 可含 `retrieval`：`top_k`、`multihop`、`include_raw`、`directories`） |
| POST | `/api/skills/import` | 从 `SKILL.md` / `skill.json` 导入技能包 |
| GET | `/api/skill-imports?limit=100` | 技能导入账本 |
| PATCH / DELETE | `/api/skills/:id` | 更新 / 删除技能（DELETE 自动解挂） |
| GET | `/api/skills/:id/versions` | 技能版本历史 |
| POST | `/api/skills/recommend` | 按描述推荐技能（body `description`、`limit`） |
| POST | `/api/skills/merge` | 合并技能 |
| POST | `/api/agents/:agentId/skills/:skillId` | attach/detach 技能到 Agent（body `attached`，如 `/api/agents/knowledge-agent/skills/:id`）；attach 后其 `retrieval` 声明注入检索参数 |
| GET / POST | `/api/memories` | Memory：列出（筛 `session_id`/`agent_id`/`status`）/ 创建（body `session_id`、`content` 必填） |
| DELETE | `/api/memories/:id` | 遗忘 Memory（body `reason`） |
| POST | `/api/memories/:id/supersede` | 以新 Memory 取代旧 Memory |

## 调用示例

> 以下命令在默认开发配置（`npm start`，控制台 http://127.0.0.1:4310，admin / atlasgate-admin）下实测通过。管理端先登录一次并保存会话，后续都用 `-b cookies.txt`：

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
```

建库 → 导入 → 查看 Change → 合并（`$KB` 承接建库返回的 id）：

```bash
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"示例库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUg5YWl6ZeoCgpBdGxhc0dhdGUg5piv6Z2i5ZCR5bCP5Z6L5Zui6Zif55qE5pys5ZywIExNTSDln7rnoYDorr7mlr3vvJrlpJrljY/orq7nvZHlhbMgKyDniYjmnKzljJYgTExNIFdpa2kgKyDnn6Xor4YgQWdlbnTjgIIK","author":"tester"}'

curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'
```

混合检索（未配置 embedding 时自动退化为纯词法）：

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"AtlasGate","top_k":5}'
```

LLM Wiki 摄入（两步编译；无真实模型时降级为原文存档页）与审阅/Lint：

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。"}'

curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/reviews?status=open"
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint" \
  -H 'content-type: application/json' -d '{"mode":"structural"}'
```

知识 Agent 提问 + 问答沉淀（ADR-015），以及技能 attach：

```bash
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"save_to_wiki\":true}"
# 响应含 saved_to_wiki（沉淀为 queries/ 页，review 库留 pending）

SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-8","description":"深取8页","instructions":"按证据回答","retrieval":{"top_k":8,"multihop":true}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'
```

语义索引、md 镜像同步与 ZIP 导出：

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/sync" \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head
```

## 知识检索约定

检索结果包含证据页面路径、章节、chunk 序号、分数、内容和 Master 版本。pending Change 永远不会作为生产证据返回；系统页（`index.md`/`log.md`/`purpose.md`/`schema.md`/`overview.md`）与降级页（`atlasgate-degraded` 标记）默认不参与检索（可传 `include_system`/`include_raw` 显式包含）。

提交 Change 示例：

```json
{
  "base_version": 3,
  "path": "policies/token-budget.md",
  "operation": "upsert",
  "content": "# Token budget\n...",
  "author": "ops-agent"
}
```

完整路由和稳定错误码以 `src/app.js` 为准。
