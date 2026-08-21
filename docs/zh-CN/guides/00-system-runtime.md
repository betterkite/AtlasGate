# 系统运行时与服务边界

> ID: `SYS-001`  
> 状态: `implemented`

## 1. 目的与边界

AtlasGate 是一个模块化单体。Node.js 进程承载 HTTP 控制面、模型网关、知识版本服务和 Agent 适配；Python worker 承载 Agent 的检索准备和本地抽取式回答。SQLite 是控制面事实源。

本功能不提供多节点高可用、分布式事务或公网管理员身份认证。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| 启动 | `src/server.js` | `main()` | 创建服务并监听端口 |
| 路由 | `src/app.js` | `createApp()` | 注册 API、鉴权和错误处理 |
| 配置 | `src/config.js` | `loadConfig()` | 读取环境变量和默认值 |
| 存储 | `src/db.js` | `createDatabase()` | 初始化 SQLite schema 和迁移 |
| Python | `src/services/python-agent.js` | `PythonAgentBridge` | 管理 worker pool、超时和重启 |

## 3. 执行流程

```text
server.js -> config/db/services -> createApp -> HTTP router
                                      |-> Node service
                                      |-> PythonAgentBridge -> JSON Lines worker
```

## 4. 实现原理

服务按领域划分，但共享同一个 SQLite 连接和明确的服务接口。数据库开启 WAL 与外键。Python worker 使用有界队列，避免每个请求重新启动 Python；worker 崩溃后重建，连续启动失败会进入 unhealthy 状态并返回 503。

## 5. 不变量与失败行为

- API 错误通过稳定的 HTTP 状态和错误码返回。
- Python worker 不可用时，Agent 请求快速失败，不无限 respawn。
- 数据库事务失败不能推进 Master 版本。
- `/health` 描述进程、数据库和 worker 状态；它不等同于所有上游 Provider 健康。

## 6. 验证

```bash
npm test
npm run check
```

重点测试位于 `test/atlasgate.test.js`、`python/tests/test_engine.py` 和 `python/tests/test_ingest.py`。

