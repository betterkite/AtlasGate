# 网关、协议与治理

> ID: `GW-001` / `GW-002` / `GOV-001`  
> 状态: `implemented`

## 1. 目的与边界

网关把 OpenAI Chat Completions、Responses、Anthropic Messages 与 Embeddings 请求统一转换为内部请求（SSE 流式与 Token 计数同走 `/v1/*`），再根据能力、白名单、额度和 Provider 状态选择上游。它负责路由证据、凭据池、有限 Failover、用量和审计；不负责上游模型本身的推理质量。

身份分两类：管理面 `/api/*` 用管理员 cookie 会话（`src/services/auth.js`）；网关面 `/v1/*` 用客户端密钥 Bearer（`src/services/gateway.js#authenticate`），密钥带 scope/模型白名单/RPM/TPM/配额/月预算治理。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTTP | `src/app.js` | `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/embeddings`、`/v1/models` | 协议入口和响应封装 |
| 转换 | `src/services/protocol.js` | `fromOpenAIChat()`、`fromResponses()`、`fromAnthropic()`、`chatToAnthropic()`、`chatToResponse()` | 请求/响应协议归一化 |
| 流式 | `src/core/sse.js` | `sendOpenAIStream()`、`sendResponsesStream()`、`sendAnthropicStream()` | SSE 流式封装 |
| 路由 | `src/services/gateway.js` | `completeRequest()`、`plan()`、`simulate()`、`pickCredential()` | 候选评分、凭据选择和 Failover |
| 鉴权 | `src/services/auth.js` / `src/services/gateway.js` | `require()`（管理端）/ `authenticate()`（网关） | 两类身份校验 |
| 审计 | `src/db.js` | `routing_decisions`、`provider_attempts`、`usage_logs`、`provider_balance_snapshots` | 留存调用证据 |

## 3. 路由流程

```text
鉴权/Scope/配额
  -> 能力与风险扫描
  -> 显式 provider:model 或 auto 候选
  -> 过滤视觉能力
  -> profile 评分
  -> 凭据池选择
  -> 有界 Provider attempt
  -> 记录路由、用量、延迟和错误
```

Embeddings 与 Token 计数复用同一套路由决策。可重试的 408/429、5xx 和 timeout 才会进入下一个候选；客户端错误不会无条件级联。

## 4. 核心不变量

- Provider API key 只存在服务端，接口只返回 `has_api_key`。
- 客户端 API key 只保存 hash，明文只在签发时返回。
- 视觉请求不能路由到不支持视觉的 Provider。
- 每个 attempt 都有审计记录，包括失败 attempt。
- 删除客户端 key 不删除历史 usage log。
- 内置 mock Provider（`prv_local_demo`）受保护，不可删除。

## 5. 验证

```bash
npm start   # 0.4.0：控制台 http://127.0.0.1:4310（admin / atlasgate-admin），网关 Key atlasgate-dev-key
npm test    # 全量：Node 92 + Python 19，无 npm 运行依赖
```

网关行为集中在 `test/atlasgate.test.js`；知识版本/Wiki 由 `test/wiki-phase*.test.js` 覆盖；python worker 由 `python/tests` 覆盖。应覆盖协议 envelope（Chat/Responses/Anthropic/Embeddings）、模型白名单、RPM/TPM 与配额/预算、风险阻断、显式路由、自动路由、有限 Failover、Provider/凭据生命周期和密钥隔离。

## 6. 端到端复现（照抄即可复现）

```bash
# 1) 管理端登录（cookie 会话）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) 签发客户端密钥（明文只在签发时返回）
KEY=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/keys \
  -H 'content-type: application/json' \
  -d '{"name":"dev-cli","scopes":["gateway:invoke"],"requests_per_minute":60,"tokens_per_minute":100000,"quota_tokens":1000000}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
echo "KEY=$KEY"

# 3) 网关调用（Bearer 客户端密钥；未创建密钥时也可直接用 atlasgate-dev-key）
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'

# 4) 审计证据：每次 attempt 与用量
curl -b cookies.txt "http://127.0.0.1:4310/api/provider-attempts?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/usage/breakdown"
```

详细用户行为见 [`docs/zh-CN/GATEWAY.md`](../GATEWAY.md)（含 DeepSeek Provider、余额、客户端密钥等完整示例），决策依据见 [`docs/zh-CN/DECISIONS.md`](../DECISIONS.md)。
