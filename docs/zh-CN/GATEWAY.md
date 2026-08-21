# 模型网关（Gateway）使用知识

本模块负责：**统一入口 + 鉴权限流 + 智能路由 + 用量审计 + 上游余额**。对应控制台视图 04「模型网关」与 05「路由策略」。

## 1. 概念地图

```
调用方 ──Bearer 客户端密钥──▶ /v1/* 协议入口（OpenAI/Responses/Anthropic/Embeddings）
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
| **Provider** | 一个上游服务 | kind（openai/anthropic/mock）、base_url、api_key、models、quality/cost/latency/reliability 评分、健康状态 |
| **凭据**（credentials） | Provider 下的多把 key | weight（权重轮换）、quota、cooldown |
| **模型映射**（mappings） | 客户端别名 → 上游模型 | alias、upstream_model、priority、capabilities（text/vision） |
| **客户端密钥**（api_keys） | 调用方的身份+治理 | scopes、allowed_models、RPM/TPM、token 配额、月预算、team/user 归属 |

### 客户端密钥详细

- **scope**：`gateway:invoke`（默认）或 `*`；密钥只能调 `/v1/*`，不能进控制台。
- **限流**：`requests_per_minute`（RPM）、`tokens_per_minute`（TPM）按分钟窗口。
- **配额/预算**：`quota_tokens`（总 token 上限）、`monthly_budget_cents`（月预算）。
- **生命周期**：撤销（enabled=false）→ 立即失效；恢复；永久移除——**历史用量审计保留**（`retained_usage_logs`）。

## 3. 路由行为

- `model: "auto"`：按 profile 权重（quality/balanced/economy/latency）评分全部候选；**排除 mock 演示 Provider**（有真实上游时）。
- `model: "provider:model"`：显式指定。
- 视觉请求：自动过滤只保留声明 `vision` 能力的模型。
- 失败重试：候选按序尝试，429/5xx 触发 Failover，**每次 attempt 都记录**。

## 4. 上游余额（DeepSeek 自动识别）

- 当 Provider 的 `base_url` 是 `api.deepseek.com` 时，无需配置余额端点，自动使用官方 `https://api.deepseek.com/user/balance`（Bearer 用同一把 key）查询。
- 结果存 `providers.balance_amount/currency/status/checked_at` + 快照表。
- 「运行总览」顶部卡片显示**上游 API Key 余额**，进入总览自动刷新（每分钟至多一次），也可点「刷新余额」。
- 想自定义端点：在 Provider 上配置 `balance_endpoint`（覆盖自动识别），支持 DeepSeek `balance_infos[].total_balance`、OpenAI 类 `data.total_credits`、通用 `balance` 三种响应格式。

## 5. 健康与诊断

- 「测试」：调 `{base_url}/models`，写健康状态与延迟。
- 「路由策略 → 模拟」：输入任意请求，看**最终选中 + 全部候选评分 + 排除原因**（模型未映射/能力不足/mock 抑制等）。
- 「审计证据」：每条请求的路由决策、attempt、用量、风险级别、**调用方密钥**。

## 6. 常见坑

- **客户端密钥≠管理员**：密钥在 `/api/*` 上无效；管理员在 `/v1/*` 上无效。
- **auto 不选 mock**：配置真实 Provider 后 auto 会自动忽略演示 Provider；只有 mock 时才用本地抽取式。
- **余额显示"未配置"**：Provider 未配置余额端点且 base_url 不是 deepseek；或未点过"余额"。
- **密钥配额耗尽**：`quota_exhausted`/`budget_exhausted` 429，在密钥列表看 used/quota。

## 7. 相关文档

- [Configuration](CONFIGURATION.md)（ATLASGATE_* 环境变量）
- [API](API.md)（`/api/providers`、`/api/keys`、`/v1/*` 端点）
- [Operations](CONSOLE_OPS.md)（密钥轮换、Provider 维护）
