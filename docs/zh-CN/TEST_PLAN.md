# 测试计划

状态：基础测试计划。目标是验证 AtlasGate 是受治理的 LLM 网关和版本化知识 Agent 平台，而不只是验证进程能够启动。

## 1. 发布范围

本版本声明覆盖：

- OpenAI Chat Completions、Responses、Embeddings 和 Anthropic Messages 兼容接口。
- Provider、模型、凭据池、路由、余额、有界 Failover 和用量治理。
- MD、TXT、文本 PDF 导入，以及 Change、Master、冲突、删除 tombstone 和历史版本。
- Wiki 页面、frontmatter、图谱、LLM 编译、Review、Lint、同步和 ZIP 导出。
- Knowledge Agent、Memory、Skills、Python worker pool、本地检索和可选 Qdrant。
- 管理控制台、Docker 镜像和 MCP JSON-RPC。

不声明：多节点高可用、公网管理员安全、透明上游 token 流、扫描 PDF OCR、完整支付订阅和参考商业产品的功能等价。

## 2. 测试分组

| 分组 | 关注内容 |
|---|---|
| 功能测试 | 鉴权、额度、路由、Failover、Provider 生命周期、知识合并、冲突、导入、Agent、Memory、Skills、检索 |
| API 测试 | OpenAI/Anthropic envelope、SSE、错误码、请求 ID、健康检查和 MCP |
| 性能测试 | 网关延迟、检索、worker 复用、队列饱和、崩溃恢复、关闭和导入上限 |
| 安全测试 | 密钥隔离、风险阻断、scope、白名单、包校验、路径安全 |
| 交互测试 | 控制台视图、导入、图谱、Review、余额刷新和密钥显示 |

## 3. 业务规则

- 未授权或 scope 不足的请求必须在上游调用前失败。
- 视觉请求不能到达文本模型。
- 每次 Provider attempt 都必须进入审计。
- pending Change 不得进入 Master 检索。
- 发布必须让读者看到完整旧版本或完整新版本。
- 历史版本和已合并 Change 不可变。
- Agent 必须引用已发布证据，证据不足时明确拒绝猜测。
- `use_memory=false` 时不得读写 Memory。
- 本地 feature vector 不得被标记为语义 Embedding。

## 4. 运行命令

```bash
npm run test:node
python3 -m unittest discover -s python/tests -v
npm run test:performance
```

当前 `package.json` 的 Python 脚本仍直接调用 `python`；没有该别名的环境应显式使用 `python3`。

## 5. 发布门禁

每个 `implemented` 能力必须有对应代码、测试和边界说明。真实 Provider、Embedding、Qdrant、Docker 和浏览器测试必须标注实际运行环境，不能把 mock 或 fallback 结果写成生产质量证据。

