# 文档摄入与 LLM Wiki 编译

> ID: `KB-002` / `WIKI-001`  
> 状态: `implemented`（版本 0.4.0）

## 1. 目的与边界

摄入把 MD、TXT、文本 PDF、URL 或粘贴文本保存为不可变 raw source，再编译成带 frontmatter 的 Wiki 页面。无真实 Provider 时，系统明确降级为原文存档页，不伪装成 LLM 总结。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTTP | `src/app.js` | `/import`、`/ingest`、`/ingest-queue`、`/ingest-queue/:jobId/cancel\|retry`、`/sources`、`/reviews`、`/research-jobs` | 接收来源、编译请求与队列/审阅 API |
| 解析 | `src/services/document-parser.js` | `parse()` | 校验 UTF-8、MD/TXT/PDF |
| 队列 | `src/services/ingest-queue.js` | `create()`、`claimNext()`、`fail()`、`recoverRunning()` | 有界、串行、持久化摄入队列（失败重试 ≤2 次，重启恢复） |
| 编译 | `src/services/wiki-compiler.js` | `enqueue()`、`ingestOne()`、`validatePages()`、`degradeIngest()` | SHA256 去重、两步编译、校验、降级、系统页维护 |
| 沉淀 | `src/services/wiki-compiler.js` | `saveQueryAnswer()`、`autoSediment()` | ADR-015：问答沉淀与 `[[wikilink]]` 智能归类 |
| 元数据 | `src/core/frontmatter.js` | `parseFrontmatter()` | 页面契约 |
| 发布 | `src/services/knowledge.js` | `submitChange()`、`merge()` | 统一审阅和版本治理 |

## 3. 编译流程

```text
raw source -> SHA256 去重（ingest_cache；force:true 绕过）
  -> ingest queue（同库串行，失败重试 ≤2 次，重启恢复 pending）
  -> ① 分析：实体/概念/矛盾/页面计划（LLM）
  -> ② 生成：页面 JSON（LLM）
  -> 校验：路径、frontmatter、secret、页数预算（Node 为权威）
  -> 批量 Change(batch_id, author=wiki-compiler)
  -> 派生 Review 项 / Research 任务 + 维护 index/log/overview 系统页
  -> review 留 pending 或 auto 合并
  -> 发布后：结构级 Lint 自动跑、md 镜像同步（semantic_vectors 重建视 embedding 配置）
```

无真实 Provider 或编译失败时，管线降级为"原文存档成页"（`sources/<slug>.md`，frontmatter 带 `atlasgate-degraded: true`），素材永不丢失。每个知识库同一时间只有一个 running job；失败最多重试两次，进程重启后可恢复 pending。

## 4. 安全与降级

- 原始 source 通过 `wiki_sources` 保存，内容 hash 用于去重。
- 生成结果中的私钥、`sk-` 字样和路径越权会被丢弃。
- LLM 不可用时生成 `sources/<slug>.md` 降级页，并记录原因。
- 降级 raw page 默认不参与检索，可显式 `include_raw`。
- 降级页带 `atlasgate-degraded: true` 标记；配置真实模型后用 `force:true` 重摄入，编译成功即被编译页取代。
- `review` 是默认发布策略；`auto` 只适合低风险个人库。

## 5. 验证

```bash
npm test    # 全量：Node 92 + Python 19，零 npm 运行依赖
node --test test/wiki-phase0.test.js test/wiki-phase1.test.js test/wiki-phase4.test.js   # 系统页/两步编译/队列/研究任务
python -m unittest discover -s python/tests -v   # Python 侧 ingest 分析/生成准备与 lint
```

## 6. 端到端复现（粘贴摄入 → 队列/页面 → 强制重摄入 → 发布）

默认开发配置实测通过（`npm start`，控制台 http://127.0.0.1:4310，admin / atlasgate-admin）。管理端 `/api/*` 用 cookie 会话（先登录拿 cookie，后续 `-b cookies.txt` 复用）：

```bash
# 1) 登录
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) 建库（ingest_mode=review：编译产物留 pending 等人工审阅；库名用 ASCII，避免导出 zip 文件名带中文报 500）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"compile-demo","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) 粘贴素材 → 入队（HTTP 202；同内容再投返回 skipped:true / reason:duplicate_content）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁，刻着脱锚术的副作用：灵气反噬。"}'

# 4) 摄入队列：pending → running → done（同库串行，失败自动重试 ≤2 次）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5" \
  | python3 -m json.tool

# 5) 两步编译产物是 pending Change，共享 batch_id、author=wiki-compiler：
#    真实模型 → entities//concepts/ 编译页 + index/log/overview 系统页；
#    只有 mock → sources/素材.md 降级原文存档页（atlasgate-degraded: true）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -c 'import json,sys; [print(c["path"], c["status"], c["batch_id"], c["author"]) for c in json.load(sys.stdin) if c["status"]=="pending"]'

# 6) Master 页面：review 模式下列出的只是已发布页面（系统页）；编译页合并后才出现在 /pages
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages" \
  | python3 -c 'import json,sys; [print(p["path"], p["page_type"]) for p in json.load(sys.stdin)]'

# 7) 降级页检查（仅 mock 降级场景存在；真实编译成功则无此文件）：
#    frontmatter 带 atlasgate-degraded: true，默认不参与检索（include_raw 可放开）
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=sources/素材.md" | python3 -m json.tool | grep -i degraded

# 8) 强制重新摄入：force:true 绕过 SHA256 去重重新入队（上次编译失败/想重编译时用；
#    同路径会多一个 pending Change，合并按 latest-submitted-wins 并记入冲突账本）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁，刻着脱锚术的副作用：灵气反噬。","force":true}'

# 9) 发布合并（review 库手动；auto 库满足 merge_batch_size/间隔自动合并）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"发布编译产物"}'

# 10) 系统页：index/log/overview 由编译管线随同批次维护（发布后 /pages 可见）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages?page_type=index" \
  | python3 -c 'import json,sys; print([p["path"] for p in json.load(sys.stdin)])'

# 11) 网关 /v1/* 用 Bearer key（与编译管线无关，展示网关鉴权模式）
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

详细编译规则见 [`docs/zh-CN/WIKI.md`](../WIKI.md)。
