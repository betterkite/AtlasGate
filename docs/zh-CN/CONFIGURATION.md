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
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | `local`、`hybrid` 或 `qdrant` |
| `ATLASGATE_EMBEDDING_BASE_URL` | 空 | OpenAI 兼容 Embedding 服务地址 |
| `ATLASGATE_EMBEDDING_API_KEY` | 空 | Embedding 服务密钥 |
| `ATLASGATE_EMBEDDING_MODEL` | `bge-small-zh-v1.5` | Embedding 模型名 |
| `ATLASGATE_EMBEDDING_DIMENSIONS` | `512` | 向量维度 |
| `ATLASGATE_QDRANT_URL` | 空 | Qdrant 地址 |
| `ATLASGATE_QDRANT_API_KEY` | 空 | Qdrant 密钥 |
| `ATLASGATE_WIKI_INGEST_MODE` | `review` | `review` 或 `auto` |
| `ATLASGATE_WIKI_SYNC_DIR` | `knowledge` | 单向 Markdown 镜像目录 |
| `ATLASGATE_QUERY_REWRITE_ENABLED` | `true` | 是否允许零证据问题改写后重试 |
| `ATLASGATE_QUERY_SEDIMENT_ENABLED` | `true` | 是否允许问答自动沉淀进 Wiki（相似问题≥3次+质量规则，或显式请求） |

未配置 Embedding 服务时，`hybrid` 会退化为本地词法检索。feature hashing 向量是离线特征，不得标记成语义 Embedding。

## Provider

Provider 支持 `openai`、`anthropic` 和内置 `mock` 类型。创建 Provider 时可设置 `name`、`kind`、`base_url`、`models`、能力、评分、`api_key` 和 `balance_endpoint`。Provider 密钥只在服务端保存，接口不会返回密钥内容。

