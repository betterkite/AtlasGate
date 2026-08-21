# 知识图谱、Markdown 镜像与导出

> ID: `GRAPH-001` / `WIKI-002`  
> 状态: `implemented`（版本 0.4.0）

## 1. 目的与边界

图谱用于导航、关系发现和知识健康洞察；检索 chunk 用于证据召回，二者不混为同一种节点。发布 Master 后，系统可把页面同步成 Obsidian 可读的 Markdown 镜像，也可导出只读 ZIP。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| 关系 | `src/core/relevance.js` | `computeRelatedEdges()` | 5 信号相关边：direct_link×3 / source_overlap×4 / Adamic-Adar×1.5 / type_affinity×1 / lexical_overlap×1.5 |
| 社区 | `src/core/louvain.js` | `louvain()` | 确定性社区发现 |
| 洞察 | `src/services/insights.js` | `computeGraphInsights()` | 孤立页、稀疏社区、桥接节点、跨社区边 |
| 图谱 | `src/services/knowledge.js` | `graph()` | 版本化节点/边 + 社区摘要 + 洞察 + `query_hits` 引用热度 |
| 热度 | `src/services/knowledge.js` | `recordQueryHits()` | ADR-015：问答引用计数（30 天窗口，`wiki_query_hits` 表） |
| 镜像 | `src/services/wiki-sync.js` | `syncKnowledgeBase()` | Master 到 Markdown（manifest 跟踪删除，发布 hook 自动同步） |
| 导出 | `src/services/wiki-export.js`、`src/core/zip.js` | `exportZip()` | Obsidian 仓库 ZIP 导出 |
| HTTP | `src/app.js` | `/graph`、`/sync`、`/export` | 图谱查询、手动同步、导出 API |
| 前端 | `web/graph.js` | Canvas renderer | ForceAtlas2 式布局、拖拽、搜索、缩放、社区着色与热度标记 |

## 3. 版本边界

图节点和边都带 `kb_id` 与 `version`。历史版本必须独立读取（`/graph?version=`、`/export?version=`、`/documents?version=`），不得混入当前 Master 的关系。镜像是发布后的派生物，不是数据库事实源；直接编辑镜像不会进入 Change 流程。md 镜像的删除由 `knowledge/<库>/` 下的 `.atlasgate-manifest.json` 跟踪，页面被删除时下次同步会从磁盘移除。

## 4. 验证

```bash
npm test    # 全量：Node 92 + Python 19，零 npm 运行依赖
node --test test/graph-layout.test.js test/wiki-sync.test.js test/wiki-phase8.test.js   # 布局/同步/引用热度
```

## 5. 端到端复现（建库 → 摄入发布 → 图谱查询 → 同步 md → 导出 zip）

默认开发配置实测通过（`npm start`，控制台 http://127.0.0.1:4310，admin / atlasgate-admin）。管理端 `/api/*` 用 cookie 会话：

```bash
# 1) 登录
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) 建库（ingest_mode=auto：摄入完成后自动 merge 发布 → 触发图谱重建与 md 镜像同步；
#    库名用 ASCII：导出 zip 的 content-disposition 头含非 ASCII 字符时当前版本会报 500）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"graph-demo","ingest_mode":"auto"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) 摄入素材（无真实 Provider 时降级为 sources/素材.md 原文存档页，同样发布）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁，刻着脱锚术的副作用：灵气反噬。"}'

# 3b) 等队列完成（同库串行，失败重试 ≤2 次；auto 库完成后自动 merge 发布）
until [ "$(curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5" \
  | python3 -c 'import json,sys; print([q["status"] for q in json.load(sys.stdin)][0])')" = "done" ]; do sleep 2; done

# 4) 图谱数据：节点/边/社区摘要/洞察
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); \
print("nodes:", len(d["nodes"]), "edges:", len(d["edges"])); \
print("communities:", [(c["id"], c["members"], c["cohesion"]) for c in d["communities"]]); \
print("insights:", {k: len(v) for k, v in d["insights"].items()})'

# 5) 手动同步 md 镜像（发布时已自动同步；返回 files/removed 统计）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/sync" \
  -H 'content-type: application/json' -d '{}'
ls knowledge/graph-demo/   # Obsidian 可打开；修改请走控制台（以 Change 进入版本治理）

# 6) 导出 Master 快照 zip（含 frontmatter 与 .obsidian/ 配置）
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head

# 7) 问答引用热度：回答引用的页面 query_hits 累计（30 天窗口），图谱节点可见
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"脱锚术的副作用是什么\"}"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); \
print([(n["document_path"], n["query_hits"]) for n in d["nodes"] if n["kind"]=="document" and n["query_hits"]>0])'

# 8) 网关 /v1/* 用 Bearer key（与图谱无关，展示网关鉴权模式）
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

用户侧说明见 [`docs/zh-CN/WIKI.md`](../WIKI.md) 第 1、7、9 节。
