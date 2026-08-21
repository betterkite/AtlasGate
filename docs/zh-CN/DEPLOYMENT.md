# 部署说明

## 本地进程

要求 Node.js 24 和 Python 3.11+：

```bash
python3 -m pip install -r python/requirements.txt --target python/vendor
npm start
```

项目没有 npm 运行时依赖，不需要执行 `npm install`。服务默认监听 `http://127.0.0.1:4310`。

## Docker Compose

```bash
cp .env.example .env
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:4310/health
```

镜像使用 Node 24 Alpine、Python 3、非 root 用户和 `/data` 持久化目录。不要在确认要删除数据前运行 `docker compose down -v`。

## Qdrant

在 `.env` 配置检索和 Embedding 变量后运行：

```bash
docker compose --profile semantic up -d --build
```

Qdrant 本身不提供 Embedding。`ATLASGATE_EMBEDDING_BASE_URL` 必须能从 AtlasGate 容器内部访问。

## 生产拓扑

建议将 AtlasGate 放在可信私网中的认证反向代理之后，由代理终止 TLS、限制管理路由并注入密钥。SQLite 只能作为单写节点使用。多节点高可用需要新的控制面数据库、分布式限流和持久化索引队列，目前不在项目范围内。

## 回滚与备份

1. 停止写入或进入维护窗口。
2. 使用 SQLite 一致性快照备份数据库，不要在 WAL 写入期间直接复制半成品文件。
3. 将镜像版本和环境配置与备份一同保存。
4. 回滚镜像，恢复兼容数据库，启动后检查健康状态和知识版本读取。

项目不提供破坏性的自动 schema 降级。

