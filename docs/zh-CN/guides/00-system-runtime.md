# 系统运行时与服务边界

> ID: `SYS-001`  
> 状态: `implemented`（版本 0.4.0，测试 Node 92 / Python 19）

## 1. 目的与边界

AtlasGate 是一个模块化单体。Node.js 进程承载 HTTP 控制面、模型网关、知识版本服务和 Agent 适配；Python worker 承载 Agent 的检索准备、本地抽取式回答、两步编译 prompt 构造与 Lint（`python/atlasgate_agent/`）。SQLite 是控制面事实源（默认 `data/atlasgate.db`）。

默认开发配置：端口 **4310**（`ATLASGATE_PORT`），控制台 `admin / atlasgate-admin`（`ATLASGATE_ADMIN_USERNAME/PASSWORD`），网关 key `atlasgate-dev-key`（`ATLASGATE_DEV_KEY`，Bearer 头）。项目**零 npm 运行依赖**，`package.json` 仅声明脚本。

本功能不提供多节点高可用、分布式事务或公网管理员身份认证。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| 启动 | `src/server.js` | `main()` | 创建服务并监听端口 |
| 路由 | `src/app.js` | `createApp()` | 注册 API、鉴权和错误处理 |
| 配置 | `src/config.js` | `loadConfig()` | 读取环境变量和默认值 |
| 存储 | `src/db.js` | `openDatabase()` | 初始化 SQLite schema 和迁移 |
| Python | `src/services/python-agent.js` | `PythonAgentBridge` | 管理 worker pool、超时和重启 |

## 3. 执行流程

```text
server.js -> config/db/services -> createApp -> HTTP router
                                      |-> Node service
                                      |-> PythonAgentBridge -> JSON Lines worker
```

## 4. 实现原理

服务按领域划分，但共享同一个 SQLite 连接和明确的服务接口。数据库开启 WAL 与外键。Python worker 使用有界队列（`ATLASGATE_PYTHON_WORKER_QUEUE_LIMIT`），避免每个请求重新启动 Python；worker 崩溃后重建，连续启动失败会进入 unhealthy 状态并返回 503（队列满同样返回 503）。`/health` 返回 `version: "0.4.0"`、Python pool 状态和检索后端状态（`semanticIndex.status()`）。

## 5. 不变量与失败行为

- API 错误通过稳定的 HTTP 状态和错误码返回。
- Python worker 不可用时，Agent 请求快速失败（503 `python_agent_unavailable`），不无限 respawn。
- 数据库事务失败不能推进 Master 版本。
- `/health` 描述进程、数据库和 worker 状态；它不等同于所有上游 Provider 健康。

## 6. 验证

```bash
npm test          # Node 92 + Python 19（零 npm 运行依赖）
npm run check     # 语法 + 全量门禁
```

运行冒烟（默认端口 4310、默认凭据，照抄可复现）：

```bash
npm start

# 健康检查：version 0.4.0 + python pool + retrieval 状态
curl http://127.0.0.1:4310/health

# 管理端登录后调任意管理 API（示例：/api/overview）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/overview"

# 网关端用 Bearer key（本地 mock，离线可跑）
curl http://127.0.0.1:4310/v1/models \
  -H "Authorization: Bearer atlasgate-dev-key"
```

重点测试位于 `test/atlasgate.test.js`、`python/tests/test_engine.py` 和 `python/tests/test_ingest.py`。
