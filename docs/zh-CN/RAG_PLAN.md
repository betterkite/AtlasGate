# RAG 检索升级实施文档（RAG_PLAN）

> 状态：**三阶段全部实施并验收**（0.4.0 现状——阶段 1 hybrid RRF：词法 bigram + 本地稠密页面向量（SQLite `semantic_vectors`，ONNX bge-small-zh 或任何 OpenAI 兼容 embedding API），无 embedding 自动降级纯词法；阶段 2 伪重排（图谱度数）+ 零证据查询改写（`ATLASGATE_QUERY_REWRITE_ENABLED`，默认开）；阶段 3 wikilink 多跳扩展 + 证据充分性判定。全量测试 **Node 92 / Python 19** 绿；线上语义命中验收需配置真实 embedding 服务。bge-reranker（ONNX 交叉编码精排）未实施、延后）。
> 对应 grilling 设计树 Q1~Q11 全部决策（用户已按推荐确认）。
> 项目惯例：本文件检阅确认后，按阶段 1 → 2 → 3 逐 Phase 实施，每 Phase 验收后再进下一 Phase（Q21）。

## 1. 背景与问题

> 本节描述实施前（0.3.x）的基线；现状见文首状态与 §4。

实施前，知识 Agent 检索（`retrieval_mode="page"`，默认）是**纯词法**：中文 bigram 词表重叠给整页打分，取 top-k 整页作为证据。局限：

- **无语义匹配**：问"丹毒反噬"匹配不到写"脱锚副作用"的页面（同义改写失效）
- **无精排**：命中顺序只按词重叠数，噪声页可能排前
- **无多跳**：跨页面拼答案的问题无法逐步查证
- **无自主性**：模型不能判断"要不要检索、证据够不够"

现状基础（实施后，0.4.0）：`semantic-index.js` 提供 `embed()` → 索引 → 检索链路，默认 **local 后端**（页面级向量存 SQLite `semantic_vectors`，进程内 cosine；qdrant 为可选后端），`ATLASGATE_RETRIEVAL_MODE=hybrid` 为默认（无 embedding 自动降级纯词法）；python 侧 `precomputed_sources` 契约承载 Node 的页面级向量命中，与词法命中在 Python 内做 RRF 融合（`_rrf_fuse`）。

## 2. 目标（Q1：分三阶段）

| 阶段 | 目标 | 对应技术 |
| --- | --- | --- |
| **阶段 1** | 补语义短板（最优先） | Dense 向量检索 + 词法/向量混合（Hybrid RRF） |
| **阶段 2** | 提精度 | Reranker（先伪重排后 bge-reranker）+ 低置信查询改写 |
| **阶段 3** | 复杂问题 + 自主性 | wikilink 多跳扩展 + 证据充分性判定（轻量 Self-RAG） |

## 3. 决策记录（Q1~Q11）

| # | 决策 | 结论 |
| --- | --- | --- |
| Q1 | 目标 | E：全都要，分三阶段（上表） |
| Q2 | 向量依赖 | C：本地 ONNX 为主 + 外部 API 可选（DeepSeek 无 embedding，已核实） |
| Q3 | 融合方式 | B：Hybrid + RRF（倒数排名融合，零权重调参） |
| Q4 | 向量化单元 | A：整页（与 index 驱动整页阅读对齐） |
| Q5 | 向量存储 | A：SQLite 向量表（去 Qdrant 硬依赖；保留 Qdrant 可选后端） |
| Q6 | 模型选型 | A：bge-small-zh-v1.5（512 维，ONNX ≈50–100MB），配置可切 base/API |
| Q7 | 默认模式 | A：默认 hybrid，无 embedding 自动降级纯词法（现行为不变） |
| Q8 | Reranker | 先 C（多信号伪重排，零新依赖）后 A（bge-reranker ONNX）；**C 已实施，A 延后** |
| Q9 | 查询改写 | B：仅首轮低置信时 LLM 改写重试一次 |
| Q10 | 多跳 | A：首轮命中页提取 `[[wikilink]]` 扩展检索一轮（零额外 LLM 调用） |
| Q11 | Self-RAG | A：轻量证据充分性判定（够→回答引用；不够→改写重试或明说不足） |

## 4. 架构设计

### 4.0 检索数据流（阶段 1 目标态）

```
question
  → Node semanticIndex.search（向量，整页命中）──┐
  → python _retrieve_pages（词法，整页命中）────┼─ RRF 融合（python 侧）
                                               └→ top-k 整页证据 → LLM
```

- 词法命中在 python（现有 `_retrieve_pages`），向量命中在 Node（`semanticIndex.search` 改整页级），**融合放 python**：`precomputed_sources` 语义升级为"向量检索命中（整页）"，python 在 page 模式下与词法命中做 RRF。
- 无 embedding 可用时 `semanticIndex.enabled()=false` → `precomputed_sources` 为 undefined → 纯词法（与现在完全一致，Q7）。

### 4.1 本地 embedding 服务（Q2/Q6）

- **新增** `python/atlasgate_agent/embedding_worker.py`：ONNX Runtime 加载 bge-small-zh-v1.5（约 50–100MB），暴露 OpenAI 兼容 `/v1/embeddings`（复用现有 worker 机制，`pypdf` 已开 vendor 惯例）。
- Node `embed()` **零改动**：`ATLASGATE_EMBEDDING_BASE_URL` 指向本地服务或外部 API。
- 依赖：`onnxruntime`（唯一新增 pip 依赖，ADR-010 只约束 JS）。

### 4.2 向量存储与索引（Q4/Q5）

- **新增表** `semantic_vectors`（版本化）：`kb_id, version, path, dims, vector_json, updated_at`，按 `(kb_id, version, path)` 唯一。
- `semantic-index.js`：
  - `indexVersion`：改为索引**页面**（`knowledge_documents` 而非 `knowledge_chunks`），backend=`local`（SQLite）或 `qdrant`（保留现有路径）。
  - `search`：整页向量检索 → 返回**页面级** source（`path` + 整页 `content` + `vector_score`），作为 `precomputed_sources`。
  - `enabled()`：`retrievalMode === "hybrid"` 或 `"qdrant"` 时启用；embedding 未配置则 false（降级）。
- 配置：`ATLASGATE_RETRIEVAL_MODE=hybrid`（默认，Q7）、`ATLASGATE_EMBEDDING_BASE_URL`、`ATLASGATE_EMBEDDING_MODEL=bge-small-zh-v1.5`、`ATLASGATE_EMBEDDING_DIMENSIONS=512`。

### 4.3 Hybrid RRF 融合（Q3）

- python `prepare_knowledge_run` page 模式：词法命中 `_retrieve_pages` + 向量命中 `precomputed_sources` → RRF：`score(p) = Σ 1/(60 + rank)`，去重取 top-k 整页。
- `_validate_precomputed_sources` 升级：接受整页级 source（path/content/vector_score），不再强制 chunk 字段。

### 4.4 阶段 2：伪重排 → reranker + 查询改写（Q8/Q9）

- **伪重排（已实施）**：RRF 后对 top-k 用多信号加权精排——复用图谱 related 边（页面度数、社区凝聚、与问题命中词的 related 边权重），零新依赖（python `_rerank_by_graph_degree` 打破 RRF 并列）。
- **bge-reranker-base（延后，未实施）**：python worker 加载 ONNX 交叉编码模型，对 top-k（如 20）与问题对做精排到 top-5；`ATLASGATE_RERANK_ENABLED` 为占位开关，当前版本未落地。
- **查询改写（已实施）**：首轮 RRF 无命中或最高分 < 阈值 → LLM 把问题改写成可检索形式（复用 `completeText`，deepseek-chat）→ 重试一次；仍低置信走 `fallback_answer`。

### 4.5 阶段 3：多跳 + 证据判定（Q10/Q11）

- **多跳（A）**：首轮命中页解析 `[[wikilink]]` → 目标页若存在则并入候选（按向量/词法再排一轮）→ 整页证据；零额外 LLM 调用。
- **证据充分性判定（A）**：LLM 在 system prompt 中新增指令——证据不足时明确回答"当前知识库证据不足"（现有 fallback 的显式化）；可选：判定"不足"时触发一次查询改写重试（衔接 Q9）。

## 5. 配置项汇总（实施后）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | `local`(纯词法) / `hybrid`(词法+向量 RRF，默认) / `qdrant`(纯向量) |
| `ATLASGATE_EMBEDDING_BASE_URL` | 空 | 本地 ONNX 服务或外部 API 的 `/embeddings`；为空则 hybrid 自动降级纯词法 |
| `ATLASGATE_EMBEDDING_MODEL` | `bge-small-zh-v1.5` | 模型名（外部 API 时透传） |
| `ATLASGATE_EMBEDDING_DIMENSIONS` | `512` | 向量维度 |
| `ATLASGATE_EMBEDDING_API_KEY` | 空 | 外部 API 用 |
| `ATLASGATE_QUERY_REWRITE_ENABLED` | `true` | 阶段 2：首轮零证据时真实 LLM 改写并重试一次（无真实 Provider 时无操作） |
| `ATLASGATE_QUERY_SEDIMENT_ENABLED` | `true` | ADR-015：问答沉淀进 Wiki（显式请求或相似问题 ≥3 次 + 质量规则） |
| `ATLASGATE_RERANK_ENABLED` | `false` | **未实施（延后占位）**：bge-reranker ONNX 精排开关 |
| `ATLASGATE_WIKI_MAX_PAGES_PER_SOURCE` | `20` | 沿用（摄入页数预算 / 检索 top-k 上限） |

## 6. 测试与验收

**阶段 1 门禁**（已验收，全量测试 **Node 92 / Python 19** 绿）：
1. `semantic_vectors` 表索引/检索 roundtrip（node 测试）
2. Hybrid RRF：构造"词法命中 A 页、向量命中 B 页"的场景，断言融合后 top-k 正确且去重（node + python 测试）
3. 降级：无 embedding 配置时行为与现状完全一致（全量测试覆盖）
4. 端到端：本地 ONNX 服务起来后，`/api/agents/knowledge/ask` 问"脱锚副作用"能命中写"脱锚"的页面（语义匹配验收，需配置真实 embedding 服务）
5. 线上 KB2 回归：两章编译页检索不受影响

**阶段 2/3 门禁**（已验收）：各自新增测试 + 全量回归（伪重排 / 查询改写 / 多跳 / 证据充分性，见 `test/wiki-phase5~8.test.js`）。

**验收命令（可复现）**：管理端先登录保存会话，`$KB` 承接建库返回的 id：

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"示例库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# ① 混合检索：词法 + 向量 RRF 融合（未配置 embedding 时自动降级纯词法）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"石壁 线索","top_k":5}'

# ② 语义索引（需配置 ATLASGATE_EMBEDDING_BASE_URL；未配置返回 400）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'

# ③ 提问：响应含 retrieval_mode（hybrid）/ rewritten_question（零证据改写后非空）/ saved_to_wiki
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"save_to_wiki\":true}"

# ④ 多跳：跨页拼答案（零额外 LLM 调用）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"跨页问题：A 页的线索与 B 页的人物有什么关系\",\"multihop\":true}"
```

## 7. 风险与权衡

- **本地 ONNX 依赖**：新增 `onnxruntime` + 模型权重（约 100MB），首次加载慢；遵循项目"能 vendor 就 vendor"惯例，不引入重型框架。
- **向量维度一致性**：换模型（bge-base/API）需重建索引（`semantic_index_jobs` 已按 embedding_model 区分，天然支持重建）。
- **RRF 参数**：k=60 为惯例默认，如需调参集中在一处常量。
- **旧版本向量**：按版本存储，历史版本可回溯；仅 master 参与检索（与现状一致）。
- **Qdrant 保留**：SQLite 为主，Qdrant 作为可选后端（`retrievalMode=qdrant` 沿用现有代码，不删）。

## 8. 里程碑

- ✅ M1（阶段 1）：已实施验收——全量测试绿（Node 92 / Python 19）；语义命中验收需配置真实 embedding 服务
- ✅ M2（阶段 2）：已实施验收——伪重排（图谱度数）+ 零证据查询改写；bge-reranker（A 方案）延后
- ✅ M3（阶段 3）：已实施验收——wikilink 多跳扩展 + 证据充分性判定（"跨页拼答案"场景）
