# Test Report

This file records the most recent test evidence and must distinguish offline deterministic tests, mocks, and real Provider or Qdrant validation.

## Current evidence (version 0.4.0)

- Node **92** tests all pass (`test/` 13 files: `atlasgate`, `frontmatter`, `graph-layout`, `wiki-phase0~8`, `wiki-sync`, plus the `performance.bench` benchmark). They cover protocol conversion, routing, quotas, version governance, and all LLM Wiki stages (wiki-phase0~8):
  - phase0: five system pages installed, `ingest_mode` defaults and validation, schema/purpose co-authorship, legacy-base upgrade, system pages excluded from retrieval by default;
  - phase1: two-step compilation (analysis→generation), degraded pages with auto-mode auto-merge, SHA256 dedupe, validation, task crash recovery, `force:true` re-ingest;
  - phase2: structural Lint after publish, report lifecycle, one-click page creation, `queries/` sedimentation and `save_to_wiki`;
  - phase3: Louvain communities, 5-signal related edges, graph insights, lazy rebuild of legacy versions;
  - phase4: ZIP export (UTF-8, explicit version), research-jobs;
  - phase5: RAG 1 — hybrid RRF fusion, `semantic_vectors` page-level index, auto-degrade without embeddings;
  - phase6: RAG 2 — graph-degree pseudo-rerank, zero-evidence query rewrite;
  - phase7: ADR-015 A — explicit/auto sedimentation, smart categorization, quality gates, audit chain;
  - phase8: ADR-015 B/C — graph `query_hits` citation heat, skill `retrieval` declaration injection.
- Python **19** tests all pass (`python/tests/` 4 files: `test_engine`, `test_frontmatter`, `test_ingest`, `test_lint`), covering Chinese tokenization/bigram, page retrieval, Dense/Lexical RRF fusion, multi-hop expansion, prompt construction (two-step STAGE markers), frontmatter, and Lint construction.
- Performance tests cover the persistent Python pool and deterministic local workloads (mock-gateway 1000 requests at concurrency 20 with a p95 upper-bound assertion).

## Current limitations

- Real-model synthesis answers require a configured upstream Provider (e.g., DeepSeek); without one the Agent uses the local extractive fallback, which must not be reported as model quality.
- Semantic retrieval quality requires a real embedding service: local ONNX `bge-small-zh` (`python/atlasgate_agent/embedding_worker.py`) or any OpenAI-compatible `/v1/embeddings` (`ATLASGATE_EMBEDDING_BASE_URL`); without one, hybrid automatically degrades to pure lexical. Qdrant mode additionally requires a running Qdrant instance.
- The public admin plane requires identity authentication, TLS, CSRF, and network controls outside the current process.
- Scanned PDF OCR is not implemented.
- The current environment may only have `python3`; the `python` calls in the full npm scripts need explicit correction (the runtime service auto-detects `python`/`python3`, the npm scripts do not).

## Report requirements

When running tests, record the date, OS, Node/Python versions, configuration, commands, pass/fail/skip counts, performance parameters, and remaining risks. Failure output must not contain secrets or raw sensitive prompts. Do not report mock or fallback behavior as real-model quality.

## Reproducible examples

### Full suite

```bash
npm test          # Node 92 + Python 19
```

### Step-by-step and smoke

```bash
npm run test:node
python3 -m unittest discover -s python/tests -v
npm run test:performance

# Smoke: admin cookie login -> gateway Bearer
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/overview
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```
