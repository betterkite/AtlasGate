# AtlasGate 使用总览

本文是控制台的使用导览与常见任务流程。分模块的深度文档见 [导航主页](README.md)。

## 控制台 8 个视图

| 视图 | 入口 | 作用 |
| --- | --- | --- |
| **运行总览** | 01 | 上游 API Key 余额（自动刷新）+ API 请求数/Token 两张可悬停曲线图（24h/7d/30d） |
| **知识 Agent** | 02 | 向知识库提问：引用证据回答、可选 Memory、"回存 Wiki"把好答案沉淀为页面 |
| **知识版本** | 03 | 知识库管理：导入、Change 待审、合并发布、版本/冲突账本、关系图、Wiki 设置（ingest 模式）、摄入队列、Review 队列、Lint 体检 |
| **模型网关** | 04 | Provider/凭据/模型映射/客户端密钥/余额/健康测试 |
| **路由策略** | 05 | 路由模拟与排除诊断（评分信号：质量/成本/延迟/可靠性） |
| **Skills 与 Memory** | 06 | 技能包上传/版本/启停；Memory 生命周期 |
| **审计证据** | 07 | 请求账本：**每条请求显示调用方密钥**、路由决策、用量、风险 |
| **Wiki 知识库** | 08 | 三栏阅读（页面树/Markdown/图谱）：浏览、编辑（走 Change）、图谱搜索/拖拽/悬停、同步 md、导出 zip |

## 常见任务流程

### 接入一个新模型（DeepSeek 示例）
1. 「模型网关」→ 添加 Provider：name=`deepseek`、kind=`openai`、base_url=`https://api.deepseek.com`、API Key=你的 key、models=`deepseek-chat, deepseek-reasoner`。
2. 「测试」确认健康 → 「余额」拉取账户余额（总览页会显示）。
3. 需要时添加凭据池（多 key 轮换）与模型映射（别名→上游模型）。

### 让业务系统调用网关
1. 「模型网关」→ 签发**客户端密钥**：设置 scope（`gateway:invoke`）、模型白名单、RPM/TPM、token 配额、月预算。
2. 把密钥交给调用方，用 `Authorization: Bearer <key>` 调 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/embeddings`。
3. 「审计证据」里能看到每条请求是**哪个密钥**调的（密钥名称+前缀），内部调用标记"内部调用"。

### 沉淀知识（LLM Wiki 编译）
1. 「知识版本」→ 建知识库（review 模式）。
2. 「摄入队列」tab：粘贴文本 / URL 抓取 / 上传 md·txt·pdf。
3. 无真实模型：素材存档 + 原文成页（退化路径）；配置 DeepSeek 后：两步编译自动产出实体/概念/摘要页，产物进 Pending。
4. 「待合并变更」里按批次审阅（可整批打回）→「发布合并」→ 新 Master。
5. 「Wiki 知识库」浏览/编辑；「同步 md」把页面镜像到 `knowledge/<库名>/`；「导出 zip」打包给 Obsidian。

### 体检知识库
1. 「知识版本 → Lint 体检」：结构级检查（孤立页/断链/index 一致性）免费自动跑；LLM 级体检需要真实模型。
2. 报告可 ack / 忽略 / 一键创建缺失页（走 Change）。

## 权限与密钥速记（重要）

- **管理员账号**（`admin`）→ 登录控制台，管理一切；只能走浏览器会话，不能调 `/v1/*`。
- **客户端密钥** → 调 `/v1/*`；带 token 配额/限流/预算；不能登录控制台；**没有"用户账号登录"这回事**（`users` 只是密钥的归属记账实体）。
- **上游 API Key**（DeepSeek 等）→ 网关调上游用；余额在总览显示，与客户端密钥配额无关。

## 更多
- 网关深度：[GATEWAY.md](GATEWAY.md)
- 知识版本深度：[KNOWLEDGE.md](KNOWLEDGE.md)
- LLM Wiki 深度（含 md 文件在哪）：[WIKI.md](WIKI.md)
- Agent 深度：[AGENT.md](AGENT.md)
- 运维与排查：[CONSOLE_OPS.md](CONSOLE_OPS.md)
