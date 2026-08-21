# 知识版本、Change 与 Master 发布

> ID: `KB-001`  
> 状态: `implemented`

## 1. 目的与边界

知识库把多人修改、导入、LLM 生成和删除统一成 pending Change，再发布为不可变 Master 版本。这样 Agent 不会读取半完成的编辑，也可以追溯每次发布的作者、冲突和删除。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTTP | `src/app.js` | `/changes`、`/merge`、`/versions` | 版本管理 API |
| 服务 | `src/services/knowledge.js` | `submitChange()`、`merge()` | 修改、冲突和发布规则 |
| 存储 | `src/db.js` | `knowledge_changes`、`knowledge_versions`、`knowledge_documents` | 版本化数据 |
| 派生物 | `src/services/knowledge.js` | chunks、graph rebuild | 检索和关系图 |
| 测试 | `test/wiki-phase*.test.js` | Wiki phase tests | 行为证据 |

## 3. 发布流程

```text
编辑/导入/编译
  -> knowledge_changes(status=pending)
  -> expected_revision 校验
  -> BEGIN IMMEDIATE
  -> 复制当前 Master 到 vN+1
  -> 按 created_at,rowid 应用 Change
  -> 记录 conflict / tombstone
  -> 重建 chunks 与 graph
  -> 更新 master_version
  -> COMMIT
```

## 4. 核心不变量

- Agent 只读取 `master_version`。
- pending Change 不会出现在生产检索中。
- 发布者只能看到完整旧版本或完整新版本。
- 已合并 Change 和历史 Version 不可变。
- 同一路径冲突采用明确的 latest-submitted-wins，并写入冲突账本。
- 删除通过 delete Change 和 tombstone 发布，而不是直接删除线上内容。

## 5. 扩展边界

高风险领域不应直接复用 latest-wins；应在 Change 上增加 reviewer/approval 状态，或注入领域级 merge function。迁移数据库时必须保留版本、冲突和审计证据。

## 6. 验证

```bash
node --test test/wiki-phase0.test.js test/wiki-phase2.test.js test/wiki-phase3.test.js
```

完整使用说明见 [`docs/zh-CN/KNOWLEDGE.md`](../KNOWLEDGE.md)。
