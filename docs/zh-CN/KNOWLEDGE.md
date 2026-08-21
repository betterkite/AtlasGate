# 知识版本（Knowledge）使用知识

本模块负责：**知识库的导入、变更治理、版本发布、检索与审计**。对应控制台视图 03「知识版本」。

## 1. 核心模型：Change → Merge → Master

```
编辑/导入 ──▶ Pending Change（待审，乐观并发 revision）
                 │  达到 merge_batch_size / 超时 / 手动
                 ▼
          合并发布（原子事务）
                 │
                 ▼
        不可变 Master vN（生产读取指针）
                 │
                 ├─▶ 检索 chunk（标题/段落感知分段，900字符/120重叠）
                 └─▶ 关系图谱（文档/标题/标签/链接 + 4 信号相关边）
```

- **Agent 只读 Master**；所有修改都先生成 Change，再合并，绝不直写。
- **冲突账本**：基线不是当前 master，或同批重复改同一路径 → 记录冲突，latest-submitted-wins，保留决议证据。
- **版本不可变**：历史版本可独立检索、回看。

## 2. 导入

| 方式 | 说明 |
| --- | --- |
| 「文档导入」tab | 上传 MD / TXT / PDF（PDF 走 Python `pypdf`，扫描件需 OCR）；勾选"立即发布"则合并 |
| 「摄入队列」tab | LLM Wiki 编译入口：粘贴文本 / URL / 文档（见 [WIKI.md](WIKI.md)） |
| 文本粘贴 | `import` 接口 `text` 字段直接入 Change |

导入成功 = 解析 → 生成 Change（status=staged），**不直接污染 Master**；`publish:true` 时合并为新版本。

## 3. 页面与元数据

每个文档页面带元数据（版本化存储）：

- `page_type`：entity / concept / source / comparison / synthesis / query / overview / index / log / purpose / schema / note / wiki
- `title`、`confidence`（EXTRACTED / INFERRED / AMBIGUOUS / UNVERIFIED）、`sources[]`（溯源）、`frontmatter`

> 系统页（purpose/schema/index/log/overview）是真实文档页并参与版本治理；新建知识库自动带 5 个系统页；老库升级时以 Pending Change 播种。

## 4. 检索

- 默认**排除系统页**（index/log/purpose/schema/overview），避免导航页污染证据；`include_system=true` 可包含。
- 混合评分：中文 bigram / 英文 token BM25（`keyword_weight`）+ feature vector（`vector_weight`，离线可解释信号）；配置 Qdrant 后走语义检索。
- 证据返回 `path / heading_path / chunk_index / score`，Agent 可精确引用到章节。

## 5. 审计归属（重要）

`usage_logs` 记录每次调用；「审计证据」每条请求显示**调用方密钥名称+前缀**，内部调用标记"内部调用"。删密钥不删审计。

## 6. 维护

- 「维护」接口：过期 Memory 遗忘、重复文档检测、到期合并。
- 知识库删除：级联清理所有版本/Change/索引。

## 7. 常见坑

- **不要直接改 Master 文档**：编辑会生成 upsert Change（正确做法）；删除生成 delete Change。
- **pending 变更可撤销/修改**：用 `expected_revision` 防覆盖；已合并的 Change 不可变。
- **批量合并语义**：一次 merge 发布全部 pending（目前无"只合并某个批次"，要挑拣请逐条处理或整批打回）。

## 8. 相关文档

- [API](API.md)（`/api/knowledge-bases/*` 全端点）
- [WIKI.md](WIKI.md)（LLM 编译、图谱、md 同步）
- [Architecture](ARCHITECTURE.md)（版本模型细节）
