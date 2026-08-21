# 安全边界

当前版本面向本机或可信私网，不应直接暴露到公网。

## 威胁模型

系统需要保护 Provider 凭据、客户端网关密钥、Prompt、用量证据和已发布知识。主要风险包括未授权调用、控制面修改、密钥泄露、跨租户访问、恶意导入、上游 SSRF、资源耗尽和日志泄露 Prompt。

## 已实现控制

- 客户端密钥保存为 SHA-256 hash，并检查 scope、白名单、配额和预算。
- Provider 凭据只在服务端保存，API 只返回存在性或前缀元数据。
- Prompt preview 有长度上限并脱敏；风险模式可阻断疑似密钥泄露。
- JSON、文件大小、Python 超时、worker 队列、重试和结果数量均有上限。
- 知识协作使用乐观 revision，已发布版本不可变。
- Skill 导入只接受 UTF-8 `SKILL.md`/`skill.json` 内容，不接受服务端路径。
- 容器使用非 root 用户，并设置基础安全响应头。

## 已知边界

当前管理 API 尚未提供管理员 SSO/RBAC、CSRF 防护和 TLS 终止。Provider 凭据尚未应用层加密，Provider URL 校验和 DNS rebinding 防护也不是完整的出口防火墙。因此应绑定回环地址，或使用认证反向代理和网络出口策略。

## 生产加固清单

- 设置 `ATLASGATE_DEV_MODE=false`，不要复用默认开发密钥。
- 只允许反向代理和管理员访问 4310 端口。
- 为 `/api/*` 增加身份认证，`/v1/*` 继续使用网关密钥。
- 使用 Secret Manager 或加密存储保存 `.env` 和 Provider 凭据。
- 只允许访问批准的 Provider、Embedding 和 Qdrant 地址。
- 配置 Qdrant 鉴权，不要公开 6333 端口。
- 监控 401/403/429/5xx、worker 重启、队列饱和、余额失败和冲突增长。

