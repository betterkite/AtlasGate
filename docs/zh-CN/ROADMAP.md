# 项目路线图

## 已完成的基础能力

- OpenAI Chat、Responses、Anthropic Messages、Embeddings 和兼容 SSE envelope。
- 能力感知的模型映射、加权凭据池、有界 Failover 和 attempt 证据。
- 组织、团队、用户治理，以及带 scope、限流、配额和预算的客户端密钥。
- 多用户知识 Change、乐观 revision、定时合并、冲突账本和版本化文档/图谱。
- MD/TXT/PDF 导入、Hybrid 检索、Knowledge Agent、Memory、Skills 和 MCP。
- 管理控制台、备份/运维文档和回归测试。

## LLM Wiki 已完成能力

- `wiki_sources`、`ingest_queue`、`ingest_cache`、`review_items`、`lint_reports`、`research_jobs` 和 `wiki_log`。
- 页面类型、标题、frontmatter、置信度和来源溯源。
- `purpose.md`、`schema.md`、`index.md`、`log.md`、`overview.md` 五个系统页。
- 两步编译、Review、结构 Lint、查询回存、图谱社区、洞察、Markdown 同步和 ZIP 导出。

## 下一阶段优先事项

- 将 raw source 重新摄入改为追加式审计，并补充生成 lineage。
- 将 Schema/purpose 上下文注入 Agent 查询 Prompt，并记录 Prompt 使用的版本。
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

