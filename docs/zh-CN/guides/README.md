# AtlasGate 开发者功能指南

本目录解释 AtlasGate 的功能如何实现。它面向需要阅读、调试或扩展代码的开发者，不替代面向使用者的 [文档导航](../README.md)。

## 阅读方式

每篇指南都从一个可验证的业务能力出发，串起以下内容：

```text
用户意图 -> HTTP/内部入口 -> 服务 -> 核心算法 -> 数据库/队列 -> 输出 -> 测试
```

不要把一个源文件当成一个功能。一个功能可能跨越 `src/app.js`、`src/services`、`src/core`、`python`、`web` 和 `test`。

推荐阅读顺序：

1. [系统运行时](00-system-runtime.md)
2. [网关、协议与治理](01-gateway-and-governance.md)
3. [知识版本与发布](02-knowledge-versioning.md)
4. [文档摄入与 LLM Wiki 编译](03-wiki-ingest-and-compiler.md)
5. [检索与 Knowledge Agent](04-retrieval-and-agent.md) — 混合 RRF 检索、查询改写、问答沉淀、query_hits 热度、技能检索注入（ADR-015）
6. [图谱、镜像与导出](05-graph-sync-and-export.md)
7. [前端控制台与 MCP](06-console-and-mcp.md)
8. [Karpathy 方法论对照](07-karpathy-alignment.md)

## 文档契约

- `FEATURE_MATRIX.md` 是功能、代码、接口、测试和状态的追踪入口。
- 每个 `implemented` 声明必须关联实现文件和自动化测试。
- 代码地图优先使用文件和符号链接；代码片段只解释关键机制，不复制完整源文件。
- 行为、接口、数据模型或错误语义变化时，必须同步更新对应指南。
- 当前实现的事实源是代码和测试；指南、API 文档和架构文档是解释层。
- 指南与矩阵必须与当前版本基线一致（版本 0.4.0，测试 Node 92 / Python 19，默认端口 4310）。
- `partial`、`fallback`、`planned` 必须写出触发条件和用户可观察行为。

## 复现指南中的某个功能

指南里的每个 ID 都能在矩阵中找到入口与测试。例如复现 ADR-015 的问答沉淀 / 引用热度 / 技能检索（对应 `AG-002` / `AG-003` / `AG-004`）：

```bash
npm start   # 默认 http://127.0.0.1:4310

# 登录后建库并提问（save_to_wiki=true 显式沉淀，review 库留 pending Change）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"复现库"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"save_to_wiki\":true}"

# 沉淀产物是 queries/<slug>.md Change；图谱节点带 query_hits 热度
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits)"' | head

# 聚焦测试（沉淀/热度/技能检索）
node --test test/wiki-phase7.test.js test/wiki-phase8.test.js
```

## 修改前的 Grill 问题

在扩展一个功能前，先回答：

- 这是新的业务能力，还是现有能力的参数变化？
- 入口、状态、数据所有权和发布边界分别在哪里？
- 哪些不变量必须始终成立？
- 上游失败、重复请求、并发修改和进程重启时会发生什么？
- 哪个自动化测试证明这项行为存在？
- 这项能力是产品承诺，还是仅限本地 mock/fallback？

