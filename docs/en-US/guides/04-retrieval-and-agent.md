# Retrieval and Knowledge Agent

> IDs: `RAG-001`, `AG-001`  
> Status: `partial`

## Purpose and boundary

The Agent retrieves evidence from the published Master, produces cited answers, and can explicitly opt in to session Memory, Skills, or saving an answer as a Wiki Change. It must not use pending Changes or claim knowledge without evidence.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| Node orchestration | `src/services/agent.js` | `ask()` | Retrieval, model, Memory, Skills, and audit |
| Bridge | `src/services/python-agent.js` | `prepare()` | Python worker calls |
| Python core | `python/atlasgate_agent/engine.py` | `prepare_knowledge_run()` | Lexical retrieval, RRF, citations, fallback |
| Dense index | `src/services/semantic-index.js` | `search()`, `indexVersion()` | Local vectors or Qdrant |
| HTTP | `src/app.js` | `/api/agents/knowledge/ask` | Agent endpoint |

## Retrieval flow

```text
question -> Master-version check -> lexical retrieval
  -> optional dense retrieval -> RRF/graph rerank
  -> optional WikiLink expansion -> citation prompt
  -> model or extractive fallback -> citation validation and run ledger
```

Without an embedding service, retrieval falls back to the local lexical path. Local feature hashing must not be described as semantic embedding.

Memory is read and written only when `use_memory=true`; only enabled attached Skills enter the prompt; `save_to_wiki=true` creates a Change rather than editing Master directly.

Real-model, real-embedding, and Qdrant quality are not proven by offline mock tests, so this feature remains `partial`.

