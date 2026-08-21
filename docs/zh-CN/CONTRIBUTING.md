# 贡献指南

## 开发约定

使用 Node.js 24 和 Python 3.11 或更高版本（项目零 npm 运行依赖，`package.json` 仅声明脚本）。保持协议转换、模型路由、知识治理（Change→merge→不可变 Master、ADR-015 问答沉淀/技能检索）、Agent Runtime 和 LLM Wiki 编译管线的现有边界。没有自动化测试和明确生产边界，不要向 `REFERENCE_MATRIX.md` 添加新的能力声明。

当前测试基线：**Node 92 项 / Python 19 项**（`npm test` 全量通过，见 [TEST_REPORT.md](TEST_REPORT.md)）。新增或修改功能时，测试数量应随之更新并在 PR 中说明。

## 工作流程

1. 先说明业务规则和变更范围（是否涉及 ADR-015 的记忆/沉淀/技能链路）。
2. 修改验收声明前，先添加或更新测试。
3. 根据当前环境使用 `npm run test:node` 和 `python3 -m unittest discover -s python/tests -v`。
4. 容器变更需要运行 `docker compose config`、构建镜像并执行部署冒烟流程。
5. 行为变化时同步更新 API、配置、运维以及中英文文档。

不要提交 `.env`、数据库、Provider 密钥或请求数据。

## 可复现的验证流程

改动后至少完成一次全量门禁与一次运行冒烟（默认端口 4310、默认凭据）：

```bash
# 1) 全量门禁：Node 语法检查 + Node 测试 + Python 测试
npm run check          # 期望 Node 92 项、Python 19 项全部通过

# 2) 启动冒烟：另开终端执行
npm start
# 3) 健康检查与登录（管理端 API 一律先登录拿 cookie）
curl http://127.0.0.1:4310/health
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/overview
```

聚焦某个功能块时，可以只跑对应测试文件（例如 ADR-015 沉淀/热度/技能检索）：

```bash
node --test test/wiki-phase7.test.js test/wiki-phase8.test.js
```

## 代码约定

- 优先使用 ESM 和 Node.js 标准库。
- Python 输入输出保持 JSON 可序列化和 UTF-8。
- 保留 Master、版本和审计证据；修改必须创建受治理的 Change。
- 通过 `HttpError` 返回稳定错误码。
- 对队列、上传、重试、超时和结果数量设置上限。


