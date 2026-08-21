# 测试报告

本文件记录最近一次测试证据，必须区分离线确定性测试、mock 测试和真实 Provider/Qdrant 验证。

## 当前证据

- Node 测试覆盖协议转换、路由、配额、版本治理、Wiki Phase、图谱布局、导出和同步。
- Python 测试覆盖中文分词、页面检索、Dense/Lexical 融合、多跳扩展、Prompt 构造、frontmatter 和 Lint 构造。
- 性能测试覆盖常驻 Python pool 和本地确定性工作负载。

## 当前限制

- 真实模型综合回答需要配置上游 Provider。
- 语义检索质量需要真实 Embedding 服务；Qdrant 模式还需要运行中的 Qdrant。
- 公网管理面需要当前进程之外的身份认证、TLS、CSRF 和网络控制。
- 扫描 PDF OCR 尚未实现。
- 当前环境可能只有 `python3`，完整 npm 脚本中的 `python` 调用需要显式修正。

## 报告要求

执行测试时记录日期、操作系统、Node/Python 版本、配置、命令、通过/失败/跳过数量、性能参数和剩余风险。失败输出不得包含密钥或原始敏感 Prompt。不要把 mock 或 fallback 行为报告为真实模型质量。

