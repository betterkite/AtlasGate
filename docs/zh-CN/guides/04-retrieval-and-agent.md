# 检索与 Knowledge Agent

> ID: `RAG-001` / `AG-001`  
> 状态: `implemented`（版本 0.4.0）

## 1. 目的与边界

Agent 从发布后的 Master 中检索证据，构造引用式回答，并可在显式开启时读写 session Memory、加载 Skills 和把回答保存为 Wiki Change。它不能把 pending Change 当成知识，也不能在无证据时假装知道答案（零证据首轮会尝试查询改写，仍无证据则明说不足）。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTTP | `src/app.js` | `/api/agents/knowledge/ask`、`/api/agents/knowledge/status`、`/api/agents/runs`、`/api/skills*`、`/api/memories*` | Agent / Skills / Memory API |
| Node | `src/services/agent.js` | `ask()`、`retrievalParamsFromSkills()` | 编排检索、模型、Memory、Skills 和审计；技能检索参数注入 |
| bridge | `src/services/python-agent.js` | `prepare()` | 调用 Python worker（有界队列、超时、失败重启） |
| Python | `python/atlasgate_agent/engine.py` | `prepare_knowledge_run()`、`_rrf_fuse()`、`_rerank_by_graph_degree()`、`_expand_linked_pages()` | 页面级词法检索、RRF 融合、伪重排、多跳扩展、抽取式 fallback |
| 向量 | `src/services/semantic-index.js` | `search()`、`indexVersion()` | 本地 SQLite 稠密向量或 Qdrant |
| 沉淀 | `src/services/wiki-compiler.js` | `autoSediment()`、`saveQueryAnswer()`、`similarQuestionCount()` | 显式/自动问答沉淀、`[[wikilink]]` 智能归类 |
| 热度 | `src/services/knowledge.js` | `recordQueryHits()`、`graph()` | `query_hits` 累计与图谱节点热度 |

## 3. 检索流程

```text
question -> Master version 校验
  -> page lexical retrieval（中文 bigram 词表重叠，整页阅读）
  -> hybrid：dense page retrieval（semantic_vectors 表 SQLite 余弦）→ RRF 融合
  -> 伪重排（图谱 related 边度数，α=0.05，只打破 RRF 平局）
  -> wikilink 多跳扩展（[[wikilink]] 追链，零额外 LLM 调用）
  -> 零证据首轮 → LLM 查询改写 → 重试一次
  -> Memory 召回（use_memory=true）→ Skills 注入（instructions + retrieval）
  -> citation prompt（证据编号 [1][2]…）
  -> model 或 extractive fallback
  -> 引用校验 / agent_runs 账本 / query_hits 累计 / 可选沉淀
```

默认 `ATLASGATE_RETRIEVAL_MODE=hybrid`：词法 + 稠密向量按 RRF（k=60）融合，无权重调参。没有 embedding 服务（未配置 `ATLASGATE_EMBEDDING_BASE_URL`）时自动降级纯词法页面检索，`retrieval_mode` 返回 `page`。本地 ONNX embedding 服务见 `python/atlasgate_agent/embedding_worker.py`（bge-small-zh-v1.5，512 维，OpenAI 兼容 `POST /v1/embeddings`，默认 8031 端口）；也可配置任何 OpenAI 兼容 embedding（DeepSeek 无 embedding）。`ATLASGATE_RETRIEVAL_MODE=qdrant` 为 Qdrant 稠密后端，需要真实 embedding + Qdrant；本地 feature hashing 不是语义 embedding。

系统页（index/log/purpose/schema/overview）与降级页（`atlasgate-degraded`）默认不参与检索，`include_system` / `include_raw` 可放开；`retrieval_mode=chunk` 走 chunk 级 BM25 路径。

## 4. Memory、Skills 与沉淀边界

- `use_memory=false` 时既不读取也不写入 Memory；`use_memory=true` + session 时按内容相关度召回（更新 `access_count` / `last_accessed_at`），并写情景记忆（episodic）。
- 只有启用且 attach 的 Skill 才能进入 prompt；其 `retrieval` 声明（top_k / multihop / include_raw / directories）在 ask 时注入检索参数——multihop/include_raw 任一 true 即开、top_k 取最大、directories 取并集；**调用方显式参数优先于技能**。
- `save_to_wiki=true` / `sediment=true` 显式沉淀，或相似问题（30 天窗口 bigram Jaccard ≥0.3）≥3 次 + 质量规则（≥2 来源引用、无证据不足标记、内容 ≥80 字）自动沉淀；产物为 `queries/<slug>.md` Change（`[[wikilink]]` 关联 `concepts/` / `entities/` 页），不直接修改 Master，同 slug 复用 pending change。
- 每次回答引用页面累计 `query_hits`（30 天窗口：超过 30 天未被引用则重置为 1），图谱节点带热度。

## 5. 当前限制

- 无真实 Provider 时走本地抽取式回答（mock / `local_extractive`），不伪装推理。
- hybrid 需要 embedding 服务；没有 embedding 时自动降级纯词法，无语义匹配。
- 端到端回答质量依赖真实 Provider / embedding；离线 mock 测试证明的是可解释的离线链路（改写、沉淀、RRF、多跳、热度、技能注入），不是模型回答质量。

## 6. 验证

```bash
npm test    # 全量：Node 92 + Python 19，零 npm 运行依赖
node --test test/wiki-phase6.test.js test/wiki-phase7.test.js test/wiki-phase8.test.js   # 查询改写 / 问答沉淀 / query_hits+技能检索
python -m unittest discover -s python/tests -v   # Python 侧 engine（词法/RRF/多跳/fallback）与 lint
```

## 7. 端到端复现（提问 → 混合检索 → 显式沉淀 → 技能注入）

默认开发配置实测通过（`npm start`，控制台 http://127.0.0.1:4310，admin / atlasgate-admin）。管理端 `/api/*` 用 cookie 会话（先登录拿 cookie，后续 `-b cookies.txt` 复用）；`$KB` 承接建库返回的 id。

```bash
# 1) 登录
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) 建库（auto 模式：摄入编译产物自动发布，Agent 才能检索到证据）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"retrieval-demo","ingest_mode":"auto"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) 提问（hybrid 默认；无 embedding 时自动降级纯词法，retrieval_mode 返回 page）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"脱锚术的副作用是什么？\",\"top_k\":5}" \
  | python3 -m json.tool
# 注意：仅 mock 时编译产物是 sources/ 降级存档页（atlasgate-degraded），默认不参与检索，
#       回答会明说"没有找到足够相关的证据"；配置真实 Provider 后才有编译页证据。

# 4) 显式沉淀（save_to_wiki=true）：答案 + 引用页沉淀为 queries/<slug>.md
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"如何合并变更？\",\"save_to_wiki\":true,\"session_id\":\"guide-1\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("saved_to_wiki"))'

# 5) 沉淀产物：auto 已发布；review 在 pending 里（合并后可见）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages" \
  | python3 -c 'import json,sys; [print(p["path"]) for p in json.load(sys.stdin) if p["path"].startswith("queries/")]'

# 6) 创建带 retrieval 检索策略的技能并 attach（multihop 开、top_k 取最大、调用方参数优先）
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-retrieval","description":"多跳深度检索","instructions":"优先给出多跳证据链并逐条引用 [n]。","retrieval":{"multihop":true,"top_k":8}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"脱锚术的副作用是什么？\",\"multihop\":false}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("skills:", [s["name"] for s in d["skills"]], "| sources:", len(d["sources"]))'

# 7) 网关 /v1/* 用 Bearer key（与 Agent 同一进程，展示网关鉴权模式）
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

详细行为见 [`docs/zh-CN/AGENT.md`](../AGENT.md) 和 [`docs/zh-CN/RAG_PLAN.md`](../RAG_PLAN.md)。
