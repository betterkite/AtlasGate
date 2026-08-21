# 知识 Agent（Agent / Skills / Memory）使用知识

本模块对应控制台视图 02「知识 Agent」与 06「Skills 与 Memory」。核心：**只回答有证据的问题，引用来源，可选记忆与技能。**

## 1. 调用

### 控制台
「知识 Agent」视图：选知识库 + 模型 → 提问 → 返回引用证据的回答。

### HTTP API
```bash
POST /api/agents/knowledge/ask
{ "kb_id": "kb_xxx", "question": "如何合并变更？",
  "model": "auto", "session_id": "任意id", "use_memory": false,
  "save_to_wiki": false }
```

### MCP 工具
`knowledge_ask`、`knowledge_search`、`knowledge_graph`、`knowledge_submit_change`、`knowledge_merge`、`memory_list`、`skill_list`、`wiki_ingest`、`wiki_reviews_list/resolve`、`wiki_lint_run/list`。

## 2. 回答管线

```
validate → 检索 Master 证据（混合检索，默认排除系统页）
        → 可选 Memory 召回（use_memory=true 才读）
        → 加载已挂载 Skills
        → 构建 governed prompt（证据编号 [1][2]…）
        → 路由模型（auto / 显式 provider:model）
        → 校验引用 → 写审计账本（agent_runs）
```

- **本地 mock 模式**：抽取式回答（把最相关证据列出来），不伪装推理；配置真实 Provider 后走 LLM 合成。
- **无证据**：明确回答"没有找到足够相关的证据"，不编造。

## 3. 回存 Wiki（save_to_wiki）

- 勾选「回存 Wiki」后，答案 + 引用页面保存为 `queries/<slug>.md`（frontmatter 带 `sources[]`）。
- review 模式 → pending；auto 模式 → 直接发布。
- 价值：把探索结果沉淀进知识库（Karpathy"好答案回存"）。

## 4. Memory（显式记忆）

- **硬规则**：`use_memory=true` 才读、才写；关闭时既不读也不写。
- 类型 kind（episodic/semantic…）、scope（session…）、importance、expires_at、superseded_by、forgotten。
- 生命周期：创建 → 召回计数 → 过期遗忘 → 被替代。
- 用途：跨轮次记住用户偏好/结论（脱敏摘要）。

## 5. Skills（技能包）

- 上传 `SKILL.md`（frontmatter: name/description/version/scope + 正文）或 `skill.json`；支持版本、导入账本、合并、推荐。
- attach 到 `knowledge-agent` 后，其 instructions 会注入回答 prompt。
- **检索策略绑定（ADR-015/C）**：SKILL.md frontmatter 可声明 `retrieval: {"multihop": true, "top_k": 8, "include_raw": false, "directories": ["concepts/"]}`，attach 后自动注入检索参数（multihop 任一 true 即开、top_k 取最大、include_raw 任一 true 即开）；调用方显式参数优先于技能。
- 内置：grounded-research（引用证据）、data-analysis（先验证再分析）。
- 安全：技能包是"内容"不是可执行代码；平台级签名/评测是后续工作。

## 5.1 Memory（记忆）与知识闭环（ADR-015/A）

- `use_memory:true` + session 时，问答摘要按会话注入 prompt（情景记忆）。
- **沉淀**：`save_to_wiki` / `sediment` 显式沉淀，或相似问题 ≥3 次 + 质量规则自动沉淀，问答成为 `queries/` wiki 页面（走审计链，可删可回滚）；沉淀页通过 `[[wikilink]]` 关联到概念/实体页。
- 每次回答引用页面累计 `query_hits`（图谱热度，30 天窗口）。

## 6. 审计

每次 ask 写 `agent_runs`（脱敏 question、answer、sources、skills）；问答本身经过网关时会再写 `usage_logs`（归属"内部调用"）。

## 7. 常见坑

- **Memory 不生效**：请求没带 `use_memory: true`。
- **一直抽取式回答**：未配置真实 Provider（或 auto 只选中 mock）。
- **回答引用为空**：知识库没发布内容，或问题与知识无关。
- **save_to_wiki 没反应**：忘了勾选；或 `review` 模式下在 pending 里，需要合并后才可见。

## 8. 相关文档

- [API.md](API.md)（ask / memories / skills / mcp 端点）
- [WIKI.md](WIKI.md)（编译管线的 prompt 与校验）
- [Architecture](ARCHITECTURE.md)（Python worker pool）
