# 贡献指南

## 开发约定

使用 Node.js 24 和 Python 3.11 或更高版本。保持协议转换、模型路由、知识治理和 Agent Runtime 的现有边界。没有自动化测试和明确生产边界，不要向 `REFERENCE_MATRIX.md` 添加新的能力声明。

## 工作流程

1. 先说明业务规则和变更范围。
2. 修改验收声明前，先添加或更新测试。
3. 根据当前环境使用 `npm run test:node` 和 `python3 -m unittest discover -s python/tests -v`。
4. 容器变更需要运行 `docker compose config`、构建镜像并执行部署冒烟流程。
5. 行为变化时同步更新 API、配置、运维以及中英文文档。

不要提交 `.env`、数据库、Provider 密钥或请求数据。

## 代码约定

- 优先使用 ESM 和 Node.js 标准库。
- Python 输入输出保持 JSON 可序列化和 UTF-8。
- 保留 Master、版本和审计证据；修改必须创建受治理的 Change。
- 通过 `HttpError` 返回稳定错误码。
- 对队列、上传、重试、超时和结果数量设置上限。

