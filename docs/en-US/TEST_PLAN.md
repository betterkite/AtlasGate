# Test Plan

## Purpose

Verify that AtlasGate behaves as a governed LLM gateway and versioned knowledge-agent platform, not merely that the process starts.

## Release claims

The release claims OpenAI Chat/Responses/Embeddings, Anthropic Messages, routing and bounded failover, usage governance, MD/TXT/text-PDF ingest, immutable knowledge versions, versioned graph, Knowledge Agent, Memory, Skills, local retrieval, optional embeddings/Qdrant, console, Docker, and operations documentation.

It does not claim multi-node high availability, public-internet administrator security, transparent upstream streaming, OCR, or hosted reference-product parity.

## Required test groups

| Group | Coverage |
|---|---|
| Functional | Gateway governance, failover, provider lifecycle, knowledge merge, conflicts, imports, graph, Agent, Memory, Skills, retrieval |
| API | OpenAI and Anthropic envelopes, SSE, errors, request IDs, health/readiness, MCP |
| Performance | Gateway latency, retrieval, worker reuse, queue saturation, crash recovery, shutdown, import bounds |
| Security | Secret isolation, risk blocking, scope/allowlist, package validation, path safety |
| Interaction | Console tabs, imports, graph, review, balance refresh, secret display |

## Commands

```bash
npm run test:node
python3 -m unittest discover -s python/tests -v
npm run test:performance
```

The Python command should be changed to `python3` or an environment-aware runner on systems without a `python` alias.

