# API 参考

所有 JSON 修改接口都要求 `Content-Type: application/json`。网关接口需要客户端 API Key，管理接口需要控制台管理员会话 Cookie。

## 数据面接口

| 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|
| GET | `/v1/models` | API Key | 返回可用模型和 `auto` 别名 |
| POST | `/v1/chat/completions` | API Key | OpenAI Chat Completions 兼容接口和 SSE |
| POST | `/v1/responses` | API Key | OpenAI Responses 兼容接口和 SSE |
| POST | `/v1/messages` | API Key | Anthropic Messages 兼容接口 |
| POST | `/v1/messages/count_tokens` | API Key | 输入 token 估算 |
| POST | `/v1/embeddings` | API Key | 通过 Provider 生成 Embedding |
| POST | `/mcp` | MCP 客户端 | JSON-RPC 初始化、工具列表和工具调用 |

响应会返回 `x-atlas-request-id`、`x-atlas-routing-decision-id` 和 `x-atlas-provider`。路由相关请求头包括 `x-atlas-routing-profile`、`x-atlas-session-id` 和 `x-atlas-risk-mode`。

## 管理接口分组

- `/api/auth/*`：管理员登录、登出、会话查询和密码修改。
- `/api/providers/*`、`/api/model-mappings`、`/api/keys`：Provider、模型映射和客户端密钥。
- `/api/organizations`、`/api/teams`、`/api/users`：组织、团队和用户治理。
- `/api/knowledge-bases/*`：Change、版本、导入、检索、图谱、摄入、审阅、Lint、索引、同步和导出。
- `/api/agents/knowledge/ask`、`/api/skills`、`/api/memories`：Knowledge Agent、Skills 和 Memory。

## 知识检索约定

检索结果包含证据页面路径、章节、chunk 序号、分数、内容和 Master 版本。pending Change 永远不会作为生产证据返回。

提交 Change 示例：

```json
{
  "base_version": 3,
  "path": "policies/token-budget.md",
  "operation": "upsert",
  "content": "# Token budget\n...",
  "author": "ops-agent"
}
```

完整路由和稳定错误码以 `src/app.js` 为准。

