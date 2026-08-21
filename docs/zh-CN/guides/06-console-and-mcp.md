# 管理控制台与 MCP

> ID: `UI-001` / `API-001`  
> 状态: `partial` / `implemented`

## 1. 目的与边界

原生 Web 控制台为网关、知识库、Wiki、图谱、Agent 和运维提供操作界面；MCP 将少量受治理能力暴露给外部 Agent。控制台当前适合回环或可信私网，不应直接视为公网管理员产品。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTML | `web/index.html` | 页面骨架 | 视图容器 |
| UI | `web/app.js` | view handlers | API 调用、状态和表单 |
| Wiki UI | `web/knowledge-tabs.js` | knowledge tabs | 页面、变更、导入、图谱和冲突视图 |
| Graph UI | `web/graph.js` | Canvas renderer | 图谱交互 |
| MCP | `src/services/mcp.js` | `McpService` | JSON-RPC tool list/call |
| HTTP | `src/app.js` | `/mcp`、`/api/*` | 认证、路由和错误响应 |

## 3. 安全边界

- `/api/*` 除认证接口外需要管理员 session。
- Provider 密钥不能出现在 UI、API 响应、日志或错误体。
- 文件导入必须经过大小、编码、格式和路径校验。
- MCP 工具只能调用已声明的受治理能力。

## 4. 当前限制

控制台没有独立的公网管理员身份系统、TLS 终止和细粒度多租户 UI 权限。因此本功能的界面完整性与公网安全性必须分开评价。

## 5. 验证

```bash
node --test test/atlasgate.test.js test/graph-layout.test.js
```

