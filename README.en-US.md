# AtlasGate

AtlasGate is local LLM infrastructure for small engineering teams: a multi-protocol OpenAI/Anthropic API gateway, a version-governed LLM Wiki, a knowledge graph, and an evidence-first knowledge agent.

- The design is informed by [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), `llm-wiki-skill`, and `llm_wiki`; the implementation is independent.
- See the [reference capability matrix](docs/en-US/REFERENCE_MATRIX.md) and [architecture decisions](docs/en-US/DECISIONS.md).

## Capabilities

| Component | Implemented capabilities |
| --- | --- |
| API gateway | Chat Completions, Responses, Anthropic Messages, Embeddings, SSE, model listing, and token counting |
| Smart routing | Vision capability filtering, quality/cost/latency/reliability scoring, credential pools, cooldowns, bounded failover, and per-attempt evidence |
| Usage governance | Client-key scopes, model allowlists, RPM/TPM limits, token quotas, monthly budgets, revocation, and retained audit history |
| Knowledge versions | Multi-user Changes, atomic Master publication, optimistic concurrency, conflict ledger, tombstones, and versioned retrieval |
| LLM Wiki compiler | Two-step analysis/generation, persistent ingest queue, SHA256 deduplication, batch review, Lint, and source traceability |
| Knowledge graph | Force-directed layout, communities, weighted relations, search, dragging, hover details, and minimap |
| Knowledge agent | Evidence retrieval, citations, local extractive fallback, opt-in Memory and Skills, and `save_to_wiki` |
| Console | A build-free native web console with eight operational views |

## Quick start

Requirements: Node.js 24+ and Python 3.11+. The application probes `python` and `python3` automatically.

```bash
npm start
```

Open `http://127.0.0.1:4310`. Development defaults are console `admin / atlasgate-admin` and gateway key `atlasgate-dev-key`.

The built-in `atlas-mini` provider validates the full local path without a real upstream model. Configure an OpenAI-compatible Provider to enable real routing and LLM compilation.

## Documentation

Start with the [English documentation index](docs/en-US/README.md). The Chinese edition is at [docs/zh-CN/README.md](docs/zh-CN/README.md).

## Storage and boundaries

Knowledge pages are versioned in SQLite at `data/atlasgate.db`. The `knowledge/<id>/` directory is a read-only Markdown mirror generated after publication; ZIP export is available from the console.

AtlasGate is a single-node modular monolith. The console is intended for loopback or a trusted private network. Public deployment requires an authenticated administrator plane, TLS, egress controls, and application-level secret protection.

## Tests

```bash
npm test
npm run check
```

See the [English test plan](docs/en-US/TEST_PLAN.md) and [test report](docs/en-US/TEST_REPORT.md).

## License

MIT

