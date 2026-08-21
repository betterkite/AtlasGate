# 项目路线图

## 已完成的基础能力

- OpenAI Chat、Responses、Anthropic Messages、Embeddings 和兼容 SSE envelope（含 `/v1/models`、`/v1/messages/count_tokens`）。
- 能力感知的模型映射、加权凭据池、有界 Failover 和 attempt 证据。
- 组织、团队、用户治理，以及带 scope、限流、配额和预算的客户端密钥。
- 多用户知识 Change、乐观 revision、定时合并、冲突账本、tombstone 和版本化文档/图谱。
- MD/TXT/PDF 导入、Knowledge Agent、Memory、Skills 和 MCP。
- 管理控制台（免构建）、Docker 镜像、备份/运维文档和回归测试（Node 92 / Python 19）。

## LLM Wiki 已完成能力

- `wiki_sources`、`ingest_queue`、`ingest_cache`、`review_items`、`lint_reports`、`research_jobs` 和 `wiki_log`。
- 页面类型、标题、frontmatter、置信度和来源溯源。
- 两步编译（analysis→generation，deepseek-chat 等真实模型），持久化摄入队列、SHA256 去重与 `force:true` 强制重新摄入。
- per-KB `ingest_mode`（`review` 默认 / `auto`）、批次审阅（`batch_id`）；review 库留 pending，auto 库直接 merge。
- `index.md`、`log.md`、`overview.md` 由编译器维护，`purpose.md`/`schema.md` 人工协同；降级页带 `atlasgate-degraded` 标记且默认不参与检索。
- 两级 Lint：结构级（发布后自动）与 LLM 级（手动触发）；`knowledge/<库>/` md 镜像单向同步（Obsidian 可开、gitignore）与 ZIP 导出。

## RAG 混合检索与 ADR-015 已完成能力

- 混合检索（hybrid，默认）：词法 bigram 页面级 + 本地稠密向量（`semantic_vectors` 表，SQLite 余弦）按 **RRF** 融合；未配置 embedding 自动降级为纯词法；qdrant 可选后端。
- 本地 ONNX `bge-small-zh` embedding worker（`python/atlasgate_agent/embedding_worker.py`）或任何 OpenAI 兼容 `/v1/embeddings`（`ATLASGATE_EMBEDDING_BASE_URL`）；DeepSeek 无 embedding 接口。
- 伪重排（图谱度数）、零证据查询改写（`ATLASGATE_QUERY_REWRITE_ENABLED`，真实模型）、wikilink 多跳扩展、证据充分性（证据不足明说）。
- ADR-015 问答沉淀：`save_to_wiki`/`sediment` 显式，或相似问题≥3次 + 质量规则（≥2 来源引用、无证据不足、内容≥80 字）自动；产物 `queries/<slug>.md`，智能归类用 RRF 匹配 `concepts/`/`entities/` 页并 `[[wikilink]]` 关联；走 Change 审计链跟随 `ingest_mode`，同 slug 复用 pending change；沉淀页可编辑/删除/回滚；`ATLASGATE_QUERY_SEDIMENT_ENABLED` 默认开。
- 图谱 `query_hits` 问答引用热度（30 天窗口）。
- 技能检索策略：SKILL.md frontmatter 声明 `retrieval` 字段（`top_k`/`multihop`/`include_raw`/`directories`），attach 后注入检索参数（`multihop`/`include_raw` 任一 true 即开、`top_k` 取最大）；调用方显式参数优先；`DELETE /api/skills/:id` 已支持。

## 下一阶段优先事项

- 将 raw source 重新摄入改为追加式审计，并补充生成 lineage。
- 将 Schema/purpose 上下文注入 Agent 查询 Prompt（当前仅编译 Prompt 注入），并记录 Prompt 使用的版本。
- 为高风险知识库增加人工审批和领域级 merge function。
- 增加 OCR、DOCX/XLSX/EPUB 等可选解析器。
- 增加管理员 SSO、RBAC、CSRF、TLS 集成和更严格的 Provider 出口控制。
- 只有在规模需要时再拆分服务和迁移分布式存储。

## 后续 Agent 组件

- Data Agent：问题规划、数据目录发现、沙箱查询、数据校验和图表产物。
- Ops Agent：告警接入、Runbook 检索、风险分级、只读诊断和审批后修复。
- 本地推理控制器：vLLM/SGLang 模型库存、GPU 调度和压力路由。
- Skills 平台：签名包、评测排名、组织级作用域、合并谱系和回滚。
- Harness 注册表：版本化工作流、工具权限、预算、检查点、Trace 和人工审批。

## 不可绕过的发布规则

任何能够修改生产状态的组件，都必须经过：

```text
observe -> shadow -> approval-required -> canary -> active
```

P0 优先级不能绕过授权、幂等性、有界范围和回滚证据。

## 已完成能力可复现示例（默认端口 4310、默认凭据）

```bash
# 管理端登录（后续用 -b cookies.txt）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 建库（review 模式）-> 导入 -> 发布
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"示例库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUg5YWl6ZeoCgpBdGxhc0dhdGUg5piv6Z2i5ZCR5bCP5Z6L5Zui6Zif55qE5pys5ZywIExNTSDln7rnoYDorr7mlr3vvJrlpJrljY/orq7nvZHlhbMgKyDniYjmnKzljJYgTExNIFdpa2kgKyDnn6Xor4YgQWdlbnTjgIIK","author":"tester"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'

# LLM Wiki 两步编译摄入
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。"}'

# 混合检索（hybrid RRF）与图谱热度（ADR-015 B）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"石壁 线索","top_k":5}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits|community)"' | head

# Agent 提问并沉淀（ADR-015 A，review 库留 pending）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"save_to_wiki\":true}"

# 技能声明检索策略并 attach（ADR-015 C）
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-8","description":"深取8页","instructions":"按证据回答","retrieval":{"top_k":8,"multihop":true}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'

# 网关端 Bearer 示例
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```
