# AtlasGate 从零复现指南

> 目标：让一个完全不了解本项目的人，**照抄命令就能跑起来**。以下命令全部在本仓库实测通过（复现时使用独立临时数据库，不影响你的现有数据）。

## 0. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **24+**（含 `node:sqlite`） | `node --version` 检查 |
| Python | **3.11 ~ 3.14** | Agent Core 与 PDF 解析用；启动时自动探测 `python`/`python3` |
| （可选）Docker | 任意较新版本 | 用容器方式运行 |

> 没有 `python` 命令只有 `python3`？无需处理，服务会自动探测。想显式指定：`ATLASGATE_PYTHON=python3 npm start`。

## 1. 获取代码与安装依赖

```bash
git clone <你的仓库地址> AtlasGate
cd AtlasGate
# 本项目无 npm 运行依赖，无需 npm install（package.json 仅声明脚本）
python -m pip install -r python/requirements.txt --target python/vendor   # 可选：PDF 解析依赖
```

## 2. 启动（开发模式）

```bash
npm start
# 输出应包含：
#   AtlasGate is running at http://127.0.0.1:4310
#   Development gateway key is enabled.
```

打开 **http://127.0.0.1:4310**，用开发默认账号登录：

| 入口 | 凭据 |
| --- | --- |
| 控制台 | `admin` / `atlasgate-admin` |
| 网关 API（`/v1/*`） | Bearer `atlasgate-dev-key` |

> ⚠️ 生产环境请设置 `ATLASGATE_DEV_MODE=false` 并提供 `ATLASGATE_ADMIN_USERNAME/PASSWORD`（见 docs/zh-CN/CONFIGURATION.md）。

## 3. 验证最小链路（建议新手按序执行）

以下命令用独立临时库实测通过；把 `PORT` 换成你的实际端口（默认 4310）：

```bash
# (a) 健康检查
curl http://127.0.0.1:4310/health

# (b) 登录并保存会话
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"atlasgate-admin"}'

# (c) 创建一个知识库（会自动同步系统页到 knowledge/<名称>/）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"入门知识库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# (d) 用网关调用一次（本地 mock 模型，验证 /v1 链路）
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'

# (e) 导入一段 Markdown 素材（进入待合并 Change）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","data_base64":"IyDlhaXpl7TlrqQKXG5cbuS4lueVjOaVtOebiueahOS4reWcqOaXoOazs+W8gOWPkeaDheWItuW6pu+8gQ==","author":"tester"}'

# (f) 合并发布为不可变 Master v2
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'

# (g) 查看磁盘上的 wiki md 镜像（发布后自动同步）
find knowledge/入门知识库 -name '*.md' | sort

# (h) 用知识 Agent 提问（本地抽取式回答，带证据）
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"AtlasGate 是什么？\"}"

# (i) 导出 Obsidian 兼容 zip
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head
```

预期结果：
- (d) 返回 `atlas-vision`/`atlas-mini` 模型响应；`x-atlas-routing-decision-id` 头存在
- (g) 能看到 `purpose.md`、`schema.md`、`index.md`、`log.md`、`overview.md`、`入门.md`
- (h) 返回"当前已发布的知识版本中没有找到足够相关的证据…"或基于素材的抽取式回答（本地模式不伪造推理）
- (i) zip 内是 Markdown 页面 + `.obsidian/app.json`

## 4. 跑测试

```bash
npm test          # Node + Python 全量（Node 71+ / Python 13）
npm run check     # 语法检查 + 测试门禁
```

## 5. 接入真实模型（可选，让 LLM 编译生效）

1. 控制台 →「模型网关」→ 添加 Provider：名称 `deepseek`、类型 `openai`、Base URL `https://api.deepseek.com`、API Key 填你的 DeepSeek key、模型如 `deepseek-chat`。
2. 保存后点「测试」确认健康，再点「余额」——**总览页的"上游 API Key 余额"会自动显示 DeepSeek 账户余额**（自动使用官方 `/user/balance` 端点）。
3. 此后在「知识版本 → 摄入队列」粘贴/上传素材，会走**两步 LLM 编译**（分析→生成），自动产出实体页/概念页/摘要页；`review` 模式下产物留在 Pending 待你审阅合并。
4. 想自动发布：创建知识库时 `ingest_mode: "auto"`，或在「Wiki 设置」里切换。

## 6. 常见问题速查

| 现象 | 处理 |
| --- | --- |
| `127.0.0.1:4310 is already in use` | 旧实例未退出：`lsof -i:4310` 找到 PID 后 `kill <pid>`，或换端口 `ATLASGATE_PORT=4311 npm start` |
| 页面打不开 / 卡死 | 检查 `data/server.log`；若为老版本升级，先删 `node_modules` 缓存并重启 |
| Agent 提问报 `python_agent_unavailable` | Python 未安装或版本不对；确认 `python3 --version` ≥ 3.11，或显式 `ATLASGATE_PYTHON=python3` |
| 找不到 wiki 的 md 文件 | 知识库页面在数据库里，磁盘镜像是 `knowledge/<知识库名>/`（见 docs/zh-CN/WIKI.md） |

## 7. 下一步

- [Usage 使用总览](USAGE.md) — 控制台 8 个视图怎么用
- [Gateway 网关知识](GATEWAY.md) — Provider/密钥/路由/余额
- [Wiki 知识库知识](WIKI.md) — LLM 编译、图谱、md 同步与导出
