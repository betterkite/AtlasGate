# 控制台与运维（Console & Ops）使用知识

本文覆盖控制台使用之外的日常运维：备份、升级、日志、常见故障排查。对应视图 01/07 与 `data/` 目录。

## 1. 数据都在哪

| 路径 | 内容 | 是否提交 git |
| --- | --- | --- |
| `data/atlasgate.db`（+ wal/shm） | 主数据库：网关配置、**知识库页面**、审计账本、密钥、Skills | 否（.gitignore） |
| `data/backups/` | wiki 模型升级等迁移前自动备份 | 否 |
| `data/server.log` | 服务运行日志（启动时 `nohup node src/server.js > data/server.log 2>&1`） | 否 |
| `knowledge/` | 每个知识库的 md 镜像（Obsidian 可打开，只读） | 否（默认） |
| `docs/` | 文档与测试报告 | 是 |

## 2. 备份与恢复

```bash
# 停机备份（推荐）
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db
# 热备份（WAL 模式，先 checkpoint）
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/atlasgate.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db
```

恢复：停服务 → 用备份文件替换 `data/atlasgate.db`（同时删掉 `-wal`/`-shm`）→ 启动。

## 3. 升级

1. 备份数据库（见上）。
2. `git pull` 更新代码。
3. 重启。迁移是**追加式、幂等**：启动时自动 `ALTER TABLE` 加列、补系统页（存量库以 pending Change 播种）、更新 md 镜像。
4. 查看启动日志确认：`Wiki model: staged …` / `Wiki md mirror: synced …`。

## 4. 密钥与安全运维

- 客户端密钥：签发/撤销/恢复/移除都在「模型网关」；移除后审计保留。
- 管理员：`ATLASGATE_ADMIN_USERNAME/PASSWORD` 配置；控制台只适合 `127.0.0.1` 回环（外网部署需先加 TLS/身份系统，见 docs/zh-CN/SECURITY.md）。
- 上游 Key：存在 Provider 表/凭据表，控制台只返回 `has_api_key`；生产建议外部 Secret Manager。

## 5. 常见故障排查

| 现象 | 原因与处理 |
| --- | --- |
| **启动报 `already in use`** | 端口被占：`lsof -i:4310` → `kill <pid>`；或 `ATLASGATE_PORT=4311 npm start` |
| **服务卡死 / 页面进不去** | 老版本"python 缺失无限重生成"已修复（有界退避）。仍卡：看 `data/server.log`；`ss -tlnp | grep 4310` 确认进程；必要时重启 |
| **Agent 报 `python_agent_unavailable`** | Python 缺失/过旧：`python3 --version` ≥3.11；或 `ATLASGATE_PYTHON=python3 npm start`；池会自动进入 unhealthy 并快速失败（不再泄漏 FD） |
| **余额显示未配置** | Provider 无余额端点且非 deepseek；或未点过「余额」；DeepSeek 自动识别后刷新即可 |
| **图谱空白/按钮无反应** | 硬刷新（Ctrl+F5）加载新前端；仍异常则看 F12 Console 报错 |
| **导入后卡死** | 本版本已修复 python 重生成循环；若复现，贴 `data/server.log` |
| **md 镜像没更新** | 检查 `knowledge/` 是否被 gitignore 误解（它本来就该忽略）；同步时机：发布/启动/手动「同步 md」 |

## 6. 监控入口

- 「运行总览」：上游余额 + 请求/Token 曲线（悬停看值）。
- 「审计证据」：逐请求的密钥归属、路由决策、风险。
- 「模型网关」：Provider 健康、尝试记录（provider-attempts）。
- 日志：`data/server.log`（启动/迁移/镜像同步/队列失败都打在这里）。

## 7. 相关文档

- [DEPLOYMENT.md](DEPLOYMENT.md)（Docker/Compose、持久卷）
- [CONFIGURATION.md](CONFIGURATION.md)（全部环境变量）
- [SECURITY.md](SECURITY.md)（安全边界与加固清单）
- [OPERATIONS.md](OPERATIONS.md)（日常操作补充）
