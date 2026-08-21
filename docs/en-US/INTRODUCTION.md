# Introduction

## Positioning

AtlasGate is local LLM infrastructure for small engineering teams: a multi-protocol API gateway, a version-governed LLM Wiki, a knowledge graph, and an evidence-first knowledge Agent.

## Problems addressed

- One governed entry point for multiple model Providers, with routing, limits, budgets, and audit.
- Persistent knowledge compilation instead of re-reading raw documents from scratch on every query.
- Local, inspectable, and offline-capable operation with SQLite and a Python Agent core.

## Three components

```text
Business system / Agent / MCP
  -> protocol gateway -> auth -> limits -> capability checks -> routing -> Provider
  -> usage, routing, and risk audit

Sources -> Changes -> Master version -> retrieval and graph
  -> two-step LLM Wiki compiler -> entities, concepts, summaries, index, and log

Master evidence -> Python Agent -> cited answer
  -> optional Memory / Skills -> optional Wiki Change
```

## Design principles

| Principle | Implementation |
|---|---|
| Database as source, disk as mirror | Versioned SQLite documents; `knowledge/` is a read-only Markdown mirror |
| Every LLM write is governed | Compiler output becomes a Change and never writes Master directly |
| Credentials are separated | Client API key, administrator session, and upstream Provider key have different roles |
| Offline verification | The local mock Provider and extractive fallback validate the local path |

See [Architecture](ARCHITECTURE.md), [Security](SECURITY.md), and the [developer feature guides](guides/README.md).

