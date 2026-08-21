# Web Clipper（网页剪藏）

AtlasGate 的网页摄入走 **URL 抓取**（Phase 1 已随编译管线落地）：`POST /api/knowledge-bases/:id/ingest` 的 `kind=url` 会自动抓取网页并转为 Markdown 文本，然后进入两步编译管线。

## 使用方式

**方式一：控制台手动录入（推荐）**
打开「知识版本 → 摄入队列」tab，选择「URL 抓取」，粘贴文章链接后入队。系统抓取 HTML → 文本 → 按 `ingest_mode` 决定留 pending 或自动合并发布。

**方式二：Agent / MCP**
```bash
# MCP 工具
wiki_ingest { "kb_id": "...", "kind": "url", "url": "https://example.com/article" }
# HTTP（控制台会话）
POST /api/knowledge-bases/:id/ingest  { "kind": "url", "url": "..." }
```

## 浏览器扩展（可选后续）

独立的 Manifest V3 扩展未包含在本仓库中（D5 可选）。实现要点（供后续接入）：

1. `content_scripts` 用 `Readability` 提取正文 → `Turndown` 转 Markdown；
2. 通过扩展 `options` 配置 AtlasGate 地址与控制台会话 Cookie（同源才能携带）；
3. 调用 `POST /api/knowledge-bases/:id/ingest`（`kind=paste` + `text`），依赖现有的去重、队列与审阅语义。

## 抓取边界

- 仅支持 `http(s)` URL，跟随重定向，30 秒超时；
- 只做轻量 HTML→文本转换（保留标题/列表/段落层级），不支持登录态页面；
- 需要登录态的内容请改为粘贴正文（`kind=paste`）。
