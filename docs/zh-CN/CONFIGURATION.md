# 配置说明

AtlasGate 从环境变量读取配置。Docker Compose 可复制 `.env.example`，进程部署也可直接设置环境变量。不要提交 `.env` 或任何密钥。

## 服务与存储

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ATLASGATE_HOST` | `127.0.0.1` | 监听地址；没有可信反向代理时保持回环地址 |
| `ATLASGATE_PORT` | `4310` | HTTP 端口 |
| `ATLASGATE_DB_PATH` | `data/atlasgate.db` | SQLite 文件路径；Docker 中通常为 `/data/atlasgate.db` |
| `ATLASGATE_DEV_MODE` | `true` | 是否启用开发数据；生产必须设为 `false` |
| `ATLASGATE_DEV_KEY` | `atlasgate-dev-key` | 开发网关密钥，共享环境必须替换 |
| `ATLASGATE_ADMIN_USERNAME` | 开发环境为 `admin` | 控制台管理员账号 |
| `ATLASGATE_ADMIN_PASSWORD` | 开发环境为 `atlasgate-admin` | 控制台管理员密码，生产必须使用强密码 |
| `ATLASGATE_ADMIN_SESSION_TTL_MS` | `28800000` | HttpOnly 管理员会话有效期 |
| `ATLASGATE_REQUEST_TIMEOUT_MS` | `60000` | 上游和向量服务的请求超时上限 |

SQLite 使用 WAL 和外键。数据库应放在持久化本地或块存储中，备份时必须同时考虑 WAL 状态。

## Python Agent Worker

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ATLASGATE_PYTHON` | 自动探测 | 先探测 `python`，再探测 `python3`；可显式覆盖 |
| `ATLASGATE_PYTHON_TIMEOUT_MS` | `15000` | Agent 准备请求超时 |
| `ATLASGATE_PYTHON_WORKER_POOL_SIZE` | `2` | 常驻 Python worker 数量 |
| `ATLASGATE_PYTHON_WORKER_QUEUE_LIMIT` | `100` | 等待队列上限，满载返回 503 |
| `ATLASGATE_PYTHON_WORKER_MAX_REQUESTS` | `1000` | 单个 worker 处理多少请求后回收 |

当前环境只有 `python3` 时可使用：

```bash
ATLASGATE_PYTHON=python3 npm start
```

## 检索与 Wiki

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | 检索模式：`local`（纯词法，遗留默认）、`hybrid`（词法 + 本地稠密向量按 RRF 融合，默认）、`qdrant`（仅稠密，需 Qdrant） |
| `ATLASGATE_EMBEDDING_BASE_URL` | 空 | OpenAI 兼容 `/v1/embeddings` 服务地址（本地 ONNX 服务 `python/atlasgate_agent/embedding_worker.py` 或其他厂商）；为空时 `hybrid` 自动降级纯词法 |
| `ATLASGATE_EMBEDDING_API_KEY` | 空 | Embedding 服务密钥 |
| `ATLASGATE_EMBEDDING_MODEL` | `bge-small-zh-v1.5` | Embedding 模型名 |
| `ATLASGATE_EMBEDDING_DIMENSIONS` | `512` | 向量维度 |
| `ATLASGATE_QDRANT_URL` | 空 | Qdrant 地址（仅 `qdrant` 模式） |
| `ATLASGATE_QDRANT_API_KEY` | 空 | Qdrant 密钥 |
| `ATLASGATE_QDRANT_COLLECTION_PREFIX` | `atlasgate` | Qdrant 集合名前缀 |
| `ATLASGATE_QUERY_REWRITE_ENABLED` | `true` | 是否允许零证据问题改写后重试一次（需真实 LLM Provider，mock 下无效） |
| `ATLASGATE_QUERY_SEDIMENT_ENABLED` | `true` | 是否允许问答自动沉淀进 Wiki（相似问题≥3次+质量规则，或显式 `save_to_wiki`/`sediment` 请求） |
| `ATLASGATE_WIKI_INGEST_MODE` | `review` | 每库默认摄入模式：`review`（Change 留待人工审阅后合并）或 `auto`（编译/沉淀后自动合并） |
| `ATLASGATE_WIKI_MAX_PAGES_PER_SOURCE` | `20` | 单个素材最多编译出的页面数 |
| `ATLASGATE_WIKI_INGEST_POLL_MS` | `2000` | 摄入队列轮询间隔 |
| `ATLASGATE_WIKI_INGEST_CONCURRENCY` | `1` | 并发摄入数 |
| `ATLASGATE_WIKI_SYNC_DIR` | `knowledge` | 单向 Markdown 镜像目录（相对项目根或绝对路径）；设为空字符串可禁用镜像 |
| `ATLASGATE_WIKI_PURPOSE_PATH` | `purpose.md` | purpose 系统页路径 |
| `ATLASGATE_WIKI_SCHEMA_PATH` | `schema.md` | schema 系统页路径 |
| `ATLASGATE_WIKI_INDEX_PATH` | `index.md` | index 系统页路径（编译器维护） |
| `ATLASGATE_WIKI_LOG_PATH` | `log.md` | log 系统页路径（编译器维护） |
| `ATLASGATE_WIKI_OVERVIEW_PATH` | `overview.md` | overview 系统页路径（编译器维护） |

检索说明：

- `hybrid`（默认）：词法 bigram 页面级检索与本地稠密向量（`semantic_vectors` 表，SQLite 内余弦相似度）按 **RRF** 融合；未配置 `ATLASGATE_EMBEDDING_BASE_URL` 时自动降级为纯词法，不报错。
- `qdrant`：仅稠密检索，要求同时配置 `ATLASGATE_QDRANT_URL` 与 `ATLASGATE_EMBEDDING_BASE_URL`。
- embedding 可完全离线：本地 ONNX 服务 `python/atlasgate_agent/embedding_worker.py`（bge-small-zh-v1.5，512 维，唯一新增依赖 `onnxruntime`），或接任意 OpenAI 兼容 `/v1/embeddings`。DeepSeek 官方无 embedding 模型。
- 知识库页面级 feature hashing 向量是离线特征，不得标记成语义 Embedding。
- 系统页（`index.md`/`log.md`/`purpose.md`/`schema.md`/`overview.md`）与降级页（`atlasgate-degraded` 标记）默认不参与检索。

## Provider

Provider 支持 `openai`、`anthropic` 和内置 `mock` 类型。创建 Provider 时可设置 `name`、`kind`、`base_url`、`models`、能力、评分、`api_key` 和 `balance_endpoint`。Provider 密钥只在服务端保存，接口不会返回密钥内容。

## 快速验证

默认开发配置（零 npm 运行依赖）直接启动，控制台 http://127.0.0.1:4310：

```bash
npm start
# 健康检查：确认版本、Python 池与检索状态
curl http://127.0.0.1:4310/health
# 默认凭据登录验证管理端
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
```

启用稠密检索（本地 ONNX embedding + hybrid）：

```bash
python3 python/atlasgate_agent/embedding_worker.py \
  --model /path/to/bge-small-zh-v1.5/onnx/model.onnx \
  --tokenizer /path/to/bge-small-zh-v1.5 \
  --host 127.0.0.1 --port 8031
ATLASGATE_EMBEDDING_BASE_URL=http://127.0.0.1:8031/v1 npm start
# 健康检查应显示 retrieval.enabled=true
curl http://127.0.0.1:4310/health
```
