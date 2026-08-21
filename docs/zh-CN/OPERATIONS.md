# 运维手册

> 版本基线：**0.4.0**（测试 Node 92 / Python 19；零 npm 运行依赖）。AtlasGate 是单机模块化单体。应保持回环监听或置于可信反向代理之后，并持续观察进程、数据库、Python worker、Provider、摄入队列和索引状态。以下示例默认开发配置（`npm start`，控制台 http://127.0.0.1:4310，admin / atlasgate-admin）实测通过；管理端先登录保存会话。`$KB` 为建库返回的 id（`POST /api/knowledge-bases`，见 [USAGE.md](USAGE.md) 示例）；Provider id 示例 `prv_30bebf0038914b319047` 来自开发库种子，请替换成你的实际 id：

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
```

## 健康检查

`GET /health` 返回版本（0.4.0）、数据库状态、Python worker pool 状态和检索配置状态。`python_pool` 的 `queued`、`rejected` 持续增长或 `restarts` 频繁增加时，需要调查 worker、SQLite 读取和上游服务：

```bash
curl http://127.0.0.1:4310/health | python3 -m json.tool
# 关注字段：
#   version: "0.4.0"            当前版本
#   database: "ready"           数据库可写
#   python_pool.state            ready / unhealthy（unhealthy = worker 启动失败，快速失败不泄漏）
#   python_pool.queued/rejected/restarts
#   retrieval.mode/backend/enabled  检索模式与是否真正启用稠密检索
```

## 总览指标

控制台总览显示请求量、输入/输出/总 token、估算花费、成功率、延迟、Provider 健康状态和上游余额。花费是按当前 Provider 费率估算，不是账单；余额时间戳用于区分最新值和保留的旧值。API 形式：

```bash
curl -b cookies.txt "http://127.0.0.1:4310/api/overview?range=7d"   # 24h | 7d | 30d
curl -b cookies.txt "http://127.0.0.1:4310/api/usage/breakdown"
```

## Provider 故障

1. 查看健康状态、attempt 记录和最近余额错误。
2. 禁用故障 Provider，使其退出新路由。
3. 删除配置前确认其他 Provider 仍然可用。
4. 最近 30 秒内有 attempt 的 Provider 不能删除。
5. 删除后历史用量和 attempt 证据仍应保留。

```bash
# 1) 列出 Provider（健康状态、凭据数）与最近 attempt 记录
curl -b cookies.txt http://127.0.0.1:4310/api/providers
curl -b cookies.txt "http://127.0.0.1:4310/api/provider-attempts?limit=20"

# 2) 单项测试与余额刷新（DeepSeek 自动走官方 /user/balance；把 prv_... 换成你的 Provider id）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/providers/prv_30bebf0038914b319047/test \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/providers/prv_30bebf0038914b319047/balance \
  -H 'content-type: application/json' -d '{}'

# 3) 禁用/恢复：PATCH /api/providers/:id  body {"enabled":false}
```

## 知识库故障

不要直接修改已发布的数据库行或 Markdown 镜像。检查 pending Change、revision 历史和冲突账本。错误的待发布修改应撤销（PATCH/DELETE change）；已发布错误应保留原版本证据，再提交修正 Change 发布新版本（不可变 Master）：

```bash
# 查看 pending 变更（含批次 batch_id、作者、冲突标记）与冲突账本、版本历史
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions"

# 撤销一条待发布修改（删除该 pending change；已发布内容请走修正 Change，勿改行）
curl -b cookies.txt -X DELETE "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes/<changeId>"

# 检索核验（hybrid 默认；未配 embedding 自动降级纯词法页面检索）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"石壁 线索","top_k":5}'
```

## Worker 饱和

队列持续堆积时先分析检索和外部服务延迟，再考虑增加 pool size（`ATLASGATE_PYTHON_WORKER_POOL_SIZE`，默认 2）。超时会回收对应 worker；反复崩溃通常说明输入或解析缺陷，不应通过无限重试掩盖。`ATLASGATE_PYTHON_WORKER_QUEUE_LIMIT`（默认 100）满载时新请求返回 503，属预期背压。

```bash
# 观察池状态（queued/rejected/restarts）与 Agent 运行记录
curl http://127.0.0.1:4310/health | python3 -m json.tool
curl -b cookies.txt "http://127.0.0.1:4310/api/agents/runs?limit=20"
```

## 摄入队列故障

摄入是持久化队列（`/ingest-queue`）：同库串行、失败自动重试 ≤2 次、崩溃重启恢复（`recoverRunning`）。产物按批次（共享 `batch_id`）留 pending（review 库）或自动合并（auto 库）。素材按内容 SHA256 去重，相同内容返回 `skipped:true / reason:duplicate_content`——上次编译失败想重编时传 `force:true` 绕过去重重新入队。

```bash
# 队列状态（pending → running → done/failed）与失败原因
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=10"

# 强制重新摄入（绕过 SHA256 去重重新入队）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。","force":true}'

# 编译器产生的 Review 队列（deep_research/verify 等）与 Lint 报告
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/reviews?status=open"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint-reports?status=open"
```

## 语义索引故障

检查 `/api/knowledge-bases/:id/semantic-index`（job 状态/错误），修复 Embedding、Qdrant、维度或凭据配置后重试。索引失败不会修改已发布 Master。`hybrid`（默认）未配置 `ATLASGATE_EMBEDDING_BASE_URL` 时自动降级纯词法；`qdrant` 模式配置完整时只走 Qdrant，不会混用本地向量，但若缺 `ATLASGATE_QDRANT_URL` 或 embedding 配置，`/health` 的 `retrieval.enabled` 为 false，搜索同样回退词法——请以 `/health` 的 `retrieval` 字段核对实际模式：

```bash
# 查看索引任务与错误
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index"

# 重建当前 Master 索引（缺索引时首次搜索会自动触发）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'

# 核验检索模式：mode=hybrid + enabled=true 表示词法+本地稠密向量 RRF 融合生效
curl http://127.0.0.1:4310/health
```

## 备份与容量

对 SQLite 做一致性备份（先 `PRAGMA wal_checkpoint(TRUNCATE)` 再复制，见 [CONSOLE_OPS.md](CONSOLE_OPS.md) 第 2 节）；启用语义检索时同步考虑 Qdrant 快照。监控数据库和 WAL 大小、请求 p95、队列深度、知识 chunk 数量以及每个 Master 版本的 Qdrant collection 数量。
