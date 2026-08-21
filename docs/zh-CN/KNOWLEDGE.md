# 知识版本（Knowledge）使用知识

本模块负责：**知识库的导入、变更治理、版本发布、检索与审计**。对应控制台视图 03「知识版本」。知识库页面版本化存储在 SQLite（`data/atlasgate.db` 的 `knowledge_documents` 表），这是唯一事实源——因为要支持多用户版本治理、冲突账本与审计。

## 1. 核心模型：Change → Merge → Master

```
编辑/导入/LLM 编译 ──▶ Pending Change（待审，乐观并发 revision；LLM 编译批次共享 batch_id）
                        │  达到 merge_batch_size / 超时 / 手动（仅 ingest_mode=auto 自动合并）
                        ▼
                 合并发布（原子事务）
                        │
                        ▼
             不可变 Master vN（生产读取指针）
                        │
                        ├─▶ 检索 chunk（标题/段落感知分段，900字符/120重叠）
                        └─▶ 关系图谱（文档/标题/标签/链接 + 5 信号相关边）
```

- **Agent 只读 Master**；所有修改都先生成 Change，再合并，绝不直写。
- **乐观并发**：每个 pending Change 带 `revision`，修改时用 `expected_revision` 校验，防止覆盖他人编辑（不匹配返回 409 `revision_conflict`）。
- **冲突账本**：基线不是当前 master（`stale_base_version`），或同批重复改同一路径（`concurrent_path_update`）→ 记入 `knowledge_conflicts`，**latest-submitted-wins**，保留决议证据（`/conflicts` 可查）。
- **tombstone**：删除通过 delete Change 发布，删除记录写入 `knowledge_tombstones`，不直接抹掉线上内容。
- **版本不可变**：历史版本可独立检索、回看（`/versions/:version`、`/documents?version=`、`/document?path=&version=`、`/graph?version=`）。

## 2. 导入

| 方式 | 说明 |
| --- | --- |
| 「文档导入」tab | 上传 MD / TXT / PDF（PDF 走 Python `pypdf`，扫描件需 OCR）；勾选「立即发布」则合并 |
| 「摄入队列」tab | LLM Wiki 编译入口：粘贴文本 / URL / 文档（见 [WIKI.md](WIKI.md)）；同一素材的编译产物是共享同一 `batch_id` 的一批 Change |
| 文本粘贴 | `import` 接口 `text` 字段直接入 Change |

- 导入成功 = 解析 → 生成 Change（status=pending），**不直接污染 Master**；`publish:true` 时合并为新版本。
- **ingest_mode（per-KB）**：`review`（默认）——编译/导入产物留 pending，在「待合并变更」按**批次**查看，可逐条改/撤销、整批打回、发布合并；`auto`——达到 `merge_batch_size`（默认 3）或 `merge_interval_minutes`（默认 60）时自动合并发布（个人库适用）。
- **SHA256 去重**：相同内容跳过（`ingest_cache`）；同一内容再传会提示「重复内容跳过」，传 `force:true` 可强制重新摄入并重跑编译。

## 3. 页面与元数据

每个文档页面带元数据（版本化存储）：

- `page_type`：entity / concept / source / comparison / synthesis / query / overview / index / log / purpose / schema / note / wiki
- `title`、`confidence`（EXTRACTED / INFERRED / AMBIGUOUS / UNVERIFIED）、`sources[]`（溯源）、`frontmatter`

> 系统页（purpose/schema/index/log/overview）是真实文档页并参与版本治理；新建知识库自动带 5 个系统页；老库升级时以 Pending Change 播种。
>
> **降级页**：LLM 编译失败或没有可路由的真实 Provider 时，生成 `sources/<slug>.md` 原文存档页（frontmatter 带 `atlasgate-degraded: true` 标记），默认不参与检索；搜索/查询带 `include_raw:true` 可见；之后可对该素材传 `force:true` 重跑编译，成功后降级页被编译页取代。

## 4. 检索（Hybrid 默认）

- 默认 **Hybrid 页面级检索**（`ATLASGATE_RETRIEVAL_MODE=hybrid`）：词法 bigram 页面级检索（python worker）+ 本地稠密向量（`semantic_vectors` 表，SQLite 余弦）按 **RRF** 融合；未配置 embedding 服务时**自动降级为纯词法**（与旧行为一致）。
- 稠密向量：`ATLASGATE_EMBEDDING_BASE_URL` 指向任何 OpenAI 兼容 `/v1/embeddings`——本地 ONNX `bge-small-zh`（`python/atlasgate_agent/embedding_worker.py`，默认模型 `bge-small-zh-v1.5`、512 维），或外部 API（DeepSeek 官方无 embedding 模型）。`qdrant` 为可选纯向量后端（`retrieval_mode=qdrant`）。
- **伪重排**：RRF 融合后，图谱 related 边度数高的页面（更核心）获得小幅加成，只打破平局不颠覆排序。
- **零证据查询改写**：首轮检索 0 命中且路由到真实模型时，LLM 把问题改写成更可检索的形式重试一次（`ATLASGATE_QUERY_REWRITE_ENABLED` 默认开，mock 路由下自动跳过），响应带 `rewritten_question`。
- **wikilink 多跳扩展**：首轮命中页的 `[[wikilink]]` 指向页（最多 3 个）自动并入证据（`multihop:false` 可关），零额外 LLM 调用。
- **证据充分性**：证据不足时 Agent 明说（不编造）；首轮 0 命中返回明确的「无足够证据」答案。
- 默认**排除系统页**（index/log/purpose/schema/overview）与降级页；`include_system=true` / `include_raw=true` 可包含。
- 证据返回 `path / heading_path / chunk_index / score`，Agent 可精确引用到章节；响应 `retrieval_mode` 反映实际模式（hybrid / semantic_qdrant / chunk / page）。

## 5. 审计归属（重要）

`usage_logs` 记录每次调用；「审计证据」每条请求显示**调用方密钥名称+前缀**，内部调用标记"内部调用"。删密钥不删审计。知识侧的审计链同样完整保留在 Change / merge / 冲突账本 / tombstone / 版本摘要里（作者、时间、批次、决议）。

## 6. 维护

- 「维护」接口（`POST /maintenance`）：过期 Memory 遗忘、重复文档检测、到期合并（仅 auto 模式）。
- 语义索引：`POST /semantic-index` 手动重建当前版本向量（body 可指定 `version`）；`GET /semantic-index` 查看任务。
- Lint：每次发布自动跑结构级 lint（孤立页/断链/index 一致性，纯 SQL 免费）；LLM 级 lint（矛盾/过时/数据缺口）手动触发（`POST /lint`，`mode:"llm"`）。
- 知识库删除：级联清理所有版本/Change/索引。

## 7. 问答沉淀与技能（ADR-015）

- **问答沉淀**：`/api/agents/knowledge/ask` 传 `save_to_wiki:true` / `sediment:true` 显式沉淀；或同一/相似问题被问 ≥3 次且回答满足质量规则（引用 ≥2 个来源、无「证据不足」、内容 ≥80 字）时自动沉淀（`ATLASGATE_QUERY_SEDIMENT_ENABLED` 默认开）。
- 产物为 `queries/<slug>.md`（含 `sources[]` 溯源 + `[[wikilink]]` 智能关联到 RRF 匹配的 concepts//entities/ 页），走标准 Change 审计链、跟随 ingest_mode（review 留 pending、auto 直接发布）；**同 slug 复用 pending change**（不堆积重复）；沉淀页可编辑/删除/回滚。
- **引用热度**：Agent 回答引用的页面累计 `query_hits`（近 30 天窗口），图谱节点与悬停卡显示「问答引用 N 次」。
- **技能检索策略**：SKILL.md frontmatter 可声明 `retrieval` 字段（`top_k` / `multihop` / `include_raw` / `directories`），attach 后注入检索参数（`multihop`/`include_raw` 任一 true 即开、`top_k` 取最大、`directories` 并集）；调用方显式参数优先；`DELETE /api/skills/:id` 已支持。

## 8. 常见坑

- **不要直接改 Master 文档**：编辑会生成 upsert Change（正确做法）；删除生成 delete Change。
- **pending 变更可撤销/修改**：用 `expected_revision` 防覆盖；已合并的 Change 不可变。
- **批量合并语义**：一次 merge 发布全部 pending（merge 接口没有「只合并某批」；要挑拣请逐条 PATCH/DELETE，或整批打回）。同一 LLM 素材的 Change 共享 `batch_id`，按批次查看用 `GET /changes` 过滤。
- **冲突**：base_version 落后或同批重复改同一路径 → 记入冲突账本（latest-submitted-wins），`GET /conflicts` 可查决议证据。

## 9. 端到端复现（curl，照抄即可复现）

> 默认开发配置实测通过：`npm start` 后控制台 http://127.0.0.1:4310（admin / atlasgate-admin，网关 Key `atlasgate-dev-key`）。管理端 `/api/*` 用 cookie 会话；网关 `/v1/*` 用 Bearer。

### 9.1 导入文档 → 查看 pending → 发布合并 → 看版本列表

```bash
# 0) 管理端登录（cookie 会话）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 1) 建库（ingest_mode=review：产物留 pending 等人工审阅）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"版本演示库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 2) 导入文档（解析 → pending Change，不直接污染 Master）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","author":"tester","data_base64":"IyDmnq/kupXlupXnn7Plo4EKCuWQkemhtuWkqeWcqOaer+S6leW6leWPkeeOsOWNiuWdl+efs+Wjge+8jOS4iumdouWIu+edgOaooeeziueahOe6uei3r+OAgui/meaYr+acrOefpeivhuW6k+eahOesrOS4gOS7vee0oOadkOOAggoKLSDlhbPplK7or43vvJrnn7Plo4HjgIHmnq/kupXjgIHnurnot68KLSDlvZLlsZ7vvJrmtYvor5XntKDmnZA="}'

# 3) 查看 pending 变更（含 revision / batch_id / author）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -m json.tool

# 4) 修改 pending Change（乐观并发：expected_revision 防覆盖）
CHG=$(curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
curl -b cookies.txt -X PATCH "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes/$CHG" \
  -H 'content-type: application/json' \
  -d '{"content":"# 枯井底石壁（修订）\n\n向顶天在枯井底发现半块石壁。","expected_revision":1}'
# 若 expected_revision 已过期（revision 已被他人改到 2）→ 409 revision_conflict

# 5) 发布合并（一次性合并全部 pending，返回新版本号与冲突数）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'
# → {"kb_id":"...","version":2,"parent_version":1,"change_count":1,"conflict_count":0}

# 6) 看版本列表（Master 已推进到 v2；v1 是建库时的系统页版本）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions" \
  | python3 -m json.tool
```

### 9.2 LLM 摄入批次（batch_id）与知识 Agent

```bash
# LLM Wiki 摄入（两步编译；默认 mock 路由下降级为 sources/ 原文存档页，产物共享 batch_id）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。"}'
sleep 3   # 队列轮询编译（ATLASGATE_WIKI_INGEST_POLL_MS 默认 2000ms；若仍 running 稍等重试）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -m json.tool   # 这批 Change author=wiki-compiler 且共享同一 batch_id
# review 库需手动发布该批次（一次 merge 合并全部 pending）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"发布摄入批次"}'
# Review 队列（LLM 标记的"需人工判断"项，与 Change 批次审阅是两条线）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/reviews?status=open"

# 混合检索（词法 + 向量 RRF；未配置 embedding 时自动降级纯词法）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"枯井底 石壁","top_k":5}'

# 知识 Agent 提问 + 显式沉淀（ADR-015）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"枯井底发现了什么\",\"save_to_wiki\":true}"
# 响应含 sources[] / retrieval_mode / rewritten_question / saved_to_wiki（queries/ 页，review 库留 pending）
```

### 9.3 乐观并发 / 冲突账本 / tombstone / 版本检索

```bash
# 同一路径提交两个 upsert（base_version 相同）→ 合并时记 concurrent_path_update 冲突
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"alice","content":"# 修订 A\n\nAlice 的版本。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"bob","content":"# 修订 B\n\nBob 后提交，latest-submitted-wins。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"并发提交合并"}'
# → conflict_count=1（Bob 的 change 胜出）

# 冲突账本：查看决议证据（earlier/winning change、reason、resolution）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts" \
  | python3 -m json.tool

# 删除走 delete Change + tombstone（不直接抹掉线上内容）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"delete","author":"tester"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"删除入门.md"}'
# 页面从 Master 移除；删除记录写入 knowledge_tombstones（审计保留，无独立 API，直接查库可见）

# 版本检索：历史版本不可变、可独立回看（v2 曾含入门.md，当前 Master 已删除）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions/2" \
  | python3 -m json.tool
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=入门.md" --data-urlencode "version=2"
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=入门.md"   # 当前 Master 已删除 → 404 document_not_found
```

### 9.4 网关端点（Bearer key，与 /api 管理端无关）

```bash
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## 10. 相关文档

- [API](API.md)（`/api/knowledge-bases/*` 全端点）
- [WIKI.md](WIKI.md)（LLM 编译、图谱、md 同步）
- [Architecture](ARCHITECTURE.md)（版本模型细节）
