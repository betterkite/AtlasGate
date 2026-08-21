# 数据目录（运行时产物）

本目录存放运行时生成的数据，**不要提交到 git**（已在 .gitignore 中排除）：

- `atlasgate.db` / `-wal` / `-shm`：SQLite 主数据库。**知识库的 Wiki 页面就存在这里**（`knowledge_documents` 表），不在磁盘 md 文件中。
- `backups/`：wiki 模型升级等迁移前的自动备份。
- `server.log`：服务运行日志。

想要磁盘上的 Markdown 副本？服务启动后会自动把每个知识库的 Master 页面镜像到项目根目录 `knowledge/<知识库名>/`（Obsidian 可直接打开）；也可以在控制台「Wiki 知识库」视图点「同步 md」或「导出 zip」。详见 [中文 Wiki 文档](../docs/zh-CN/WIKI.md)。
