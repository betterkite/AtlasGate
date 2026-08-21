# Reference Capability Matrix

This matrix records tested claims. Reference projects are signals, not promises of hosted-product parity.

| Capability | AtlasGate status | Boundary |
|---|---|---|
| OpenAI Chat Completions | Implemented | Buffered SSE; upstream behavior remains external |
| OpenAI Responses | Implemented | Supported envelope and conversion paths are tested |
| Anthropic Messages | Implemented | Supported envelope and conversion paths are tested |
| Embeddings | Implemented/partial | Depends on a configured compatible Provider |
| Governed routing | Implemented | Single-node control plane |
| Bounded failover | Implemented | Only retryable upstream errors advance candidates |
| Versioned knowledge Master | Implemented | SQLite, not distributed active/active |
| LLM Wiki compiler | Implemented/partial | Real Provider required for synthesis; mock path archives raw content |
| Hybrid retrieval | Partial | Dense quality requires a real embedding service |
| Qdrant backend | Partial | Optional deployment and versioned collection |
| Knowledge Agent | Partial | Local fallback is not synthesized reasoning |
| Public administrator plane | Missing | Requires SSO/RBAC/CSRF/TLS and network controls |
| OCR | Missing | Scanned PDFs require an external OCR stage |

Claims should be changed only with automated tests, documentation, and an explicit production boundary.

