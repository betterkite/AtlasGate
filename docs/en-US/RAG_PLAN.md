# Retrieval Plan

The current retrieval design has three phases:

| Phase | Goal | Technique |
|---|---|---|
| 1 | Semantic recall | Dense page vectors plus lexical retrieval fused with RRF |
| 2 | Precision | Graph-degree pseudo-rerank and one low-confidence query rewrite |
| 3 | Complex questions | WikiLink multi-hop expansion and explicit evidence sufficiency |

Local mode remains deterministic and offline. Hybrid mode requires an embedding endpoint and falls back to lexical retrieval when none is configured. Qdrant remains optional and version-scoped.

The retrieval unit for the current Agent path is a Wiki page. Legacy chunk retrieval remains available explicitly as `retrieval_mode=chunk`.

Acceptance requires round-trip vector indexing, lexical/dense RRF fusion, version isolation, correct fallback labels, query rewrite behavior, multi-hop expansion, and refusal when evidence is insufficient.

