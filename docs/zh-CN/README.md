# AtlasGate 文档导航

[English documentation](../en-US/README.md)

按读者角色选择入口：

## 🚀 新手 / 复现
- [中文项目说明](../../README.md) — 项目定位、能力总览、一分钟启动
- [Getting Started（从零复现）](GETTING_STARTED.md) — 环境要求 + 实测命令 checklist，照做即通
- [Introduction（项目介绍）](INTRODUCTION.md) — 定位、设计理念、三层模型、两类密钥、术语表

## 🧭 使用者（控制台与模块使用知识）
- [Usage（使用总览）](USAGE.md) — 控制台 8 个视图导览 + 常见任务流程
- [Gateway（模型网关）](GATEWAY.md) — Provider / 路由 / 客户端密钥 / 上游余额 / 限流
- [Knowledge（知识版本）](KNOWLEDGE.md) — 导入 / Change / 合并 / 冲突 / 检索 / 审计归属
- [Wiki（LLM Wiki 知识库）](WIKI.md) — **md 文件在哪** / 编译管线 / 审阅 / 图谱 / 同步与导出
- [Agent（知识 Agent）](AGENT.md) — 提问 / 引用 / 回存 / Memory / Skills

## 🔧 开发者 / 运维
- [Architecture（架构）](ARCHITECTURE.md) — 模块、数据模型、编译管线、图谱
- [Developer Feature Guides（功能实现指南）](guides/README.md) — 按功能块追踪目的、代码、原理、数据、边界与测试
- [Feature Matrix（功能追踪矩阵）](guides/FEATURE_MATRIX.md) — 功能、代码、接口、测试和实现状态
- [Karpathy Alignment（LLM Wiki 对照评估）](guides/07-karpathy-alignment.md) — 当前实现与原始方法论的符合度和差异
- [API](API.md) — HTTP / MCP 端点全集
- [Configuration（配置）](CONFIGURATION.md) — 全部环境变量
- [Deployment（部署）](DEPLOYMENT.md) — Docker / Compose / 持久化
- [Operations（运维手册）](CONSOLE_OPS.md) — 备份 / 升级 / 故障排查
- [Security（安全）](SECURITY.md)
- [Decisions（架构决策 ADR）](DECISIONS.md)
- [Roadmap（路线图）](ROADMAP.md)

## 📚 参考与历史
- [references/](../references/) — Karpathy LLM Wiki 原文与参考项目（llm-wiki-skill、llm_wiki）归档
- [archive/](../archive/) — 历史实施文档（LLM Wiki 重构 Phase 0~4 实施记录）
- [Test Plan / Report](TEST_PLAN.md) / [TEST_REPORT.md](TEST_REPORT.md)
