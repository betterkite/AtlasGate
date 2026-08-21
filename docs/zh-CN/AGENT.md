# 知识 Agent（Agent / Skills / Memory）使用知识

本模块对应控制台视图 02「知识 Agent」与 06「Skills 与 Memory」。核心：**只回答有证据的问题，引用来源，可选记忆与技能。** 检索默认 hybrid（词法 bigram 页面级 + 本地稠密向量 RRF 融合），无 embedding 服务时自动降级纯词法。

## 1. 调用

### 控制台
「知识 Agent」视图：选知识库 + 模型 → 提问 → 返回引用证据的回答；「图谱」视图节点带 `query_hits`（问答引用热度）着色。

### HTTP API
```bash
POST /api/agents/knowledge/ask   # 管理端 API，需 admin cookie
{
  "kb_id": "kb_xxx", "question": "如何合并变更？",
  "model": "auto", "session_id": "任意id",
  "use_memory": false, "save_to_wiki": false, "sediment": false,
  "query_title": "可选沉淀页标题",
  "top_k": 5, "multihop": true, "include_raw": false,
  "retrieval_mode": "page"              # page（默认）/ chunk
}
```
返回：`run_id`、`answer`、`sources[]`、`routing`、`memory{enabled,recalled,stored}`、`skills[]`、`runtime`、`retrieval_mode`（`hybrid` / `semantic_qdrant` / `page` / `chunk`）、`rewritten_question`（发生改写时非空）、`saved_to_wiki`（显式或自动沉淀时）。

### MCP 工具
`knowledge_ask`、`knowledge_search`、`knowledge_graph`、`knowledge_submit_change`、`knowledge_merge`、`memory_list`、`skill_list`、`wiki_ingest`、`wiki_reviews_list/resolve`、`wiki_lint_run/list`。

## 2. 回答管线

```
validate → 检索 Master 证据（hybrid 默认：词法 bigram 页面级 + 稠密向量 RRF 融合）
        → 伪重排（图谱 related 边度数，只打破 RRF 平局）
        → wikilink 多跳扩展（[[wikilink]] 追链，零额外 LLM 调用）
        → 零证据首轮 → LLM 查询改写 → 重试一次（ATLASGATE_QUERY_REWRITE_ENABLED）
        → 可选 Memory 召回（use_memory=true 才读）
        → 加载已挂载 Skills（retrieval 声明注入检索参数）
        → 构建 governed prompt（证据编号 [1][2]…）
        → 路由模型（auto / 显式 provider:model）
        → 校验引用 → 写审计账本（agent_runs）→ 累计 query_hits → 可选沉淀
```

- **混合检索（hybrid，默认）**：词法 bigram 页面级打分 + 本地稠密向量（`semantic_vectors` 表，SQLite 余弦）按 RRF 融合；无 embedding 服务（`ATLASGATE_EMBEDDING_BASE_URL` 未配置）自动降级纯词法；`ATLASGATE_RETRIEVAL_MODE=qdrant` 走 Qdrant 后端。
- **伪重排**：用图谱 `related` 边度数做小幅度加成（α=0.05），只打破 RRF 平局，不覆盖融合排序。
- **零证据查询改写**：首轮无命中且路由到真实模型时，让 LLM 把问题改写成更可检索的形式重试一次；mock 或 `ATLASGATE_QUERY_REWRITE_ENABLED=false` 时跳过。
- **wikilink 多跳**：首轮命中页里的 `[[wikilink]]` 目标按 basename 解析并追加为扩展证据（multihop 默认开，`multihop:false` 关）。
- **证据充分性**：证据不足时明确回答"没有找到足够相关的证据"，不编造。
- **本地 mock 模式**：抽取式回答（把最相关证据列出来），不伪装推理；配置真实 Provider 后走 LLM 合成。

## 3. 回存 Wiki（save_to_wiki / sediment）

- `save_to_wiki:true` 或 `sediment:true` 为**显式沉淀**：答案 + 引用页面保存为 `queries/<slug>.md`（frontmatter 带 `sources[]`、`linked_to`）。
- **智能归类**：沉淀时用混合检索匹配 `concepts/` / `entities/` 页，top-1 强匹配（score ≥0.2）时用 `[[wikilink]]` 关联，沉淀页不孤立。
- 同 slug 已有 pending change 时**原地更新**，不堆积重复。
- 走 Change 审计链跟随 `ingest_mode`：review 模式 → pending（可编辑/删除/回滚后再合并）；auto 模式 → 直接发布。
- **自动沉淀**：`ATLASGATE_QUERY_SEDIMENT_ENABLED` 默认开；相似问题（30 天窗口，bigram Jaccard ≥0.3）被问 ≥3 次 + 质量规则（≥2 来源引用、无证据不足标记、内容 ≥80 字）自动沉淀；显式请求不受质量规则约束。
- 价值：把探索结果沉淀进知识库（Karpathy"好答案回存"）。

## 4. Memory（显式记忆）

- **硬规则**：`use_memory=true` 才读、才写；关闭时既不读也不写。
- 类型 kind（episodic/semantic…）、scope（session…）、importance、expires_at、superseded_by、forgotten。
- 召回时按内容相关度排序并累加 `access_count` / `last_accessed_at`；过期自动遗忘（maintenance）、`supersede` 替代。
- 用途：跨轮次记住用户偏好/结论（脱敏摘要）。API：`GET/POST /api/memories`、`DELETE /api/memories/:id`、`POST /api/memories/:id/supersede`。

## 5. Skills（技能包）

- 上传 `SKILL.md`（frontmatter: name/description/version/scope + 正文）或 `skill.json`（`POST /api/skills` 或 `POST /api/skills/import`）；支持版本、导入账本、合并、推荐。
- attach 到 `knowledge-agent` 后，其 instructions 注入回答 prompt（`POST /api/agents/knowledge-agent/skills/:id`，body `{"attached":true}`）。
- **检索策略绑定（ADR-015/C）**：SKILL.md frontmatter 可声明 `retrieval` 字段（top_k / multihop / include_raw / directories），attach 后自动注入检索参数——multihop/include_raw 任一 true 即开、top_k 取最大、directories 取并集；**调用方显式参数优先于技能**。
- 内置：grounded-research（引用证据）、data-analysis（先验证再分析）。
- 管理：`PATCH/DELETE /api/skills/:id`（DELETE 已支持，连带解挂）、`/api/skills/:id/versions`、`/api/skills/recommend`、`/api/skills/merge`。
- 安全：技能包是"内容"不是可执行代码；平台级签名/评测是后续工作。

## 5.1 Memory（记忆）与知识闭环（ADR-015/A）

- `use_memory:true` + session 时，问答摘要按会话注入 prompt（情景记忆）。
- **沉淀**：`save_to_wiki` / `sediment` 显式沉淀，或相似问题 ≥3 次 + 质量规则自动沉淀，问答成为 `queries/` wiki 页面（走审计链，可删可回滚）；沉淀页通过 `[[wikilink]]` 关联到概念/实体页。
- 每次回答引用页面累计 `query_hits`（图谱热度，30 天窗口：页面超过 30 天未被引用则重置为 1）。

## 6. 审计

每次 ask 写 `agent_runs`（脱敏 question、answer、sources、skills、memory_used）；技能调用写 `skill_events` 并累加 `usage_count` / `success_count`；问答本身经过网关时会再写 `usage_logs`（归属"内部调用"）；沉淀与合并再走 `knowledge_changes` 审计链。

## 7. 常见坑

- **Memory 不生效**：请求没带 `use_memory: true`。
- **一直抽取式回答**：未配置真实 Provider（或 auto 只选中 mock）。
- **回答引用为空**：知识库没发布内容，或问题与知识无关（可看是否触发查询改写；降级页默认不参与检索，`include_raw:true` 可放开）。
- **save_to_wiki 没反应**：忘了勾选；`review` 模式下产物在 pending 里，需要合并后才可见；`ATLASGATE_QUERY_SEDIMENT_ENABLED=false` 时显式沉淀也被关闭。
- **多跳没生效**：命中页没有 `[[wikilink]]`，或链路目标是系统页 / 降级页被排除。

## 8. 端到端复现

默认开发配置实测通过（`npm start`，控制台 http://127.0.0.1:4310，admin / atlasgate-admin）。管理端 `/api/*` 用 cookie 会话（先登录拿 cookie，后续 `-b cookies.txt` 复用），网关 `/v1/*` 用 `Authorization: Bearer atlasgate-dev-key`。

### 8.1 提问 + 显式沉淀

```bash
# 1) 登录
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) 建库并承接 id（auto 模式：沉淀直接发布；review 模式则留 pending）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"agent-demo","ingest_mode":"auto"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) 提问 + 显式沉淀（save_to_wiki / sediment 任一 true 即显式）
#    返回含 answer / sources / retrieval_mode / rewritten_question / saved_to_wiki
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"如何合并变更？\",\"session_id\":\"demo-1\",\"use_memory\":true,\"save_to_wiki\":true}" \
  | python3 -m json.tool

# 4) 沉淀产物 queries/<slug>.md（auto 已发布；review 在 pending 里，合并后才可见）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages" \
  | python3 -c 'import json,sys; [print(p["path"]) for p in json.load(sys.stdin) if p["path"].startswith("queries/")]'

# 5) 网关 /v1/* 用 Bearer key（与 Agent 同一进程，展示网关鉴权模式）
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

### 8.2 创建带 retrieval 的技能并 attach

```bash
# 1) 登录（同上；$KB 承接 8.1 建库返回的 id）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) 创建技能：retrieval 声明多跳 + top_k=8 + 限定 concepts/ 目录（等价 SKILL.md frontmatter）
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-retrieval","description":"多跳深度检索","instructions":"优先给出多跳证据链并逐条引用 [n]。","retrieval":{"multihop":true,"top_k":8,"include_raw":false,"directories":["concepts/"]}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "SKILL=$SKILL"

# 3) attach 到 knowledge-agent（body attached:true；attached:false 解挂）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'

# 4) 验证注入：ask 返回 skills[] 含该技能；调用方显式 multihop:false 优先于技能声明
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"脱锚术的副作用是什么？\",\"multihop\":false}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("skills:", [s["name"] for s in d["skills"]], "| sources:", len(d["sources"]))'

# 5) 删除技能（DELETE /api/skills/:id 已支持，自动解挂）
curl -b cookies.txt -X DELETE "http://127.0.0.1:4310/api/skills/$SKILL"
```

## 9. 相关文档

- [API.md](API.md)（ask / memories / skills / mcp 端点）
- [WIKI.md](WIKI.md)（编译管线的 prompt 与校验）
- [RAG_PLAN.md](RAG_PLAN.md)（hybrid RRF / 伪重排 / 改写 / 多跳 / 证据充分性三阶段决策）
- [Architecture](ARCHITECTURE.md)（Python worker pool）
