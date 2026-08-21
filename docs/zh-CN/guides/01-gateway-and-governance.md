# 网关、协议与治理

> ID: `GW-001` / `GW-002` / `GOV-001`  
> 状态: `implemented`

## 1. 目的与边界

网关把 OpenAI、Responses 和 Anthropic 请求统一转换为内部请求，再根据能力、白名单、额度和 Provider 状态选择上游。它负责路由证据、凭据池、有限 Failover、用量和审计；不负责上游模型本身的推理质量。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTTP | `src/app.js` | `/v1/*` | 协议入口和响应封装 |
| 转换 | `src/services/protocol.js` | `fromOpenAIChat()`、`fromAnthropic()` | 请求/响应协议归一化 |
| 路由 | `src/services/gateway.js` | `completeRequest()`、`simulate()` | 候选评分、凭据选择和 Failover |
| 鉴权 | `src/services/auth.js` | `require()` | 管理员 session |
| 审计 | `src/db.js` | `routing_decisions`、`provider_attempts`、`usage_logs` | 留存调用证据 |

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

可重试的 429、5xx 和 timeout 才会进入下一个候选；客户端错误不会无条件级联。

## 4. 核心不变量

- Provider API key 只存在服务端，接口只返回 `has_api_key`。
- 客户端 API key 只保存 hash，明文只在签发时返回。
- 视觉请求不能路由到不支持视觉的 Provider。
- 每个 attempt 都有审计记录，包括失败 attempt。
- 删除客户端 key 不删除历史 usage log。

## 5. 验证

```bash
node --test test/atlasgate.test.js
```

应覆盖协议 envelope、模型白名单、RPM/TPM、风险阻断、显式路由、自动路由、有限 Failover、Provider 生命周期和密钥隔离。

详细用户行为见 [`docs/zh-CN/GATEWAY.md`](../GATEWAY.md)，决策依据见 [`docs/zh-CN/DECISIONS.md`](../DECISIONS.md)。
