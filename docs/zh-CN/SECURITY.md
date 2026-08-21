# 安全边界

> 版本基线：**0.4.0**。当前版本面向本机或可信私网，不应直接暴露到公网。控制台默认 `admin / atlasgate-admin`、网关开发 key `atlasgate-dev-key` 只在开发模式（`ATLASGATE_DEV_MODE=true`）下生效。

## 威胁模型

系统需要保护 Provider 凭据、客户端网关密钥、Prompt、用量证据和已发布知识。主要风险包括未授权调用、控制面修改、密钥泄露、跨租户访问、恶意导入、上游 SSRF、资源耗尽和日志泄露 Prompt。

## 已实现控制

- **两套认证边界**：管理端 `/api/*`（除 `/api/auth/*` 外）要求管理员会话——`HttpOnly` + `SameSite=Lax` cookie（`atlasgate_admin_session`），默认 8 小时（`ATLASGATE_ADMIN_SESSION_TTL_MS`），改密后其它会话全部失效；网关 `/v1/*` 要求 `Authorization: Bearer <key>` 或 `X-Api-Key`。
- 开发网关 key `atlasgate-dev-key` 仅在 `ATLASGATE_DEV_MODE=true` 时自动播种（`db.js`），生产 `false` 后不生成，需自行签发密钥。
- 客户端密钥保存为 SHA-256 hash，并检查 scope、模型白名单、RPM/TPM、token 配额、月预算、团队/组织预算与归属用户启停状态。
- Provider 凭据只在服务端保存，API 只返回存在性或前缀元数据。
- Prompt preview 有长度上限并脱敏；风险模式可阻断疑似密钥泄露（私钥/`sk-` 长串标记 critical）。
- JSON、文件大小、Python 超时、worker 队列、重试和结果数量均有上限；worker 池 unhealthy 后快速失败（503），不泄漏 FD。
- 知识协作使用乐观 revision，已发布版本不可变；冲突账本与 tombstone 保留证据；问答沉淀（ADR-015）同样走 Change 审计链，不绕过审阅。
- Skill 导入只接受 UTF-8 `SKILL.md`/`skill.json` 内容（≤256 KB），不接受服务端路径。
- 容器使用非 root 用户，并设置基础安全响应头。

## 快速验证（照抄可跑）

默认开发配置（`npm start`，http://127.0.0.1:4310）验证两个边界：

```bash
# 管理端：cookie 会话（HttpOnly + SameSite=Lax），未登录访问 /api/* 返回 401
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/keys
curl http://127.0.0.1:4310/api/keys          # 无 cookie → 401 admin_auth_required

# 网关端：Bearer key 调 /v1/*（开发 key 只在 dev 模式存在）
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/models          # 无 key → 401 missing_api_key

# 管理员改密（新密码 ≥12 字符；成功后其它会话全部失效）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"current_password":"atlasgate-admin","new_password":"a-strong-new-password-2026"}'
```

## 已知边界

当前管理 API 尚未提供管理员 SSO/RBAC、CSRF 防护（仅 `SameSite=Lax` 缓解）和 TLS 终止。Provider 凭据尚未应用层加密，Provider URL 校验和 DNS rebinding 防护也不是完整的出口防火墙。因此应绑定回环地址，或使用认证反向代理和网络出口策略。

MCP 端点 `POST /mcp` 不在 `/api/*` 之下、不要求管理员会话，但只暴露声明的受治理工具集（知识搜索/提问/图谱/Change/合并/摄入/审阅/Lint/Memory/Skills），且不返回任何密钥（见 [guides/06-console-and-mcp.md](guides/06-console-and-mcp.md)）。

## 生产加固清单

- 设置 `ATLASGATE_DEV_MODE=false`：不再播种 `atlasgate-dev-key`，并要求显式提供 `ATLASGATE_ADMIN_USERNAME/PASSWORD`；不要复用默认开发密钥/默认管理员密码（≥12 字符）。
- 只允许反向代理和管理员访问 4310 端口；管理路由（`/api/*`、`/mcp`）可再按来源限制。
- 为 `/api/*` 增加身份认证（如需 SSO/RBAC 请前置到代理），`/v1/*` 继续使用网关密钥。
- 使用 Secret Manager 或加密存储保存 `.env` 和 Provider 凭据；`ATLASGATE_ADMIN_SESSION_TTL_MS` 按需收紧。
- 只允许访问批准的 Provider、Embedding 和 Qdrant 地址（出网白名单，防 SSRF）。
- 配置 Qdrant 鉴权，不要公开 6333 端口。
- 监控 401/403/429/5xx、worker 重启、队列饱和、余额失败和冲突增长（`/api/logs`、`/api/provider-attempts`、`/api/knowledge-bases/:id/conflicts`）。
