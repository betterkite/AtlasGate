# Test Report

This file records the latest verified test evidence. It must distinguish offline deterministic coverage from real Provider or Qdrant validation.

## Current evidence

- Node unit and integration tests cover protocol conversion, routing, quotas, version governance, Wiki phases, graph layout, export, and synchronization.
- Python tests cover tokenization, page retrieval, dense/lexical fusion, multi-hop expansion, prompt preparation, frontmatter, and Lint preparation.
- Performance tests cover the persistent Python pool and deterministic local workloads.

## Known release boundaries

- Real model synthesis requires a configured upstream Provider.
- Semantic retrieval quality requires a real embedding service and, for Qdrant mode, a running Qdrant instance.
- Public administration requires controls outside the current process.
- Scanned PDF OCR is not implemented.

Run the commands in [TEST_PLAN.md](TEST_PLAN.md) and record runtime, platform, configuration, and failures here. Do not report mock or fallback behavior as real-model quality.

