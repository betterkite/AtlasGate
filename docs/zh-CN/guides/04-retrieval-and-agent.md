# 检索与 Knowledge Agent

> ID: `RAG-001` / `AG-001`  
> 状态: `partial`

## 1. 目的与边界

Agent 从发布后的 Master 中检索证据，构造引用式回答，并可在显式开启时读写 session Memory、加载 Skills 和把回答保存为 Wiki Change。它不能把 pending Change 当成知识，也不能在无证据时假装知道答案。

## 2. 代码地图

| 层级 | 文件 | 符号或入口 | 职责 |
|---|---|---|---|
| Node | `src/services/agent.js` | `ask()` | 编排检索、模型、Memory、Skills 和审计 |
| bridge | `src/services/python-agent.js` | `prepare()` | 调用 Python worker |
| Python | `python/atlasgate_agent/engine.py` | `prepare_knowledge_run()` | 词法检索、RRF、引用和 fallback |
| 向量 | `src/services/semantic-index.js` | `search()`、`indexVersion()` | 本地向量或 Qdrant |
| HTTP | `src/app.js` | `/api/agents/knowledge/ask` | Agent API |

## 3. 检索流程

```text
question -> Master version 校验
  -> page lexical retrieval
  -> optional dense retrieval
  -> RRF / graph-degree rerank
  -> optional wikilink expansion
  -> citation prompt
  -> model or extractive fallback
  -> citation validation / run ledger
```

没有 embedding 服务时会退回本地词法路径。Qdrant 模式需要真实 embedding 和 Qdrant，不能把本地 feature hashing 称为语义 embedding。

## 4. Memory 与 Skills 边界

- `use_memory=false` 时既不读取也不写入 Memory。
- Memory 按 session 隔离，并支持过期、forget、supersede。
- 只有启用且 attach 的 Skill 才能进入 prompt。
- `save_to_wiki=true` 生成 `queries/<slug>.md` Change，不直接修改 Master。

## 5. 当前限制

真实模型、真实 embedding 和 Qdrant 的端到端质量不由离线 mock 测试证明；因此本功能保持 `partial`。本地 fallback 证明的是可解释的离线链路，不是模型回答质量。

## 6. 验证

```bash
node --test test/wiki-phase*.test.js
python -m unittest discover -s python/tests -v
```

详细行为见 [`docs/zh-CN/AGENT.md`](../AGENT.md) 和 [`docs/zh-CN/RAG_PLAN.md`](../RAG_PLAN.md)。
