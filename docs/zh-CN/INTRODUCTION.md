# AtlasGate 项目介绍

## 一句话定位

**AtlasGate 是面向小型研发团队的本地 LLM 基础设施**：一个 OpenAI / Anthropic 多协议 API 网关 + 一套具备协作版本治理、LLM 自动编译与关系图谱的知识库（LLM Wiki），以及一个默认引用证据的知识 Agent。

## 它解决什么问题

- 团队要接入多个大模型（DeepSeek、OpenAI、Anthropic…），需要一个统一入口做**路由、限流、预算、审计**，而不是每个业务各自接 SDK。
- 团队要沉淀知识，但传统 RAG 每次查询都从原始文档现取现答，**知识不会积累**。AtlasGate 采用 Karpathy 的 LLM Wiki 方法论：**LLM 把素材"编译"成持续维护的 wiki 页面**，越用越厚。
- 团队内部署需要**可控、可审计、可离线**：数据落在本地 SQLite，密钥分两类治理，全程留痕。

## 三大组件

```
业务系统 / Agent / MCP ──▶ ① 协议网关（/v1/* OpenAI·Anthropic 兼容）
                              ├─ 鉴权（客户端密钥）→ 限流/预算 → 能力过滤 → 评分路由 → 上游 Provider（DeepSeek 等）
                              └─ 每次调用记录：请求、路由、用量、密钥归属、风险（审计账本）
② 知识库（版本化 + LLM Wiki）
    导入素材 → Change（待审）→ 合并发布 → 不可变 Master vN → 检索索引（词法 bigram + 稠密向量 RRF）+ 关系图谱
    LLM 编译管线：两步（分析→生成）自动把素材变成 实体页/概念页/摘要页/索引/日志
    Wiki 页面同时镜像到磁盘 knowledge/ 目录（Obsidian 可直接打开）
③ 知识 Agent（Python 常驻 worker）
    检索 Master 证据 → 引用回答；可选 Memory / Skills；回答可回存为 wiki 页面
```

## 设计理念

| 理念 | 体现 |
| --- | --- |
| **DB 为源，磁盘为镜像** | 知识库页面存在 SQLite（版本化、可审计）；`knowledge/` md 目录与导出 zip 是镜像 |
| **LLM 写入永远走审计链** | 编译管线只生成 Change，不直写 Master；review 模式下等人审，auto 模式自动发布 |
| **两类密钥严格分离** | 客户端密钥（调用 `/v1/*`，token 配额）≠ 管理员账号（控制台，会话 Cookie）≠ 上游 API Key（调 DeepSeek，金额余额） |
| **零 npm 运行依赖** | 网关与图谱全部原生实现（含纯 JS 力导向图谱、Louvain 社区、ZIP 写入器） |
| **可离线验证** | 本地 mock 模型即可跑通全链路；LLM 编译在无真实 Provider 时退化为"素材存档 + 原文成页" |

## 关键数字

- 版本：**0.4.0**
- 全量测试：**Node 92 / Python 19**（`npm test` 门禁，全绿）
- 技术栈：Node.js 24（ESM、`node:sqlite`，零 npm 运行依赖）+ Python 3.11+（Agent Core）+ 原生 HTML/Canvas 控制台
- 部署形态：单机模块化单体（Docker 可选），数据在 `data/atlasgate.db`（WAL）
- 默认入口：`npm start` → 控制台 http://127.0.0.1:4310，默认账号 `admin / atlasgate-admin`，网关 Key `atlasgate-dev-key`（Bearer 头）

## 术语表

| 术语 | 含义 |
| --- | --- |
| 网关（Gateway） | `/v1/*` 多协议入口（Chat Completions / Responses / Anthropic Messages / Embeddings / SSE），负责鉴权、限流、评分路由与审计账本 |
| 知识库（KB） | 版本化 Wiki 页面集合，页面本体存于 SQLite `data/atlasgate.db`，每库独立 `ingest_mode` 与图谱 |
| Change | 一次待审修改（upsert / delete），携带作者与 `base_version`，经 merge 才影响生产读取指针 |
| Master | 不可变生产版本（vN）；merge 时原子推进，冲突账本 / tombstone 一并落库 |
| 系统页 | `index.md` / `log.md` / `overview.md` 由编译管线维护，`purpose.md` / `schema.md` 人工协同；均参与版本治理 |
| 降级页 | 无真实模型时摄入退化为"素材存档 + 原文成页"，带 `atlasgate-degraded` 标记，默认不参与检索（`include_raw=true` 才可见） |
| 检索模式 | `hybrid`（默认）：词法 bigram 页面级 + 本地稠密页面向量按 RRF 融合；无 embedding 自动降级纯词法；`qdrant` 为可选纯向量后端 |
| RRF | 倒数排名融合：`score(p) = Σ 1/(60 + rank)`，零权重调参地融合词法与向量两路命中 |
| 伪重排 | 用图谱度数打破 RRF 并列、提升中心页面（零额外依赖，阶段 2） |
| 查询改写 | 首轮零证据时用真实 LLM 改写问题并重试一次（`ATLASGATE_QUERY_REWRITE_ENABLED`，默认开） |
| 多跳 | 首轮命中页的 `[[wikilink]]` 目标并入候选再排一轮，零额外 LLM 调用（阶段 3） |
| 证据充分性 | 证据不足时回答明说"当前知识库证据不足"，不编造（阶段 3） |
| `query_hits` | 页面被问答引用的热度（近 30 天窗口），图谱节点可见，控制台按引用频率着色 |
| 沉淀（Sediment） | 问答写入 `queries/<slug>.md` 并走 Change 审计链：显式 `save_to_wiki` / `sediment`，或相似问题 ≥3 次 + 质量规则（ADR-015） |
| 技能（Skill） | SKILL.md 包，frontmatter 可声明 `retrieval` 字段（`top_k` / `multihop` / `include_raw` / `directories`），attach 后注入检索参数（ADR-015） |
| ADR | 架构决策记录（001~015），本仓库重要技术决策的权威说明 |
| MCP | Model Context Protocol 工具入口（`POST /mcp`），把知识库检索 / 提问暴露给外部 Agent |

## 一次提问的完整数据流（可复现）

以「建库 → 导入素材 → 发布 → 提问 → 沉淀」串起三大组件（管理端 API 先登录保存会话，网关端用 Bearer Key）：

```bash
# ① 登录管理端（保存会话 cookie）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# ② 建库（review 模式，默认；返回库 id 承接给 $KB）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"示例库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# ③ 导入素材 → 生成 pending Change（知识平台）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUg5YWl6ZeoCgpBdGxhc0dhdGUg5piv6Z2i5ZCR5bCP5Z6L5Zui6Zif55qE5pys5ZywIExNTSDln7rnoYDorr7mlr3vvJrlpJrljY/orq7nvZHlhbMgKyDniYjmnKzljJYgTExNIFdpa2kgKyDnn6Xor4YgQWdlbnTjgIIK","author":"tester"}'

# ④ merge 发布 → 不可变 Master v2（版本治理）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'

# ⑤ 知识 Agent 提问（显式沉淀；响应含 answer / sources / retrieval_mode / saved_to_wiki）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"save_to_wiki\":true}"

# ⑥ 沉淀产物：queries/ 页成为 pending Change（review 库不自动发布），图谱记录引用热度
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits|community)"' | head
```

网关侧等价调用（Bearer Key，无需登录）：

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## 参考来源

- 方法论：[Karpathy: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（原文归档于 docs/references/）
- 参考实现：[sdyckjq-lab/llm-wiki-skill](https://github.com/sdyckjq-lab/llm-wiki-skill)、[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)（能力对照见 docs/REFERENCE_MATRIX.md）

## 下一步

- 新手从这里开始：[Getting Started（从零复现）](GETTING_STARTED.md)
- 想看能力清单与快速启动：[中文 README](../../README.md)
- 想了解每个模块怎么用：[docs/zh-CN/README.md](README.md)（中文导航主页）
