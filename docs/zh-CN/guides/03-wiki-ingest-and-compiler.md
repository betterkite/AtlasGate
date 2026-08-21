# 文档摄入与 LLM Wiki 编译

> ID: `KB-002` / `WIKI-001`  
> 状态: `implemented`

## 1. 目的与边界

摄入把 MD、TXT、文本 PDF、URL 或粘贴文本保存为不可变 raw source，再编译成带 frontmatter 的 Wiki 页面。无真实 Provider 时，系统明确降级为原文存档页，不伪装成 LLM 总结。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| 入口 | `src/app.js` | `/import`、`/ingest` | 接收来源和编译请求 |
| 解析 | `src/services/document-parser.js` | `parse()` | 校验 UTF-8、MD/TXT/PDF |
| 队列 | `src/services/ingest-queue.js` | `create()`、`retry()` | 有界、可恢复摄入队列 |
| 编译 | `src/services/wiki-compiler.js` | `ingestOne()` | 分析、生成、校验、stage |
| 元数据 | `src/core/frontmatter.js` | `parseFrontmatter()` | 页面契约 |
| 发布 | `src/services/knowledge.js` | `submitChange()`、`merge()` | 统一审阅和版本治理 |

## 3. 编译流程

```text
raw source -> SHA256 去重 -> ingest queue
  -> 分析：实体/概念/矛盾/页面计划
  -> 生成：页面 JSON
  -> 校验：路径、frontmatter、secret、页数预算
  -> Change(batch_id)
  -> review 或 auto merge
  -> index/log/overview 更新
```

每个知识库同一时间只有一个 running job；失败最多重试两次，进程重启后可恢复 pending。

## 4. 安全与降级

- 原始 source 通过 `wiki_sources` 保存，内容 hash 用于去重。
- 生成结果中的私钥、`sk-` 字样和路径越权会被丢弃。
- LLM 不可用时生成 `sources/<slug>.md` 降级页，并记录原因。
- 降级 raw page 默认不参与检索，可显式 `include_raw`。
- `review` 是默认发布策略；`auto` 只适合低风险个人库。

## 5. 验证

```bash
node --test test/wiki-phase1.test.js test/wiki-phase4.test.js test/wiki-phase5.test.js test/wiki-phase6.test.js
```

详细编译规则见 [`docs/zh-CN/WIKI.md`](../WIKI.md)。
