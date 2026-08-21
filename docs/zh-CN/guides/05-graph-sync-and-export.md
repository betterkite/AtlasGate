# 知识图谱、Markdown 镜像与导出

> ID: `GRAPH-001` / `WIKI-002`  
> 状态: `implemented`

## 1. 目的与边界

图谱用于导航、关系发现和知识健康洞察；检索 chunk 用于证据召回，二者不混为同一种节点。发布 Master 后，系统可把页面同步成 Obsidian 可读的 Markdown 镜像，也可导出只读 ZIP。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| 关系 | `src/core/relevance.js` | related edge scoring | 直接链接、素材重叠、Adamic-Adar、类型亲和 |
| 社区 | `src/core/louvain.js` | Louvain implementation | 确定性社区发现 |
| 洞察 | `src/services/insights.js` | `computeGraphInsights()` | 孤立页、稀疏社区、桥接节点 |
| 镜像 | `src/services/wiki-sync.js` | `syncKnowledgeBase()` | Master 到 Markdown |
| 导出 | `src/services/wiki-export.js`、`src/core/zip.js` | ZIP export | Obsidian 仓库导出 |
| 前端 | `web/graph.js` | Canvas renderer | 拖拽、搜索、缩放和社区着色 |

## 3. 版本边界

图节点和边都带 `kb_id` 与 `version`。历史版本必须独立读取，不得混入当前 Master 的关系。镜像是发布后的派生物，不是数据库事实源；直接编辑镜像不会进入 Change 流程。

## 4. 验证

```bash
node --test test/graph-layout.test.js test/wiki-sync.test.js
```

用户侧说明见 [`docs/zh-CN/WIKI.md`](../WIKI.md) 第 1、7、9 节。
