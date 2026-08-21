# Architecture Decisions

| ID | Decision | Reason |
|---|---|---|
| ADR-001 | Modular monolith first | Preserve low-cost domain and publication experiments before service decomposition |
| ADR-002 | SQLite WAL | Transactions, portability, and a local Docker volume |
| ADR-003 | Stable Master plus isolated Changes | Atomic publication, auditability, and conflict evidence |
| ADR-004 | Persistent Python worker pool | Process isolation without per-request startup |
| ADR-005 | Named retrieval modes | Keep deterministic local vectors distinct from real semantic embeddings |
| ADR-006 | Uploaded Skill packages | Portable content packages without executing client archives |
| ADR-007 | Honest compatibility claims | Protocol compatibility is tested without claiming hosted-product parity |
| ADR-008 | LLM Wiki three-layer model | Raw Sources -> Wiki -> Schema with versioned system pages |
| ADR-009 | Wiki writes use the audit chain | Compiler output becomes a Change, never a direct Master write |
| ADR-010 | Pure-JS graph enhancements | Preserve the zero-runtime-dependency principle |
| ADR-011 | Bounded Python respawn | Fail fast and stop descriptor leaks when Python cannot start |
| ADR-012 | Hybrid retrieval with RRF | Combine lexical precision and dense paraphrase matches |
| ADR-013 | Structural rerank and query rewrite | Improve precision without introducing heavy dependencies |
| ADR-014 | WikiLink multi-hop and evidence sufficiency | Expand linked evidence and refuse unsupported answers |

Each decision has an explicit production boundary. Later changes should add a new ADR or update the affected decision with migration and test impact.

