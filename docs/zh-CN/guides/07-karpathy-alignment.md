# Karpathy LLM Wiki 方法论对照

> ID: `KAR-001`  
> 评估基准: [Karpathy LLM Wiki gist](../../references/karpathy-gist.md)  
> 结论: `部分符合，且做了数据库化扩展`

## 1. 结论先行

AtlasGate 符合 Karpathy 方法论的核心思想，但不完全符合其示例形态。

它已经实现了“原始素材 -> 持久化 Wiki -> Schema/目的”的三层模型、持续摄入、页面互链、索引、日志、查询回存和 Lint。主要差异是：Karpathy 描述的是目录中的 Markdown 仓库，而 AtlasGate 把 SQLite 的版本化 Master 作为事实源，`knowledge/<id>/` 只是发布后的只读镜像。

因此准确表述应是：

> AtlasGate 是一个以 SQLite 版本治理为核心、以 Markdown 为派生交互格式的 LLM Wiki 实现，而不是一个直接以文件系统 Git 仓库为事实源的 LLM Wiki。

## 2. 对照矩阵

| Karpathy 要求 | 当前实现 | 判断 | 证据 |
|---|---|---|---|
| Raw Sources 不可变 | `wiki_sources` 保存内容、hash、状态；强制重新摄入会删除旧 source | 部分符合 | `src/db.js`、`src/services/wiki-compiler.js` |
| Wiki 是持久化、互链的 Markdown 页面 | 页面存于 `knowledge_documents`，发布后同步为 Markdown；支持 WikiLink、页面类型和 frontmatter | 符合核心，形态不同 | `knowledge.js`、`wiki-sync.js` |
| Schema 指导 LLM 工作流 | 每个库有 `schema.md`、`purpose.md`，并经过 Change 发布 | 部分符合 | `knowledge/1/schema.md`、`knowledge.js` |
| 摄入时更新实体、概念和综合页面 | 两步编译会生成多类页面，自动维护 `index.md`、`log.md`、`overview.md` | 符合 | `wiki-compiler.js`、Wiki phase tests |
| index.md 内容目录 | 系统页存在，编译后更新 | 符合 | `systemPageTemplates()`、`knowledge/*/index.md` |
| log.md 时间日志 | 有 `wiki_log` 和 `log.md` 镜像 | 符合 | `src/db.js`、`wiki-compiler.js` |
| 查询结果可以回存 | `save_to_wiki` 生成 `queries/<slug>.md` Change | 符合 | `src/services/agent.js` |
| Lint 发现矛盾、孤立页和缺口 | 结构 Lint 自动执行，LLM Lint 手动执行；有报告生命周期 | 部分符合 | `src/services/lint.js` |
| Obsidian/Git 直接浏览和版本管理 | Obsidian 镜像和 ZIP 导出有；镜像不是写入入口，Git 协作不是事实源 | 部分符合 | `src/services/wiki-sync.js`、`wiki-export.js` |
| 人类负责来源和方向，LLM 维护 Wiki | `review` 默认人工审阅，`auto` 可自动发布 | 符合，但 auto 需谨慎 | `docs/zh-CN/WIKI.md`、`knowledge.js` |

## 3. 关键差距

### 3.1 Schema 是否真正进入每次 LLM 上下文

摄入链路已经有 Python 单元测试证明：analysis prompt 会带入 purpose、schema、index 和相关页面；generation prompt 会带入 schema、公约和待更新页面。证据位于 `python/tests/test_ingest.py`。

但 Agent 查询 prompt 当前主要包含检索结果、Memory 和 Skills；`python/atlasgate_agent/engine.py` 没有把 `purpose.md`、`schema.md` 或 `index.md` 作为固定上下文注入。因此“Schema 驱动摄入”已成立，“Schema 驱动每次查询”仍应标记为 `partial`，不能仅因为数据库中存在系统页就宣称完全符合。

若要补齐，应增加查询 prompt 的上下文选择和长度预算，并增加测试证明：

- query prompt 包含当前 Master 的目的和引用规则。
- schema 版本变化后，后续回答使用新规则。
- index 作为导航目录使用，但不会污染默认证据。

### 3.2 Raw source 的不可变性

当前 `force` 摄入会删除同 hash 的旧 `wiki_sources` 记录后重新创建。它不改变已有 Master 页面，但严格来说不是 raw source 账本的不可变追加模型。建议改为保留旧 source，新增 `supersedes_source_id` 或 `ingest_attempts`，让重新摄入仍可审计。

### 3.3 目录索引是否是 Agent 的首要导航入口

原始方法论强调 Agent 先读 `index.md`，再深入具体页面。当前检索主要直接查询数据库中的页面和向量；`index.md` 是系统页并默认排除。因此这是性能和治理上的合理扩展，但不是原始工作流的完全复刻，文档应明确这一点。

### 3.4 反复综合与矛盾维护

当前编译器能生成实体、概念、摘要和 Review 项，也有 Lint，但“新来源持续修订旧页面、显式处理相互矛盾的事实”仍主要依赖 LLM 输出和人工 Review。不能仅凭存在 `confidence` 或 `conflict` 字段就宣称已经完成知识层面的事实合并。

## 4. 建议的补强顺序

1. 增加 prompt 追踪测试，证明 schema/purpose/index 的使用位置。
2. 将 raw source 重新摄入改为追加式审计，不删除历史 source。
3. 为每个生成页面保留来源 hash、生成 run、使用的 schema 版本和模型信息。
4. 增加“旧页面被新来源修订”和“新旧来源冲突”的端到端测试。
5. 在 `/api/knowledge-bases/:id/pages` 中显示页面的来源、版本和生成批次。
6. 明确区分“结构 Lint 已实现”和“语义矛盾检测仍依赖 LLM/人工”。

## 5. 最终评级

| 维度 | 评级 |
|---|---|
| 三层架构思想 | 符合 |
| 持久化、互链 Wiki | 符合核心 |
| Raw source 严格不可变 | 部分符合 |
| Schema 驱动 LLM | 需要 prompt 证据，暂评部分符合 |
| 摄入后持续维护 | 符合基础链路，语义维护部分依赖模型 |
| Index/log 机制 | 符合 |
| 查询回存 | 符合 |
| Lint 与矛盾维护 | 结构能力符合，语义能力部分符合 |
| 文件/Git 仓库形态 | 不同实现，不应宣称完全一致 |
