# 模型网关（Gateway）使用知识

本模块负责：**统一入口 + 鉴权限流 + 智能路由 + 用量审计 + 上游余额**。对应控制台视图 04「模型网关」与 05「路由策略」。

> 运行事实（版本 0.4.0）：`npm start` 启动，控制台在 **http://127.0.0.1:4310**，默认管理员 `admin / atlasgate-admin`；网关开发 Key 为 `atlasgate-dev-key`（`Authorization: Bearer` 头）；无 npm 运行依赖。首次启动自带内置 mock Provider（`prv_local_demo`）与开发密钥，可离线验证全链路。

## 1. 概念地图

```
调用方 ──Bearer 客户端密钥──▶ /v1/* 协议入口（Chat Completions / Responses / Anthropic Messages / Embeddings / SSE / Token 计数）
        │ ①鉴权（scope/白名单/限流/配额/预算）
        │ ②能力扫描（视觉请求只进视觉模型）
        │ ③路由评分（质量/成本/延迟/可靠性 + 亲和微调）
        ▼
    Provider 凭据池（多 key 轮换、冷却、Failover）
        ▼
    DeepSeek / OpenAI / Anthropic / 本地 mock
```

## 2. 对象与配置

| 对象 | 是什么 | 关键字段 |
| --- | --- | --- |
| **Provider** | 一个上游服务 | kind（openai/anthropic/mock）、base_url、api_key、models、quality/cost/latency/reliability 评分、健康状态、余额（balance_amount/currency/status/checked_at） |
| **凭据**（credentials） | Provider 下的多把 key | weight（权重轮换）、quota、cooldown、error_count |
| **模型映射**（mappings） | 客户端别名 → 上游模型 | alias、upstream_model、priority、capabilities（text/vision/tools/embeddings） |
| **客户端密钥**（api_keys） | 调用方的身份+治理 | scopes、allowed_models、RPM/TPM、token 配额、月预算、team/user 归属 |

> 添加 Provider 时会为每个模型自动创建映射（alias＝模型名），并（DeepSeek / OpenRouter）自动填充余额端点；`api_key` 会落成一把「Primary」凭据。内置 mock `prv_local_demo` 提供 `atlas-mini`、`atlas-vision` 两个模型，配置真实 Provider 后 `auto` 路由会自动忽略它。

### 客户端密钥详细

- **scope**：`gateway:invoke`（默认）或 `*`；密钥只能调 `/v1/*`，不能进控制台。
- **限流**：`requests_per_minute`（RPM）、`tokens_per_minute`（TPM）按分钟窗口。
- **配额/预算**：`quota_tokens`（总 token 上限）、`monthly_budget_cents`（月预算）；归属 team/organization 的密钥还会叠加团队与组织级月预算校验。
- **生命周期**：撤销（enabled=false）→ 立即失效；恢复；永久移除——**历史用量审计保留**（`retained_usage_logs`）。

## 3. 路由行为

- `model: "auto"`：按 profile 权重（quality/balanced/economy/latency，默认 balanced）评分全部候选；profile 可用请求头 `x-atlas-routing-profile` 或 body `routing_profile` 指定；**排除 mock 演示 Provider**（有真实上游时）。
- `model: "provider:model"`：显式指定。
- 视觉请求：自动过滤只保留声明 `vision` 能力的模型。
- 失败重试：候选按序尝试，可重试的 408/429、5xx 与超时触发 Failover（可用 `x-atlas-max-attempts` 限制上限，默认 4），**每次 attempt 都记录**。
- `/v1/models` 列出 `auto`、全部映射别名与 `provider:model` 全名。

## 4. 上游余额（DeepSeek 自动识别）

- 当 Provider 的 `base_url` 是 `api.deepseek.com` 时，无需配置余额端点，自动使用官方 `https://api.deepseek.com/user/balance`（Bearer 用同一把 key）查询；OpenRouter（`openrouter.ai`）同理自动识别为 `/api/v1/credits`。
- 结果存 `providers.balance_amount/currency/status/checked_at` + 只追加快照表 `provider_balance_snapshots`。
- 「运行总览」顶部卡片显示**上游 API Key 余额**，进入总览自动刷新（每分钟至多一次），也可点「刷新余额」。
- 想自定义端点：在 Provider 上配置 `balance_endpoint`（覆盖自动识别），支持 DeepSeek `balance_infos[].total_balance`、OpenAI 类 `data.total_credits`、通用 `balance` 三种响应格式。

## 5. 健康与诊断

- 「测试」（`POST /api/providers/:id/test`）：调 `{base_url}/models`，写健康状态与延迟。
- 「路由策略 → 模拟」（`POST /api/routing/simulate`）：输入任意请求，看**最终选中 + 全部候选评分 + 排除原因**（模型未映射/能力不足/mock 抑制等）。
- 「审计证据」：每条请求的路由决策（`routing_decisions`）、attempt（`provider_attempts`）、用量（`usage_logs`）、风险级别、**调用方密钥**。

## 6. 可复现示例（照抄即可复现）

> 管理端 API 先登录保存会话，后续用 `-b cookies.txt`；网关端用 Bearer 客户端密钥。默认端口 4310、默认凭据 `admin / atlasgate-admin`。

### 6.1 管理端登录

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"atlasgate-admin"}'
```

### 6.2 添加 DeepSeek Provider（自动建模型映射与余额端点）

```bash
PROVIDER=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"deepseek","kind":"openai","base_url":"https://api.deepseek.com","api_key":"sk-你的DeepSeekKey","models":["deepseek-chat","deepseek-reasoner"]}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "PROVIDER=$PROVIDER"
```

### 6.3 查看上游余额（DeepSeek 自动识别 /user/balance）

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/providers/$PROVIDER/balance" \
  -H 'content-type: application/json' -d '{}'
# 响应含 amount/currency/status/checked_at；也可从 GET /api/providers 直接读 balance 字段
```

### 6.4 创建客户端密钥（明文只在签发时返回）

```bash
KEY=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/keys \
  -H 'content-type: application/json' \
  -d '{"name":"my-app","scopes":["gateway:invoke"],"allowed_models":["deepseek-chat"],"requests_per_minute":60,"tokens_per_minute":100000,"quota_tokens":1000000}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
echo "KEY=$KEY"
```

### 6.5 模型网关调用（网关端 Bearer 密钥）

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'

# 未配置真实 Provider 时可用内置 mock 离线验证（开发 Key 直接用 atlasgate-dev-key）
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

### 6.6 其他协议入口（多协议网关）

```bash
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"

curl http://127.0.0.1:4310/v1/responses -H "Authorization: Bearer atlasgate-dev-key" \
  -H 'content-type: application/json' -d '{"model":"auto","input":"ping"}'

curl http://127.0.0.1:4310/v1/messages -H "Authorization: Bearer atlasgate-dev-key" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'

curl http://127.0.0.1:4310/v1/embeddings -H "Authorization: Bearer atlasgate-dev-key" \
  -H 'content-type: application/json' -d '{"model":"auto","input":"AtlasGate"}'

# SSE 流式（stream: true）
curl -N http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"ping"}]}'
```

## 7. 常见坑

- **客户端密钥≠管理员**：密钥在 `/api/*` 上无效；管理员在 `/v1/*` 上无效。
- **auto 不选 mock**：配置真实 Provider 后 auto 会自动忽略演示 Provider；只有 mock 时才用本地抽取式。
- **余额显示"未配置"**：Provider 未配置余额端点且 base_url 不是 deepseek/openrouter；或未点过"余额"。
- **密钥配额耗尽**：`quota_exhausted`/`budget_exhausted` 429，在密钥列表看 used/quota。
- **内置 mock 不可删除**：`prv_local_demo` 是受保护 Provider，删除返回 409。

## 8. 相关文档

- [Configuration](CONFIGURATION.md)（ATLASGATE_* 环境变量）
- [API](API.md)（`/api/providers`、`/api/keys`、`/v1/*` 端点）
- [Operations](CONSOLE_OPS.md)（密钥轮换、Provider 维护）
