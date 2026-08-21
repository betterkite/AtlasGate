# 测试报告

本文件记录最近一次测试证据，必须区分离线确定性测试、mock 测试和真实 Provider/Qdrant 验证。

## 当前证据（版本 0.4.0）

- Node **92** 项全部通过（`test/` 13 个文件：`atlasgate`、`frontmatter`、`graph-layout`、`wiki-phase0~8`、`wiki-sync`，外加 `performance.bench` 基准）。覆盖协议转换、路由、配额、版本治理，以及 LLM Wiki 全阶段（wiki-phase0~8）：
  - phase0：五系统页安装、`ingest_mode` 默认值与校验、schema/purpose 协同、遗留库升级、检索默认排除系统页；
  - phase1：两步编译（analysis→generation）、降级页与 auto 模式自动合并、SHA256 去重、校验、任务崩溃恢复、`force:true` 重新摄入；
  - phase2：发布后自动结构 Lint、报告生命周期、一键建页、`queries/` 沉淀与 `save_to_wiki`；
  - phase3：Louvain 社区、5 信号相关边、图谱洞察、遗留版本惰性重建；
  - phase4：ZIP 导出（UTF-8、显式版本）、research-jobs；
  - phase5：RAG 1——hybrid RRF 融合、`semantic_vectors` 页级索引、无 embedding 自动降级；
  - phase6：RAG 2——图谱度数伪重排、零证据查询改写；
  - phase7：ADR-015 A——显式/自动沉淀、智能归类、质量门禁、审计链；
  - phase8：ADR-015 B/C——图谱 `query_hits` 引用热度、技能 `retrieval` 声明注入。
- Python **19** 项全部通过（`python/tests/` 4 个文件：`test_engine`、`test_frontmatter`、`test_ingest`、`test_lint`），覆盖中文分词/bigram、页面检索、Dense/Lexical RRF 融合、多跳扩展、Prompt 构造（两步 STAGE 标记）、frontmatter 和 Lint 构造。
- 性能测试覆盖常驻 Python pool 和本地确定性工作负载（mock 网关 1000 请求并发 20 的 p95 上限断言）。

## 当前限制

- 真实模型综合回答需要配置上游 Provider（如 DeepSeek）；未配置时 Agent 走本地抽取式 fallback，不得报告为模型质量。
- 语义检索质量需要真实 Embedding 服务：本地 ONNX `bge-small-zh`（`python/atlasgate_agent/embedding_worker.py`）或任何 OpenAI 兼容 `/v1/embeddings`（`ATLASGATE_EMBEDDING_BASE_URL`）；未配置时 hybrid 自动降级为纯词法。Qdrant 模式还需要运行中的 Qdrant。
- 公网管理面需要当前进程之外的身份认证、TLS、CSRF 和网络控制。
- 扫描 PDF OCR 尚未实现。
- 当前环境可能只有 `python3`，完整 npm 脚本中的 `python` 调用需要显式修正（运行期服务自动探测 `python`/`python3`，npm 脚本不会）。

## 报告要求

执行测试时记录日期、操作系统、Node/Python 版本、配置、命令、通过/失败/跳过数量、性能参数和剩余风险。失败输出不得包含密钥或原始敏感 Prompt。不要把 mock 或 fallback 行为报告为真实模型质量。

## 可复现示例

### 全量测试

```bash
npm test          # Node 92 + Python 19
```

### 分步与冒烟

```bash
npm run test:node
python3 -m unittest discover -s python/tests -v
npm run test:performance

# 冒烟：管理端 cookie 登录 -> 网关 Bearer
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/overview
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```
