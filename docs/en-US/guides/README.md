# AtlasGate Developer Feature Guides

This directory explains how AtlasGate features are implemented. It is for developers who need to read, debug, or extend the code. It complements, and does not replace, the user-facing [documentation index](../README.md).

## How to read

Each guide starts from one verifiable business capability and connects the following chain:

```text
user intent -> HTTP/internal entry -> service -> core algorithm -> database/queue -> output -> tests
```

Do not treat a single source file as a feature. A feature can span `src/app.js`, `src/services`, `src/core`, `python`, `web`, and `test`.

Recommended reading order:

1. [System runtime](00-system-runtime.md)
2. [Gateway, protocols, and governance](01-gateway-and-governance.md)
3. [Knowledge versions and publication](02-knowledge-versioning.md)
4. [Document ingest and LLM Wiki compilation](03-wiki-ingest-and-compiler.md)
5. [Retrieval and Knowledge Agent](04-retrieval-and-agent.md) — hybrid RRF retrieval, query rewriting, query sedimentation, query_hits heat, skills retrieval injection (ADR-015)
6. [Graph, sync, and export](05-graph-sync-and-export.md)
7. [Console and MCP](06-console-and-mcp.md)
8. [Karpathy alignment](07-karpathy-alignment.md)

## Documentation contract

- `FEATURE_MATRIX.md` is the tracking entry point for features, code, APIs, tests, and status.
- Every `implemented` claim must reference the implementation file and an automated test.
- The code map prefers file and symbol links; code snippets only explain key mechanisms, never copy complete source files.
- Update the relevant guide when behavior, APIs, data models, or error semantics change.
- The source of truth for the current implementation is the code and the tests; the guides, API docs, and architecture docs are the interpretation layer.
- Guides and the matrix must stay consistent with the current version baseline (version 0.4.0, tests Node 92 / Python 19, default port 4310).
- `partial`, `fallback`, and `planned` claims must state their trigger condition and user-observable behavior.

## Reproducing a feature from a guide

Every ID in the guides has an entry and tests in the matrix. For example, reproducing ADR-015 query sedimentation / citation heat / skills retrieval (corresponding to `AG-002` / `AG-003` / `AG-004`):

```bash
npm start   # default http://127.0.0.1:4310

# Log in, create a knowledge base, and ask a question (save_to_wiki=true sediments explicitly; a review-mode base leaves a pending Change)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Repro KB"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"

# The sedimented output is a queries/<slug>.md Change; graph nodes carry query_hits heat
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/graph" \
  | python3 -m json.tool | grep -E '"(path|query_hits)"' | head

# Focused tests (sedimentation / heat / skills retrieval)
node --test test/wiki-phase7.test.js test/wiki-phase8.test.js
```

## Grill questions before modifying

Before extending a feature, answer:

- Is this a new business capability, or a parameter change to an existing capability?
- Where are the entry point, state, data ownership, and publication boundary?
- Which invariants must always hold?
- What happens on upstream failure, duplicate requests, concurrent modifications, and process restart?
- Which automated test proves this behavior exists?
- Is this capability a product promise, or local mock/fallback only?
