# 部署说明

> 版本基线：**0.4.0**（测试 Node 92 / Python 19；零 npm 运行依赖）。默认监听 `http://127.0.0.1:4310`，控制台 `admin / atlasgate-admin`，网关 key `atlasgate-dev-key`（仅开发模式自动播种）。

## 本地进程

要求 Node.js 24+（含 `node:sqlite`）和 Python 3.11+：

```bash
python3 -m pip install -r python/requirements.txt --target python/vendor   # 可选：PDF 解析（pypdf）
npm start
```

项目没有 npm 运行时依赖，不需要执行 `npm install`。服务默认监听 `http://127.0.0.1:4310`。常用环境变量覆盖：

```bash
ATLASGATE_PYTHON=python3 npm start        # 没有 python 别名时显式指定
ATLASGATE_PORT=4311 npm start             # 换端口（4310 被占用时）
ATLASGATE_DEV_MODE=false ATLASGATE_ADMIN_PASSWORD='强密码' npm start   # 关闭开发默认值
```

启动后立即验证：

```bash
curl http://127.0.0.1:4310/health                     # {"status":"ok","version":"0.4.0",...}
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

## 环境变量速查

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ATLASGATE_HOST` / `ATLASGATE_PORT` | `127.0.0.1` / `4310` | 监听地址与端口；容器内必须 `0.0.0.0` |
| `ATLASGATE_DB_PATH` | `data/atlasgate.db` | SQLite 文件路径；Docker 中为 `/data/atlasgate.db` |
| `ATLASGATE_DEV_MODE` | `true` | `false` 时禁用默认管理员密码与开发网关 key，必须提供 `ATLASGATE_ADMIN_USERNAME/PASSWORD` |
| `ATLASGATE_ADMIN_USERNAME/PASSWORD` | `admin` / `atlasgate-admin` | 控制台管理员（生产必须改） |
| `ATLASGATE_DEV_KEY` | `atlasgate-dev-key` | 开发网关密钥，共享环境必须更换 |
| `ATLASGATE_RETRIEVAL_MODE` | `hybrid` | `local`（纯词法）/ `hybrid`（词法+本地稠密向量 RRF，默认）/ `qdrant`（仅稠密） |
| `ATLASGATE_EMBEDDING_BASE_URL` | 空 | OpenAI 兼容 `/v1/embeddings`；为空时 hybrid 自动降级纯词法 |
| `ATLASGATE_EMBEDDING_MODEL` / `_DIMENSIONS` | `bge-small-zh-v1.5` / `512` | 本地 ONNX embedding（`python/atlasgate_agent/embedding_worker.py`） |
| `ATLASGATE_QDRANT_URL` / `_API_KEY` | 空 | 仅 `qdrant` 模式需要 |
| `ATLASGATE_QUERY_REWRITE_ENABLED` / `QUERY_SEDIMENT_ENABLED` | `true` / `true` | 零证据查询改写 / 问答自动沉淀（ADR-015）开关 |
| `ATLASGATE_WIKI_SYNC_DIR` | `knowledge` | md 镜像目录；容器内建议 `/data/knowledge` 以持久化 |

完整清单见 [CONFIGURATION.md](CONFIGURATION.md)。

## Docker Compose

```bash
cp .env.example .env
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:4310/health
```

镜像使用 Node 24 Alpine、Python 3、非 root 用户（`atlasgate`）和 `/data` 持久化目录。不要在确认要删除数据前运行 `docker compose down -v`。

日常运维：

```bash
docker compose logs -f atlasgate          # 服务日志（启动/迁移/镜像同步/队列失败）
docker compose restart atlasgate          # 重启
docker compose exec atlasgate sh          # 进容器排查（数据在 /data/atlasgate.db）
```

> 注意：镜像默认 `ATLASGATE_DEV_MODE=false`；`cp .env.example .env` 会把 `.env` 里的开发默认值（dev 模式 + 默认管理员密码）带回来。生产部署请编辑 `.env` 设 `ATLASGATE_DEV_MODE=false`、配置 `ATLASGATE_ADMIN_USERNAME/PASSWORD` 与自己的网关密钥，并保持 `.env` 不入库。

## 持久化

- 唯一必须持久化的是 **SQLite**：Compose 卷 `atlasgate-data` 挂载到 `/data`，数据库在 `/data/atlasgate.db`（WAL 模式）。
- **md 镜像默认不持久化**：`ATLASGATE_WIKI_SYNC_DIR` 默认相对项目根，容器里是 `/app/knowledge`（可写但会随容器重建丢失）。要在容器里持久化镜像，设 `ATLASGATE_WIKI_SYNC_DIR=/data/knowledge`。
- 备份 = SQLite 一致性快照（先 checkpoint 再复制，见 [CONSOLE_OPS.md](CONSOLE_OPS.md) 第 2 节）；知识页面、向量、审计、密钥、Skills、Memory 都在库里。
- 启用 `qdrant` 模式时，`qdrant-data` 卷保存向量集合，需与 SQLite 一并快照。

## Qdrant

在 `.env` 配置检索和 Embedding 变量后运行：

```bash
docker compose --profile semantic up -d --build
```

要求：`ATLASGATE_RETRIEVAL_MODE=qdrant`、`ATLASGATE_QDRANT_URL=http://qdrant:6333`、`ATLASGATE_EMBEDDING_BASE_URL`（Qdrant 本身不提供 Embedding，`ATLASGATE_EMBEDDING_BASE_URL` 必须能从 AtlasGate 容器内部访问）。`hybrid` 模式不需要 Qdrant，本地稠密向量存在 SQLite（`semantic_vectors` 表）。

## 生产拓扑

建议将 AtlasGate 放在可信私网中的认证反向代理之后，由代理终止 TLS、限制管理路由并注入密钥。SQLite 只能作为单写节点使用。多节点高可用需要新的控制面数据库、分布式限流和持久化索引队列，目前不在项目范围内。

## 回滚与备份

1. 停止写入或进入维护窗口。
2. 使用 SQLite 一致性快照备份数据库，不要在 WAL 写入期间直接复制半成品文件。
3. 将镜像版本和环境配置与备份一同保存。
4. 回滚镜像，恢复兼容数据库，启动后检查健康状态和知识版本读取。

```bash
# 热备份（先 checkpoint 再复制）
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/atlasgate.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db
# Docker 下：docker compose exec atlasgate sh -c 'cp /data/atlasgate.db /data/atlasgate-$(date +%F-%H%M).db'
```

项目不提供破坏性的自动 schema 降级。

## 常见部署故障

| 现象 | 处理 |
| --- | --- |
| 容器启动即退出 | 多半是 `ATLASGATE_DEV_MODE=false` 且未配置 `ATLASGATE_ADMIN_PASSWORD`（AuthService 启动即报错）；`docker compose logs atlasgate` 查看，编辑 `.env` 后 `docker compose up -d` |
| 端口冲突 | 改 `ATLASGATE_PUBLISHED_PORT`（Compose 默认映射 4310）或换本地端口 |
| `health` 一直不通过 | `docker compose ps` 看健康状态；`docker compose logs` 看启动/迁移/镜像同步报错 |
| 改了 `.env` 没生效 | `docker compose up -d` 重建容器（`env_file` 在容器创建时读取） |
