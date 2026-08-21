# LLM Wiki 知识库（Wiki）使用知识

本模块对应控制台视图 08「Wiki 知识库」与「知识版本」里的摄入/审阅/Lint。**如果你在找"知识库保存的 md 文件在哪"，先看第 1 节。**

## 1. Wiki 页面存在哪？（重要）

AtlasGate 的知识库页面**存在 SQLite 数据库**（`data/atlasgate.db` 的 `knowledge_documents` 表），这是唯一事实源——因为要支持多用户版本治理、冲突账本与审计。磁盘上有两种"文件形态"：

| 形态 | 位置 | 说明 |
| --- | --- | --- |
| **自动 md 镜像** | `knowledge/<知识库名>/`（项目根目录） | 每次发布后自动同步；Obsidian 可直接打开；包含 `.obsidian/` 配置；**只读镜像，请勿直接编辑**（修改请走控制台，会以 Change 进入版本治理） |
| **导出 zip** | 控制台「导出 zip」按钮 | Master 快照打包（含 frontmatter），可下载到任意位置用 Obsidian/git 打开 |

- 同步时机：新建知识库 → 立即；每次 merge 发布 → 自动；服务启动 → 全量补同步；控制台「同步 md」按钮 → 手动。
- 删除的页面会从镜像里移除（manifest 跟踪）。
- 关闭镜像：`ATLASGATE_WIKI_SYNC_DIR=""`；换目录：`ATLASGATE_WIKI_SYNC_DIR=/path/to/vault`。
- 想用 git 管 wiki：目录默认 gitignore，可 `git add -f knowledge/`。

## 2. 三层模型（Karpathy 方法论）

```
Raw Sources（原始素材，不可变）→ wiki_sources 表
        │ LLM 编译（两步）
        ▼
Wiki（LLM 维护的 Markdown 页面）→ knowledge_documents 表（版本化）+ knowledge/ 镜像
        │ 遵守
        ▼
Schema（公约与目的）→ schema.md / purpose.md（可编辑，修改走 Change）
```

## 3. 页面分类

| 目录 | type | 用途 |
| --- | --- | --- |
| `entities/` | entity | 人物/组织/产品/工具 |
| `concepts/` | concept | 理论/方法/技术 |
| `sources/` | source | 每个素材的摘要页（`sources[]` 溯源）；**降级原文存档页也在这里**（带 `atlasgate-degraded: true` 标记） |
| `comparisons/` `synthesis/` `queries/` | comparison/synthesis/query | 对比、综合、保存的问答 |
| 根目录 | purpose/schema/index/log/overview | 系统页（**index/log/overview 由编译管线每次摄入后维护**；purpose/schema 人工+LLM 协同编辑） |

每个页面带 frontmatter：`type / title / sources[] / confidence / tags`（index/log/overview 等系统导航页 `sources: []`）。

**编译页 vs 原文存档（降级页）**：两步编译成功后写入的是**编译页**（LLM 总结的知识，参与正常查询）；当模型不可用或反复编译失败时，管线退化为**原文存档页**（`sources/<slug>.md`，frontmatter 带 `atlasgate-degraded: true`）。降级页**不参与默认检索**（避免把原始 chunk 当"编译后知识"），但保留在 Wiki 中可查（搜索/查询带 `include_raw:true` 可见）；之后可对该素材勾选「强制重新摄入」重跑编译，成功后降级页会被编译页取代。

## 4. 两步编译管线（Ingest）

```
入队（粘贴/URL/文档）→ SHA256 去重 → ①分析（LLM：实体/概念/矛盾/页面计划）
→ ②生成（LLM：写出页面，含 frontmatter）→ 校验（路径白名单/密钥丢弃/页数上限）
→ 批量 Change（author=wiki-compiler，共享 batch_id）→ review 或 auto 合并
→ 派生 Review 项 / Research 任务 / 更新 log
```

- **无真实 Provider**：退化为"素材存档 + 原文成页"（离线可用）。
- **LLM 编译失败兜底**：模型反复返回空完成/截断 JSON 时，管线自动降级为"原文存档成页"（wiki_log 记录原因），素材永不丢失；之后可勾选「强制重新摄入」重试。
- **页数上限**：每素材 ≤ `ATLASGATE_WIKI_MAX_PAGES_PER_SOURCE`（默认 20）。
- **系统页维护**：每次成功编译，管线**必须**同时更新 `index.md`（目录：新页面一行链接+摘要）、`log.md`（时间线：`## [日期] ingest | 标题`）、`overview.md`（全局总览），三者随同一批次 Change 一起进入版本治理——这就是"导航由编译器持续维护"的机制（Karpathy 方法论的 index/log 公约）。
- **安全**：含私钥/`sk-` 密钥的页面丢弃；路径越权丢弃；缺 frontmatter 记缺陷。
- **去重**：相同内容跳过（`ingest_cache`）。**同一内容再次上传会提示"重复内容跳过"**——如果之前那次编译失败或你想重新编译，勾选摄入表单的「强制重新摄入」或在 API 传 `force:true` 即可绕过去重重新入队。
- **失败重试**：队列失败自动重试 ≤2 次，崩溃重启恢复。

## 5. 检索（Hybrid：词法 + 本地向量，RRF 融合）

知识 Agent 查询默认走 **Hybrid 页面级检索**（`retrieval_mode="hybrid"`，RAG_PLAN.md / ADR-012）：

```
question
  → Node 向量检索（整页命中，semantic_vectors 表 + 余弦）
  → python 词法检索（bigram 词表重叠，_retrieve_pages）
  → RRF 融合（score = Σ 1/(60 + rank)，零权重调参）
  → top-k 整页证据 → LLM（带 [1][2] 引用）
```

- **词法命中**：专有名词、精确用词；**向量命中**：同义改写、语义相近页面（问"丹药反噬"能带出写"脱锚副作用"的页面）。
- **页面级**：每页一个向量（`semantic_vectors` 表，版本化）；排除系统页与降级存档页（`include_system` / `include_raw` 可放开）。
- **降级**：未配置 embedding 服务时自动退回纯词法（与旧行为完全一致）；`retrievalMode=local` 可显式关闭向量。
- **部署 embedding**（可选）：本地 `python3 python/atlasgate_agent/embedding_worker.py --model <bge-small-zh 目录>` 起 ONNX 服务（唯一新增依赖 `onnxruntime`），设 `ATLASGATE_EMBEDDING_BASE_URL=http://127.0.0.1:8031/v1`；或接任意 OpenAI 兼容 `/v1/embeddings` API。DeepSeek 官方无 embedding 模型。
- **纯向量**：`retrievalMode=qdrant`（需 Qdrant 服务，保留为可选后端）。
- **伪重排（阶段 2）**：RRF 融合后，图谱 related 边度数高的页面（更核心）获得小幅加成，只打破平局不颠覆排序（零新依赖）。
- **低置信查询改写（阶段 2）**：首轮检索 0 命中且路由到真实模型时，LLM 把问题改写成更可检索的形式重试一次；结果在响应里以 `rewritten_question` 返回（`ATLASGATE_QUERY_REWRITE_ENABLED` 默认开，mock 路由下自动跳过）。
- **多跳扩展（阶段 3）**：首轮命中页里的 `[[wikilink]]` 指向的页面（最多 3 个）自动并入证据（`expansion="linked"`），零额外 LLM 调用——跨页拼答案时链接图是跳板（`multihop:false` 可关闭）。
- **证据充分性判定（阶段 3）**：Agent 被告知"证据不支持就明说"；首轮 0 命中时返回明确的"无足够证据"答案（不编造）。
- 旧版 chunk 检索（BM25+向量）保留为 `retrieval_mode="chunk"` 的显式回退。

## 6. 审阅与发布

- `ingest_mode=review`（默认）：编译产物留 Pending，在「待合并变更」按**批次**查看，可逐条改/撤销、**整批打回**、发布合并。
- `ingest_mode=auto`：自动合并发布（个人库适用）。
- Review 队列：LLM 标记"需人工判断"的项（核实/建页/研究），可已处理/忽略/全部处理。

## 7. 图谱（企业级交互）

- **力导向布局**：节点按链接数 √ 缩放，社区着色，related 边按权重变色加粗。
- **交互**：拖单个节点（位置记忆）/ 拖空白平移 / 滚轮缩放 / 悬停预览卡（名称/路径/类型/度数/社区）/ 点击选中详情（Wiki 视图可"打开页面"）/ 搜索框定位 / 小地图 / 适应按钮 / 标题节点开关。

## 8. Lint 体检

- 结构级（孤立页/断链/index 一致性）纯 SQL、免费，**每次发布自动跑**；LLM 级（矛盾/过时/数据缺口）需真实模型，手动触发。
- 报告可 ack/忽略；missing_page 报告可**一键创建 stub 页面**（走 Change）。

## 9. 查询回存（save_to_wiki）

知识 Agent 回答时勾选「回存 Wiki」（或 API `save_to_wiki:true`），答案保存为 `queries/<slug>.md`（含 `sources[]` 溯源），review 模式留 pending、auto 模式直接发布。

## 10. 相关文档

- [GETTING_STARTED.md](GETTING_STARTED.md)（含"知识库 md 在哪"的实操）
- [KNOWLEDGE.md](KNOWLEDGE.md)（版本治理细节）
- [API.md](API.md)（`/ingest`、`/sync`、`/export`、`/lint`、`/reviews` 端点）
- 方法论原文：[references/karpathy-gist.md](../references/karpathy-gist.md)
