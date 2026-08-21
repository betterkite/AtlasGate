# AtlasGate 项目介绍

## 一句话定位

**AtlasGate 是面向小型研发团队的本地 LLM 基础设施**：一个 OpenAI / Anthropic 多协议 API 网关 + 一套具备协作版本治理、LLM 自动编译与关系图谱的知识库（LLM Wiki），以及一个默认引用证据的知识 Agent。

## 它解决什么问题

- 团队要接入多个大模型（DeepSeek、OpenAI、Anthropic…），需要一个统一入口做**路由、限流、预算、审计**，而不是每个业务各自接 SDK。
- 团队要沉淀知识，但传统 RAG 每次查询都从原始文档现取现答，**知识不会积累**。AtlasGate 采用 Karpathy 的 LLM Wiki 方法论：**LLM 把素材"编译"成持续维护的 wiki 页面**，越用越厚。
- 团队内部署需要**可控、可审计、可离线**：数据落在本地 SQLite，密钥分两类治理，全程留痕。

## 三大组件

```
业务系统 / Agent / MCP ──▶ ① 协议网关（/v1/* OpenAI·Anthropic 兼容）
                              ├─ 鉴权（客户端密钥）→ 限流/预算 → 能力过滤 → 评分路由 → 上游 Provider（DeepSeek 等）
                              └─ 每次调用记录：请求、路由、用量、密钥归属、风险（审计账本）
② 知识库（版本化 + LLM Wiki）
    导入素材 → Change（待审）→ 合并发布 → 不可变 Master vN → 检索 chunk + 关系图谱
    LLM 编译管线：两步（分析→生成）自动把素材变成 实体页/概念页/摘要页/索引/日志
    Wiki 页面同时镜像到磁盘 knowledge/ 目录（Obsidian 可直接打开）
③ 知识 Agent（Python 常驻 worker）
    检索 Master 证据 → 引用回答；可选 Memory / Skills；回答可回存为 wiki 页面
```

## 设计理念

| 理念 | 体现 |
| --- | --- |
| **DB 为源，磁盘为镜像** | 知识库页面存在 SQLite（版本化、可审计）；`knowledge/` md 目录与导出 zip 是镜像 |
| **LLM 写入永远走审计链** | 编译管线只生成 Change，不直写 Master；review 模式下等人审，auto 模式自动发布 |
| **两类密钥严格分离** | 客户端密钥（调用 `/v1/*`，token 配额）≠ 管理员账号（控制台，会话 Cookie）≠ 上游 API Key（调 DeepSeek，金额余额） |
| **零 npm 运行依赖** | 网关与图谱全部原生实现（含纯 JS 力导向图谱、Louvain 社区、ZIP 写入器） |
| **可离线验证** | 本地 mock 模型即可跑通全链路；LLM 编译在无真实 Provider 时退化为"素材存档 + 原文成页" |

## 关键数字

- 全量测试：**Node 71+ / Python 13**（`npm test` 门禁）
- 技术栈：Node.js 24（ESM、`node:sqlite`）+ Python 3.11+（Agent Core）+ 原生 HTML/Canvas 控制台
- 部署形态：单机模块化单体（Docker 可选），数据在 `data/atlasgate.db`（WAL）

## 参考来源

- 方法论：[Karpathy: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（原文归档于 docs/references/）
- 参考实现：[sdyckjq-lab/llm-wiki-skill](https://github.com/sdyckjq-lab/llm-wiki-skill)、[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)（能力对照见 docs/REFERENCE_MATRIX.md）

## 下一步

- 新手从这里开始：[Getting Started（从零复现）](GETTING_STARTED.md)
- 想看能力清单与快速启动：[中文 README](../../README.md)
- 想了解每个模块怎么用：[docs/zh-CN/README.md](README.md)（中文导航主页）
