# 能力对照矩阵

本矩阵记录已经有代码和测试证据的能力。参考项目只用于能力对照，不代表 AtlasGate 承诺复制其托管产品。

| 能力 | AtlasGate 状态 | 当前边界 |
|---|---|---|
| OpenAI Chat Completions | 已实现 | 流式与非流式均支持；`auto` 路由本地 mock 可离线验证 |
| OpenAI Responses | 已实现 | 已覆盖请求、响应、SSE 流式转换路径 |
| Anthropic Messages | 已实现 | 已覆盖消息、`/v1/messages/count_tokens` 和工具转换 |
| Embeddings | 已实现 | 网关转发上游 `/v1/embeddings`；Agent 稠密检索用本地 ONNX `bge-small-zh` 或 OpenAI 兼容服务 |
| SSE 流式响应 | 已实现 | OpenAI/Responses/Anthropic 三种 envelope 服务端分片输出；上游先完成再流式，透明 token 转发和断连传播尚未完成 |
| Provider 与模型映射 | 已实现 | 能力感知映射 + 模型白名单；更多厂商专用适配器仍可扩展 |
| 凭据池 | 已实现 | 支持多 Key、权重、配额和冷却；应用层加密未完成 |
| 路由与 Failover | 已实现 | 支持能力过滤、评分策略、有界重试和 attempt 审计 |
| 租户治理 | 已实现基础能力 | 组织/团队/用户与 scope 密钥；OIDC 和管理员 RBAC UI 尚未完成 |
| 计费订阅 | 部分 | 只有用量、成本估算和上游余额，没有支付、发票和订阅服务 |
| MD/TXT/PDF 导入 | 已实现 | 文本 PDF；扫描 PDF OCR 和 Office 格式尚未完成 |
| Git/URL/目录摄入 | 部分 | URL 摄入已支持（Wiki 编译器 fetchUrl），Git/目录自动摄入仍有限 |
| LLM Wiki 编译 | 已实现 | 两步编译（analysis→generation）、per-KB `review`/`auto`、批次审阅、SHA256 去重、`force:true`、降级页、两级 Lint、md 镜像、ZIP 导出 |
| Hybrid 检索 | 已实现 | hybrid 默认（词法 bigram + 稠密 RRF）、无 embedding 自动降级纯词法、伪重排、零证据改写、wikilink 多跳；语义质量需要真实 Embedding 服务 |
| 知识图谱 | 已实现 | 纯 JS ForceAtlas2 + Louvain 社区、5 信号相关边、`query_hits` 引用热度（30 天窗口）、按知识库和 Master 版本隔离 |
| 多用户知识治理 | 已实现基础能力 | Change→merge→不可变 Master、冲突账本、tombstone、批次审阅；外部身份提供商尚未接入 |
| 问答沉淀与技能检索（ADR-015） | 已实现 | 显式/自动沉淀走审计链、同 slug 复用、`query_hits` 热度、SKILL.md `retrieval` attach 注入；签名和评测门禁尚未完成 |
| Agent、Memory、Skills | 已实现 | 本地 fallback 不是模型综合推理；技能签名和评测门禁尚未完成 |
| MCP | 部分 | 已提供受治理工具，但工具面小于参考产品 |
| 高可用 | 未实现 | 没有多节点控制面、分布式锁和持久化分布式队列 |

新增能力必须同时补充自动化测试、文档和明确生产边界。

## 可复现示例（对照上述已实现行验证）

```bash
# 管理端：cookie 登录
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 网关端：Bearer 调用（Chat Completions / 模型列表 / Embeddings 需真实上游）
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'

# LLM Wiki 编译 + Hybrid 检索 + ADR-015（$KB 承接建库返回的 id）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"示例库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"素材.md","text":"向顶天在枯井底发现半块石壁。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"石壁 线索","top_k":5}'
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么\",\"save_to_wiki\":true}"
```
