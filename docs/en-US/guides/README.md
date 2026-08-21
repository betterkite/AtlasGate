# AtlasGate Developer Feature Guides

These guides explain how AtlasGate features are implemented. They are for developers who need to read, debug, or extend the code. They complement the user-facing documentation.

Each guide follows one business capability across its HTTP entry point, service, core algorithm, database or queue, output, and tests. A source file is not automatically a feature boundary.

Recommended reading order:

1. [System runtime](00-system-runtime.md)
2. [Gateway, protocols, and governance](01-gateway-and-governance.md)
3. [Knowledge versions and publication](02-knowledge-versioning.md)
4. [Document ingest and LLM Wiki compilation](03-wiki-ingest-and-compiler.md)
5. [Retrieval and Knowledge Agent](04-retrieval-and-agent.md)
6. [Graph, sync, and export](05-graph-sync-and-export.md)
7. [Console and MCP](06-console-and-mcp.md)
8. [Karpathy alignment](07-karpathy-alignment.md)

## Documentation contract

- `FEATURE_MATRIX.md` tracks features, code, APIs, tests, and status.
- Every `implemented` claim must have code and automated-test evidence.
- Link to source files and symbols instead of copying complete source files.
- Update the relevant guide when behavior, APIs, data models, or error semantics change.
- `partial`, `fallback`, and `planned` claims must state their trigger and user-visible behavior.

