# 控制台与运维（Console & Ops）使用知识

> 版本基线：**0.4.0**（测试 Node 92 / Python 19；零 npm 运行依赖）。本文覆盖控制台使用之外的日常运维：备份、升级、日志、常见故障排查。对应视图 01（运行总览）/ 07（审计证据）与 `data/` 目录。控制台 8 个视图的导览见 [USAGE.md](USAGE.md)。

## 1. 数据都在哪

| 路径 | 内容 | 是否提交 git |
| --- | --- | --- |
| `data/atlasgate.db`（+ wal/shm） | 主数据库（SQLite WAL）：网关配置、**知识库页面**（版本化）、审计账本、密钥、Skills、Memory、`semantic_vectors` 稠密向量、`wiki_query_hits` 引用热度 | 否（.gitignore） |
| `data/backups/` | wiki 模型升级等迁移前自动备份 | 否 |
| `data/server.log` | 服务运行日志（启动时 `nohup node src/server.js > data/server.log 2>&1`；Docker 下看 `docker compose logs`） | 否 |
| `knowledge/` | 每个知识库的 md 镜像（Obsidian 可打开，单向只读，删除由 `.atlasgate-manifest.json` 跟踪） | 否（默认） |
| `python/vendor/` | pip 安装的运行时依赖（`pypdf` 等；`onnxruntime` 为 embedding 可选依赖） | 否 |
| `docs/` | 文档与测试报告 | 是 |

## 2. 备份与恢复

```bash
# 停机备份（推荐）
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db

# 热备份（WAL 模式，先 checkpoint 再复制，避免复制半成品页）
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/atlasgate.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
cp data/atlasgate.db data/backups/atlasgate-$(date +%F-%H%M).db
```

恢复：停服务 → 用备份文件替换 `data/atlasgate.db`（同时删掉 `-wal`/`-shm`，避免旧 WAL 覆盖新库）→ 启动：

```bash
# 假设备份为 data/backups/atlasgate-2026-01-01-0000.db
pkill -f "node src/server.js" || true   # 1) 先停掉运行中的实例
cp data/backups/atlasgate-2026-01-01-0000.db data/atlasgate.db   # 2) 恢复库
rm -f data/atlasgate.db-wal data/atlasgate.db-shm                # 3) 删旧 WAL/shm，避免覆盖
npm start                                                         # 4) 重启
curl http://127.0.0.1:4310/health                                 # 5) 确认 database:"ready"
```

## 3. 升级

1. 备份数据库（见上）。
2. `git pull` 更新代码。
3. 重启。迁移是**追加式、幂等**：启动时自动 `ALTER TABLE` 加列、补系统页（存量库以 pending Change 播种）、更新 md 镜像。
4. 查看启动日志确认：`Wiki model: staged …` / `Wiki md mirror: synced …`。

```bash
cd /home/zengcccc/projects/AtlasGate   # 换成你的项目路径
git pull
npm start
# 启动日志应出现：
#   AtlasGate is running at http://127.0.0.1:4310
#   Wiki model: staged N system page change(s) for legacy knowledge bases（如有存量库）
#   Wiki md mirror: synced N knowledge base(s), M file(s) -> knowledge/
```

## 4. 密钥与安全运维

- 客户端密钥：签发/撤销/恢复/移除都在「模型网关」；移除后审计保留。
- 管理员：`ATLASGATE_ADMIN_USERNAME/PASSWORD` 配置；控制台只适合 `127.0.0.1` 回环（外网部署需先加 TLS/身份系统，见 docs/zh-CN/SECURITY.md）。
- 上游 Key：存在 Provider 表/凭据表，控制台只返回 `has_api_key`；生产建议外部 Secret Manager。
- 开发网关 key `atlasgate-dev-key` 只在 `ATLASGATE_DEV_MODE=true` 时自动播种；生产必须 `ATLASGATE_DEV_MODE=false` 并自己签发客户端密钥。

```bash
# 管理员改密（新密码至少 12 字符；成功后其它会话全部失效）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"current_password":"atlasgate-admin","new_password":"a-strong-new-password-2026"}'
```

## 5. 常见故障排查

| 现象 | 原因与处理 |
| --- | --- |
| **启动报 `already in use`** | 端口被占：`lsof -i:4310` 或 `ss -tlnp \| grep 4310` → `kill <pid>`；或 `ATLASGATE_PORT=4311 npm start` |
| **服务卡死 / 页面进不去** | 老版本"python 缺失无限重生成"已修复（有界退避 + 池 unhealthy 快速失败）。仍卡：看 `data/server.log`；`curl http://127.0.0.1:4310/health` 看 `python_pool` 状态；必要时重启 |
| **Agent 报 `python_agent_unavailable`** | Python 缺失/过旧：`python3 --version` ≥3.11；或 `ATLASGATE_PYTHON=python3 npm start`；池会自动进入 unhealthy 并快速失败（不再泄漏 FD） |
| **检索退化成纯词法** | `/health` 里 `retrieval.enabled` 为 false：未配置 `ATLASGATE_EMBEDDING_BASE_URL`（hybrid 自动降级，属预期）；qdrant 模式还需 `ATLASGATE_QDRANT_URL`。配置后可 `POST /api/knowledge-bases/:id/semantic-index` 重建索引 |
| **余额显示未配置** | Provider 无余额端点且非 deepseek；或未点过「余额」；DeepSeek 自动识别（`/user/balance`）后刷新即可 |
| **图谱空白/按钮无反应** | 硬刷新（Ctrl+F5）加载新前端；仍异常则看 F12 Console 报错 |
| **导入后卡死** | 本版本已修复 python 重生成循环；若复现，贴 `data/server.log` |
| **md 镜像没更新** | 检查 `knowledge/` 是否被 gitignore 误解（它本来就该忽略）；同步时机：发布/启动/手动「同步 md」`POST /api/knowledge-bases/:id/sync` |

## 6. 监控入口与视图 API 示例

「运行总览」「审计证据」「模型网关」三个视图背后就是这几个 API，照抄可跑（先登录见第 4 节或 USAGE.md 第 0 步）：

```bash
# 健康检查：版本、数据库、Python 池（state/queued/rejected/restarts）、检索（mode/backend/enabled）
curl http://127.0.0.1:4310/health

# 运行总览（视图 01）：请求/Token 曲线、花费估算、成功率、延迟、Provider 健康、上游余额；range=24h|7d|30d
curl -b cookies.txt "http://127.0.0.1:4310/api/overview?range=7d"

# 用量细分（按密钥/模型等维度）
curl -b cookies.txt "http://127.0.0.1:4310/api/usage/breakdown"

# 审计证据（视图 07）：最近请求账本（每条含调用方密钥、路由决策、用量、风险）
curl -b cookies.txt "http://127.0.0.1:4310/api/logs?limit=20"

# 模型网关（视图 04）：Provider 尝试记录（attempt 留痕）
curl -b cookies.txt "http://127.0.0.1:4310/api/provider-attempts?limit=20"

# 客户端密钥清单
curl -b cookies.txt "http://127.0.0.1:4310/api/keys"
```

- 日志：`data/server.log`（启动/迁移/镜像同步/队列失败都打在这里）。

## 7. 相关文档

- [DEPLOYMENT.md](DEPLOYMENT.md)（Docker/Compose、持久卷）
- [CONFIGURATION.md](CONFIGURATION.md)（全部环境变量）
- [SECURITY.md](SECURITY.md)（安全边界与加固清单）
- [OPERATIONS.md](OPERATIONS.md)（日常操作补充）
- [guides/06-console-and-mcp.md](guides/06-console-and-mcp.md)（控制台 8 视图操作步骤与 MCP 调用）
