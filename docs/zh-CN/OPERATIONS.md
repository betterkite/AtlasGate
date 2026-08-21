# 运维手册

AtlasGate 是单机模块化单体。应保持回环监听或置于可信反向代理之后，并持续观察进程、数据库、Python worker、Provider、摄入队列和索引状态。

## 健康检查

`GET /health` 返回数据库、Python worker pool 和检索配置状态。`queued`、`rejected` 持续增长或 `restarts` 频繁增加时，需要调查 worker、SQLite 读取和上游服务。

## 总览指标

控制台总览显示请求量、输入/输出/总 token、估算花费、成功率、延迟、Provider 健康状态和上游余额。花费是按当前 Provider 费率估算，不是账单；余额时间戳用于区分最新值和保留的旧值。

## Provider 故障

1. 查看健康状态、attempt 记录和最近余额错误。
2. 禁用故障 Provider，使其退出新路由。
3. 删除配置前确认其他 Provider 仍然可用。
4. 最近 30 秒内有 attempt 的 Provider 不能删除。
5. 删除后历史用量和 attempt 证据仍应保留。

## 知识库故障

不要直接修改已发布的数据库行或 Markdown 镜像。检查 pending Change、revision 历史和冲突账本。错误的待发布修改应撤销；已发布错误应保留原版本证据，再提交修正 Change 发布新版本。

## Worker 饱和

队列持续堆积时先分析检索和外部服务延迟，再考虑增加 pool size。超时会回收对应 worker；反复崩溃通常说明输入或解析缺陷，不应通过无限重试掩盖。

## 语义索引故障

检查 `/api/knowledge-bases/:id/semantic-index`，修复 Embedding、Qdrant、维度或凭据配置后重试。索引失败不会修改已发布 Master；Qdrant 模式不会静默退回本地搜索。

## 备份与容量

对 SQLite 做一致性备份；启用语义检索时同步考虑 Qdrant 快照。监控数据库和 WAL 大小、请求 p95、队列深度、知识 chunk 数量以及每个 Master 版本的 Qdrant collection 数量。

