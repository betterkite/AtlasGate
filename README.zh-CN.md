# AtlasGate

面向小型研发团队的**本地 LLM 基础设施**：OpenAI / Anthropic 多协议 API 网关 + 具备协作版本治理、**LLM 自动编译**与关系图谱的知识库（LLM Wiki）+ 默认引用证据的知识 Agent。

- 参考 [Karpathy: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 方法论与 [llm-wiki-skill](https://github.com/sdyckjq-lab/llm-wiki-skill)、[llm_wiki](https://github.com/nashsu/llm_wiki) 参考实现，实现代码为独立设计。
- 能力对照见 [中文能力对照](docs/zh-CN/REFERENCE_MATRIX.md)，架构决策见 [中文架构决策](docs/zh-CN/DECISIONS.md)。

## 能力一览

| 组件 | 已实现能力 |
| --- | --- |
| **API 网关** | Chat Completions / Responses / Anthropic Messages / Embeddings / SSE、模型列表、Token 计数 |
| **智能路由** | 能力过滤（视觉）、四维评分（质量/成本/延迟/可靠性）、凭据池、冷却与有界 Failover、每次 attempt 留痕 |
| **用量治理** | 客户端密钥 scope / 模型白名单 / RPM / TPM / Token 配额 / 月预算；撤销与移除后审计保留 |
| **上游余额** | DeepSeek 余额自动识别（`/user/balance`）、总览实时展示与刷新 |
| **版本化知识库** | 多用户 Change → 合并 → 不可变 Master；乐观并发、冲突账本、tombstone；版本可独立检索 |
| **LLM Wiki 编译** | 两步编译（分析→生成）自动产出实体/概念/摘要页；持久化摄入队列、SHA256 去重、批次审阅、Review 队列、Lint 体检 |
| **Wiki 磁盘镜像** | 每个知识库的 Master 页面自动镜像到 `knowledge/<库名>/`（Obsidian 可直接打开）；支持导出 zip |
| **知识图谱** | 力导向布局、社区着色、4 信号相关边、悬停/拖拽/搜索/小地图；纯 JS 零依赖实现 |
| **知识 Agent** | 证据检索 + 引用回答 + 本地抽取式 fallback；`save_to_wiki` 回存；显式 Memory / Skills |
| **控制台** | 8 视图原生 Web 控制台（无构建依赖） |

## 一分钟启动

要求 Node.js 24+ 与 Python 3.11+（自动探测 `python`/`python3`，无 npm 依赖）。

```bash
cd AtlasGate
npm start
```

打开 **http://127.0.0.1:4310**：控制台账号 `admin / atlasgate-admin`（开发默认）；网关 API Key `atlasgate-dev-key`。

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

> 默认未连接真实模型，内置 `atlas-mini` 本地 mock 可离线验证全链路；配置任意 OpenAI 兼容 Provider（如 DeepSeek）后自动路由并启用 LLM 编译。

## 新手复现与文档

**从零复现（实测命令 checklist）→ [中文从零复现指南](docs/zh-CN/GETTING_STARTED.md)**

| 入口 | 文档 |
| --- | --- |
| 中文文档导航主页 | [docs/zh-CN/README.md](docs/zh-CN/README.md) |
| 项目介绍（定位/理念/两类密钥/术语） | [docs/zh-CN/INTRODUCTION.md](docs/zh-CN/INTRODUCTION.md) |
| 控制台使用总览 | [docs/zh-CN/USAGE.md](docs/zh-CN/USAGE.md) |
| 模型网关（Provider/密钥/路由/余额） | [docs/zh-CN/GATEWAY.md](docs/zh-CN/GATEWAY.md) |
| 知识版本（导入/Change/合并/检索/审计归属） | [docs/zh-CN/KNOWLEDGE.md](docs/zh-CN/KNOWLEDGE.md) |
| LLM Wiki（**md 文件在哪**/编译/图谱/同步导出） | [docs/zh-CN/WIKI.md](docs/zh-CN/WIKI.md) |
| 知识 Agent（提问/回存/Memory/Skills） | [docs/zh-CN/AGENT.md](docs/zh-CN/AGENT.md) |
| 控制台与运维（备份/升级/故障排查） | [docs/zh-CN/CONSOLE_OPS.md](docs/zh-CN/CONSOLE_OPS.md) |
| 架构 / API / 配置 / 部署 / 安全 | [docs/zh-CN/ARCHITECTURE.md](docs/zh-CN/ARCHITECTURE.md) · [docs/zh-CN/API.md](docs/zh-CN/API.md) · [docs/zh-CN/CONFIGURATION.md](docs/zh-CN/CONFIGURATION.md) · [docs/zh-CN/DEPLOYMENT.md](docs/zh-CN/DEPLOYMENT.md) · [docs/zh-CN/SECURITY.md](docs/zh-CN/SECURITY.md) |

## 知识库的 md 文件在哪？

知识库页面存储在 SQLite（`data/atlasgate.db`，版本化/可审计），磁盘上有两种文件形态：

- **自动 md 镜像**：`knowledge/<知识库名>/`（Obsidian 可直接打开，发布后自动同步，只读镜像）
- **导出 zip**：控制台「Wiki 知识库 → 导出 zip」

详见 [docs/zh-CN/WIKI.md](docs/zh-CN/WIKI.md) 第 1 节。

## Docker 启动

```bash
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:4310/health
```

完整步骤与持久化说明见 [docs/zh-CN/DEPLOYMENT.md](docs/zh-CN/DEPLOYMENT.md)。

## 测试与质量门禁

```bash
npm test          # Node + Python 全量（Node 71+ / Python 13）
npm run check     # 语法检查 + 测试门禁
```

测试计划与报告见 [docs/zh-CN/TEST_PLAN.md](docs/zh-CN/TEST_PLAN.md) / [docs/zh-CN/TEST_REPORT.md](docs/zh-CN/TEST_REPORT.md)。

## 当前边界（诚实的声明）

- 单机模块化单体；SQLite 存储；控制台面向回环/可信私网（外网部署需先做安全加固，见 docs/zh-CN/SECURITY.md）。
- LLM 编译需要真实 Provider；无 Provider 时退化为"素材存档 + 原文成页"。
- Deep Research 只落库预留、不执行；Web Clipper 扩展与多格式（DOCX 等）为可选后续（见 docs/zh-CN/WEB_CLIPPER.md）。
- Provider 凭据未做应用层加密（生产请用加密磁盘 / Secret Manager）。

## License

MIT
