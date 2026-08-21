# 知识版本、Change 与 Master 发布

> ID: `KB-001`  
> 状态: `implemented`（版本 0.4.0）

## 1. 目的与边界

知识库把多人修改、导入、LLM 生成和删除统一成 pending Change（LLM 编译批次共享 `batch_id`），再发布为不可变 Master 版本。这样 Agent 不会读取半完成的编辑，也可以追溯每次发布的作者、冲突（冲突账本）和删除（tombstone）。历史版本不可变，可独立检索、回看。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| HTTP | `src/app.js` | `/changes`、`/changes/:changeId`（PATCH/DELETE）、`/merge`、`/versions`、`/versions/:version`、`/documents?version=`、`/document?path=&version=`、`/graph?version=`、`/conflicts` | 版本管理 API |
| 服务 | `src/services/knowledge.js` | `submitChange()`、`updateChange()`、`merge()`、`listVersions()`、`listConflicts()` | 修改、冲突和发布规则 |
| 存储 | `src/db.js` | `knowledge_changes`、`knowledge_change_revisions`、`knowledge_versions`、`knowledge_documents`、`knowledge_conflicts`、`knowledge_tombstones` | 版本化数据与审计账本 |
| 派生物 | `src/services/knowledge.js` | chunks、graph rebuild（5 信号相关边） | 检索和关系图 |
| 测试 | `test/wiki-phase*.test.js` | Wiki phase tests | 行为证据 |

## 3. 发布流程

```text
编辑/导入/编译（LLM 批次共享 batch_id）
  -> knowledge_changes(status=pending, revision=1)
  -> expected_revision 校验（乐观并发）
  -> BEGIN IMMEDIATE
  -> 复制当前 Master 到 vN+1
  -> 按 created_at,rowid 应用 Change
  -> 冲突检测（stale_base_version / concurrent_path_update）→ 写入冲突账本
  -> delete Change → tombstone
  -> 重建 chunks 与 graph（含 5 信号相关边）
  -> 更新 master_version
  -> COMMIT
```

## 4. 核心不变量

- Agent 只读取 `master_version`。
- pending Change 不会出现在生产检索中。
- 发布者只能看到完整旧版本或完整新版本（原子事务）。
- 已合并 Change 和历史 Version 不可变。
- 同一路径冲突采用明确的 latest-submitted-wins，并写入冲突账本（`knowledge_conflicts`）。
- 删除通过 delete Change 和 tombstone（`knowledge_tombstones`）发布，而不是直接删除线上内容。
- 历史版本可独立检索：`/documents?version=`、`/document?path=&version=`、`/versions/:version`、`/graph?version=`。

## 5. 扩展边界

高风险领域不应直接复用 latest-wins；应在 Change 上增加 reviewer/approval 状态，或注入领域级 merge function。迁移数据库时必须保留版本、冲突和审计证据。

## 6. 验证

```bash
npm test    # 全量：Node 92 + Python 19，零 npm 运行依赖
node --test test/wiki-phase0.test.js test/wiki-phase2.test.js test/wiki-phase3.test.js   # 版本治理相关用例
```

## 7. 端到端复现（导入 → pending → 合并 → 版本列表）

默认开发配置实测通过（`npm start`，控制台 http://127.0.0.1:4310，admin / atlasgate-admin）。管理端 `/api/*` 用 cookie 会话：

```bash
# 1) 登录（cookie 会话）
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) 建库（ingest_mode=review：产物留 pending 等人工审阅）
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"版本演示库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) 导入文档 → 生成 pending Change（不直接污染 Master）
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","author":"tester","data_base64":"IyDmnq/kupXlupXnn7Plo4EKCuWQkemhtuWkqeWcqOaer+S6leW6leWPkeeOsOWNiuWdl+efs+Wjge+8jOS4iumdouWIu+edgOaooeeziueahOe6uei3r+OAgui/meaYr+acrOefpeivhuW6k+eahOesrOS4gOS7vee0oOadkOOAggoKLSDlhbPplK7or43vvJrnn7Plo4HjgIHmnq/kupXjgIHnurnot68KLSDlvZLlsZ7vvJrmtYvor5XntKDmnZA="}'

# 4) 查看 pending（status=pending，含 revision / batch_id）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -m json.tool

# 5) 发布合并 → 返回新版本号与冲突数
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'
# → {"kb_id":"...","version":2,"parent_version":1,"change_count":1,"conflict_count":0}

# 6) 看版本列表（不可变版本历史）
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions" \
  | python3 -m json.tool
```

冲突账本与 tombstone 演示（同一路径两个 upsert 后合并；删除走 delete Change）：

```bash
# 同一路径两个 upsert → 合并时记 concurrent_path_update，latest-submitted-wins
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"alice","content":"# 修订 A\n\nAlice 的版本。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"bob","content":"# 修订 B\n\nBob 后提交。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"并发提交合并"}'   # conflict_count=1

curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts" \
  | python3 -m json.tool   # 冲突账本：earlier/winning change、reason、resolution

# 删除走 delete Change + tombstone，版本检索仍可回看历史
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"delete","author":"tester"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"删除入门.md"}'
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=入门.md" --data-urlencode "version=2"   # v2 仍可读到
```

网关 `/v1/*` 用 Bearer key（`atlasgate-dev-key`）：

```bash
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

完整使用说明见 [`docs/zh-CN/KNOWLEDGE.md`](../KNOWLEDGE.md)。
