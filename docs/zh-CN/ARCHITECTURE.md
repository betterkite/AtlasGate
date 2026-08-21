# AtlasGate Architecture

## 1. 设计目标

首版选择模块化单体，而不是立即拆微服务。原因是网关、知识发布和 Agent 运行之间有大量需要先稳定的领域契约；在单进程内可以低成本验证数据模型、失败语义和审计边界。每个模块只通过服务接口和数据库表交互，后续可按下表拆分。

| 当前模块 | 独立服务目标 | 拆分触发条件 |
| --- | --- | --- |
| `GatewayService` | gateway-plane | 多实例流量、独立扩缩容、SSE 长连接 |
| `KnowledgeService` | knowledge-control + index-worker | 文档量超过单机索引、异步摄入任务增加 |
| Python `atlasgate_agent` + Node adapter | agent-runtime | 多 harness、长任务、人工审批节点 |
| `PlatformService` | evidence-query | 审计保留周期和查询负载影响数据面 |

## 2. 网关路由

路由顺序固定：

1. 鉴权并检查 Scope、模型白名单、RPM/TPM、Key/团队/组织额度。
2. 扫描消息内容的能力需求和风险信号。
3. 按显式 `provider:model`、精确模型或 `auto` 构造候选。
4. 在评分前剔除不支持视觉等请求能力的 Provider。
5. 使用 profile 权重计算质量、成本、延迟、可靠性和微量稳定 affinity。
6. 从 Provider 凭据池按权重选择可用 Key，跳过超额或冷却凭据。
7. 持久化候选与选择理由，按有界候选顺序调用 Provider；429/5xx 触发 Failover。
8. 持久化每次 attempt、用量、延迟、风险级别和错误。

`quality`、`balanced`、`economy`、`latency` 四种 profile 只是版本化策略输入，不在请求路径内自动训练或改变权重。

可复现示例（网关端用 Bearer Key，无需登录）：

```bash
# 模型列表
curl http://127.0.0.1:4310/v1/models \
  -H "Authorization: Bearer atlasgate-dev-key"

# Chat Completions（默认配置下由内置 atlas-mini mock 离线应答）
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## 3. 知识版本模型

`knowledge_bases.master_version` 是生产读取指针。`knowledge_changes` 保存每次独立修改的 `base_version`、路径、操作、作者、revision 和时间。达到 `merge_batch_size`、超过 `merge_interval_minutes` 或手动操作时发布。

合并事务执行：

1. `BEGIN IMMEDIATE` 锁定当前发布动作。
2. 复制当前 master 文档到 `vN+1`。
3. 按 `created_at,rowid` 从旧到新应用 change。
4. 基线不是当前 master，或同批次重复修改同一路径时标记 conflict。
5. 后应用的已接受 change 覆盖旧值。
6. 记录冲突 winner、原因、latest-submitted-wins 决议和删除 tombstone。
7. 重建 `vN+1` 检索切片、索引和知识关系图。
8. 原子更新 master 指针并提交事务。

这个策略让在线 Agent 在整个发布过程中继续读取完整的 `vN`，不会读到半更新状态。当前 latest-wins 是明确的业务策略，而非普适真理；接入高风险业务库时应增加 reviewer / approval 状态和领域级 merge function。

可复现示例（管理端 cookie 会话；`$KB` 承接建库返回的 id）：

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"示例库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 导入素材 → pending Change；查看 Change 与冲突账本
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUg5YWl6ZeoCgpBdGxhc0dhdGUg5piv6Z2i5ZCR5bCP5Z6L5Zui6Zif55qE5pys5ZywIExNTSDln7rnoYDorr7mlr3vvJrlpJrljY/orq7nvZHlhbMgKyDniYjmnKzljJYgTExNIFdpa2kgKyDnn6Xor4YgQWdlbnTjgIIK","author":"tester"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts"

# merge 发布 → Master v2；版本列表与图谱随版本可回溯
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions"
```

## 4. 检索

### 4.1 LLM Wiki 页面与 chunk 边界

知识库采用 LLM Wiki 风格的页面模型：Markdown 文件路径作为页面 ID，标题层级作为页面目录，`[[WikiLink]]`/相对链接作为页面引用，frontmatter/正文标签作为可复用实体。页面、标题、标签和引用进入版本化关系图；关系图不按字符数绘制，也不把每个检索 chunk 强行变成图节点。

发布 Master 时，页面内容再生成检索 chunk。分段器先识别标题和段落边界，再在同一标题路径内聚合；任何超过最大长度的单段文本都会按最大字符数硬切，并保留有限重叠。每条 `knowledge_chunks` 记录包含：

- `chunk_index`：页面内稳定的从 0 开始的顺序；
- `heading_path`：标题层级路径，例如 `运营规范 / 告警处理`；
- `char_count`：实际存储内容的字符数；
- `content`：用于 BM25 或 Embedding 的文本。

默认 `maxChars=900`、`overlap=120`。这套边界让页面结构、关系图和检索索引各自承担单一职责：图用于导航和实体关系，chunk 用于召回和证据定位。

检索默认 **hybrid**（`ATLASGATE_RETRIEVAL_MODE=hybrid`，ADR-012）：两条信号在 Python 侧按 RRF 融合——

- 词法：中文 bigram 页面级打分（python `_retrieve_pages`），纯 SQL、零依赖；
- 向量：页面级稠密向量存 `semantic_vectors` 表（SQLite，进程内 cosine 相似度），由本地 ONNX `bge-small-zh` 服务（`python/atlasgate_agent/embedding_worker.py`，暴露 OpenAI 兼容 `/v1/embeddings`）或任何 OpenAI 兼容 embedding API（`ATLASGATE_EMBEDDING_BASE_URL`）生成。

融合公式 `score(p) = Σ 1/(60 + rank)`（RRF，k=60），去重取 top-k 整页作为证据，随后做**伪重排**（图谱度数打破并列，`_rerank_by_graph_degree`）。未配置 embedding 时 `semanticIndex.enabled()=false`，自动降级为纯词法（与 legacy 行为一致）；`qdrant` 为可选纯向量后端：批量生成向量、按知识库与 Master 版本创建集合，`semantic_index_jobs` 记录模型、维度、状态和失败原因，该模式失败时不会静默降级。

后续 RAG 阶段（详见 RAG_PLAN）在此之上叠加：零证据查询改写（`ATLASGATE_QUERY_REWRITE_ENABLED`，默认开，首轮无命中时用真实 LLM 改写后重试一次）、wikilink 多跳扩展（首轮命中页的 `[[wikilink]]` 目标并入候选再排一轮，零额外 LLM 调用）、证据充分性判定（证据不足时明说，不编造）。

可复现示例（hybrid 检索与语义索引；`$KB` 沿用上文建库结果）：

```bash
# 混合检索（词法 + 向量 RRF），响应含各分量
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"石壁 线索","top_k":5}'

# 为当前 Master 构建语义索引（未配置 embedding 时返回 400）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'
```

## 5. Agent、Skills 与 Memory

知识 Agent 的核心运行时使用 Python，Node.js 保留网关和 HTTP 控制面。固定大小的常驻 Python worker pool 通过 JSON Lines 接收请求，具备有界队列、超时、崩溃替换、请求数回收和优雅关闭。Python 读取同一份 SQLite 快照；Qdrant 模式下 Node 提供与当前 Master 版本一致的预计算语义证据。Node 再完成模型路由、Provider 调用和审计写入。

知识 Agent 的 harness 是：

```text
validate -> retrieve master -> optional memory recall -> load attached skills
         -> build governed prompt -> route model -> validate citations -> ledger
```

本地 mock Provider 走 extractive fallback，不伪装成模型推理。配置真实 Provider 后，Agent 复用同一网关和路由证据。

Memory 的读取和写入共享一个硬条件：本次请求 `use_memory === true`。Memory 以 session 隔离，保存脱敏摘要与源 run id。关闭时既不读也不写。

Skills 是本地版本化注册表，支持 attach/detach、启停、推荐、使用事件、版本与多 Skill 合并，`DELETE /api/skills/:id` 已支持删除。SKILL.md frontmatter 可声明结构化 `retrieval` 字段（`top_k` / `multihop` / `include_raw` / `directories`），attach 后注入本次 Agent 请求的检索参数——`multihop`/`include_raw` 任一为 true 即开启、`top_k` 取所有已激活技能的最大值、`directories` 取并集；调用方显式参数优先（ADR-015 C）。Memory 记录类型、作用域、重要度、过期、召回次数、替代与遗忘事件。后续线上平台仍需增加签名、评测集、合并谱系、回滚和组织策略，不能让未经评测的自进化结果直接进入生产。

可复现示例（一次 ask 的完整链路，含检索参数与技能注入）：

```bash
# 提问（显式沉淀 + Memory 会话；响应含 answer / sources / retrieval_mode / rewritten_question / saved_to_wiki）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"use_memory\":true,\"session_id\":\"demo-1\",\"save_to_wiki\":true}"

# 技能声明检索策略（ADR-015 C）并 attach
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-8","description":"深取8页","instructions":"按证据回答","retrieval":{"top_k":8,"multihop":true}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'
```

## 6. 文档摄入与关系图

MD/TXT 使用严格 UTF-8 解码；PDF 在独立 Python worker 中使用 `pypdf` 抽取文本。上传先进入 `knowledge_imports`，解析成功后生成普通 Change，因此与手工编辑共享审核、冲突和发布语义。扫描 PDF 明确要求后续 OCR，不静默生成空文档。

每个 Master 的图谱从文档、Markdown 标题、frontmatter/正文标签、相对链接和 `[[WikiLink]]` 构建。节点和边携带版本号，历史版本可独立读取。

## 7. 知识修改与删除

- 知识库：允许修改名称、描述和合并策略；删除时由外键级联清理所有版本、Change 和索引。
- Pending Change：允许修改内容、路径和作者，也可以撤销。
- Merged Change / Version：作为审计证据保持不可变。
- Master 文档：编辑生成 `upsert Change`；删除生成 `delete Change`。两者都必须经过 merge 才改变生产读取指针。

## 8. 安全边界

- Provider Key 只存服务端，控制面接口只返回 `has_api_key`。
- 请求账本只保留截断、脱敏的 prompt preview。
- risk mode 可将私钥 / API Key 泄漏请求设为阻断。
- 客户端 Key 只存 SHA-256 hash，明文只在签发时返回。
- 控制台当前只适合绑定 `127.0.0.1`；外部部署必须先增加控制面身份认证。

## 9. LLM Wiki 三层模型（Phase 0 基线）

知识库按 Karpathy LLM Wiki 方法论演化为三层：**Raw Sources（不可变素材层）→ Wiki（LLM 维护的 Markdown 页面）→ Schema（公约与目的）**。当前版本（0.4.0）已落地数据契约、系统页与完整 LLM 编译管线（Ingest / Lint / 查询回存，见 §10–§11）。

- 每个知识库拥有五个系统页（`purpose.md` / `schema.md` / `index.md` / `log.md` / `overview.md`），是真实文档页并参与版本治理；新知识库在 v1 直接发布，存量知识库升级时以 pending Change 播种。其中 `index.md` / `log.md` / `overview.md` 由编译管线自动维护，`purpose.md` / `schema.md` 由人工协同（走 `PUT` 接口阶段化为 Change）。
- `knowledge_documents` 增加页面元数据列：`page_type`（entity/concept/source/comparison/synthesis/query/overview/index/log/purpose/schema/note/wiki）、`title`、`frontmatter_json`、`confidence`（EXTRACTED/INFERRED/AMBIGUOUS/UNVERIFIED）、`sources_json`（溯源）。存量文档按路径推断类型。
- 新表承载 wiki 工作负载：`wiki_sources`（不可变素材）、`ingest_queue`/`ingest_cache`（摄入队列与 SHA256 去重）、`review_items`（异步人工评审）、`lint_reports`、`research_jobs`、`wiki_log`（log.md 的持久化镜像）。
- 检索默认排除系统页（Q11），`include_system=true` 可显式包含；schema/purpose 的修改走 `PUT` 接口并阶段化为 Change，不直写 Master。
- 摄入模式 per-KB：`ingest_mode=review`（默认，编译器产物留 pending 等人审）或 `auto`（产物直接 merge 发布）；`force:true` 可强制重新摄入（绕过 SHA256 去重）。
- frontmatter 解析/序列化在 `src/core/frontmatter.js` 与 `python/atlasgate_agent/frontmatter.py` 双端保持行为一致，是页面元数据与后续编译管线的契约基础。

## 10. LLM Wiki 编译管线（Phase 1）

- 持久化摄入队列（`ingest_queue`）串行消费（每知识库同时只有一个 running job），崩溃后启动时恢复为 pending，失败自动重试 ≤2 次；SHA256 去重（`ingest_cache`），`force:true` 可强制重新摄入。
- 两步编译：①分析（Python 读 wiki 上下文拼装 prompt → Node 调网关 LLM → 结构化分析 JSON）→ ②生成（同链路产出页面 JSON）→ Node 校验（路径白名单、frontmatter 必填、confidence 枚举、密钥/路径越权丢弃、页数预算 ≤ `maxPagesPerSource`）→ 以 `author=wiki-compiler` + `batch_id` 阶段化为 Change → 派生 review_items / research_jobs → `ingest_mode=auto` 时自动 merge（review 模式下控制台按 batch_id 批次审阅）。
- `merge()` 在发布时从内容 frontmatter 推导 `page_type/title/confidence/sources_json`，保证编译器页面元数据随版本保留。
- 无真实模型路由时（仅 mock），摄入退化为「素材存档 + 原文成页」（Q6）：降级页带 `atlasgate-degraded` 标记，默认不参与检索（`include_raw=true` 才可见），离线演示链路不受影响；URL 摄入通过内置轻量 HTML→文本抓取。
- `compile_model` 每知识库可覆盖，空则走网关 `auto` 路由（Q10）；Deep Research 任务仅落库预留，执行在后续阶段（D6）。

可复现示例（摄入 → 队列 → 产物；无真实模型时自动降级为原文存档页）：

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。"}'

# 查看摄入队列与已发布页面
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages"

# 强制重新摄入（绕过 SHA256 去重）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。","force":true}'
```

## 11. Lint 与查询回存（Phase 2）

- 结构级 Lint（孤立页、断链、index 一致性）是纯 SQL、零 token 成本，通过 `knowledge.publishHooks` 在**每次 merge 发布后自动执行**（Q17-B）；系统页不参与孤立/断链判定，报告按 (kb, kind, paths, open) 去重。
- LLM 级体检（矛盾、过时声明、缺页、数据缺口）手动触发（`lint.py` 拼装 prompt → 网关 LLM → 报告落库），需要真实模型 Provider；报告生命周期 open → acked/fixed/dismissed，missing_page 报告可"一键创建" stub 页面 Change。
- 查询回存 / 问答沉淀（D8 + ADR-015 A）：显式 `save_to_wiki` / `sediment`，或相似问题 ≥3 次（对 `agent_runs` 近 30 天历史做 bigram Jaccard ≥0.3 统计）且满足质量规则（≥2 来源引用、无"证据不足"标记、内容 ≥80 字）时自动沉淀；回答以 `queries/<slug>.md`（frontmatter 含 `sources[]` 溯源）确定性组装，先用混合 RRF 匹配 `concepts/`/`entities/` 页——强匹配则 `[[wikilink]]` 关联（不改写人工维护页），否则落 `queries/`——随后阶段化为 Change 跟随 `ingest_mode`（review 留 pending、auto 合并发布）；同 slug 的 pending change 原地更新不堆积（Q6A）；`ATLASGATE_QUERY_SEDIMENT_ENABLED` 默认开；沉淀页是普通 wiki 页，可编辑、删除、回滚。

## 12. 图谱增强与 Wiki 浏览（Phase 3）

- **5 信号相关度**：页面级 `related` 边权重 = 直接链接 ×3 + 素材重叠 ×4 + Adamic-Adar ×1.5 + 类型亲和 ×1.0 + 词法重叠 ×1.5（`src/core/relevance.js`），随每次 rebuild 写入版本化图谱；旧版本在读取时懒重建（`ensureRelatedEdges`）。
- **纯 JS Louvain**（`src/core/louvain.js`，ADR-010 零 npm 依赖）：确定性社区发现，度数总和与原始 m 贯穿递归聚合，输出每个页面所属社区。
- **引用热度**（ADR-015 B）：图谱节点携带 `query_hits`（问答引用次数，近 30 天窗口），控制台按引用频率着色——记忆是知识的使用痕迹，不额外建 memory 节点。
- **洞察**（`src/services/insights.js`）：孤立页（度 ≤1）、稀疏社区（凝聚度 <0.15 且 ≥3 页）、桥接节点（连接 ≥3 社区）、跨社区意外连接。
- `graph()` 响应新增 `communities`（成员数/凝聚度）与 `insights`，文档节点附带 `community`；控制台图谱按社区着色、related 边按权重显示粗细。
- 控制台新增「Wiki 知识库」三栏视图：页面目录树 / Markdown 阅读（frontmatter 徽标、置信度、`sources[]` 溯源、wikilink 跳转、编辑走 Change）/ 图谱 + 社区 + 洞察。

可复现示例（图谱 + 引用热度）：

```bash
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits|community)"' | head
```

## 13. 导出与生态（Phase 4）

- **只读 zip 导出**（Q8）：`GET /api/knowledge-bases/:id/export` 将 Master 页面打包为 Obsidian 兼容 Markdown 仓库（含 `.obsidian/` 最小配置、README、frontmatter 保留），使用 `src/core/zip.js` 零依赖 ZIP 写入器（store 方式）。双向目录同步为后续增强。
- **md 镜像**：`knowledge/<库>/` 为发布后单向生成的 Markdown 镜像（Obsidian 可直接打开、已 gitignore），`POST /api/knowledge-bases/:id/sync` 手动触发重建。
- **Deep Research 接口预留**（D6）：摄入时派生的 `research_jobs`（topic + 预生成查询）只落库、可查询，执行引擎（Tavily/SerpApi/SearXNG）按需接入。
- **URL 摄入**（Q16）已在 Phase 1 随编译管线落地（内置 HTML→文本抓取），Web Clipper 浏览器扩展为可选后续（见 `docs/WEB_CLIPPER.md`）；DOCX/XLSX/EPUB 多格式解析按 D5 保持可选。

可复现示例（镜像同步与 ZIP 导出）：

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/sync" \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head
```
