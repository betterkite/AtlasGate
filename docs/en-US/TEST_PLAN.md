# Test Plan

Status: basic test plan (version 0.4.0). The goal is to verify AtlasGate behaves as a governed LLM gateway and versioned knowledge-agent platform, not merely that the process starts. Current evidence: **Node 92 + Python 19**, covering all wiki-phase0~8 stages (LLM Wiki compilation, RAG hybrid retrieval, ADR-015 Q&A sedimentation / graph heat / skill retrieval).

## 1. Release scope

This version claims:

- OpenAI Chat Completions, Responses, Embeddings, and Anthropic Messages compatible interfaces, plus SSE streaming output and model lists for all three envelopes.
- Provider, model, credential pool, routing, balance, bounded failover, and usage governance.
- MD, TXT, and text-PDF import, plus Change, Master, conflicts, deletion tombstones, and historical versions; per-KB `ingest_mode` (`review` default / `auto`) and batch review (`batch_id`).
- LLM Wiki: two-step compilation (analysis→generation), SHA256 dedupe with `force:true` forced re-ingest, degraded pages (`atlasgate-degraded`, excluded from retrieval by default), structural auto-Lint + LLM-level manual Lint, `index.md`/`log.md`/`overview.md` system pages (compiler-maintained, `purpose`/`schema` human co-authored), one-way md mirror sync (Obsidian-ready, gitignored), and ZIP export.
- Hybrid retrieval (hybrid default): lexical bigram page-level + local dense vectors (`semantic_vectors` table, SQLite cosine) fused via RRF, pseudo-rerank (graph degree), zero-evidence query rewrite, wikilink multi-hop expansion, and evidence sufficiency constraints; auto-degrades to pure lexical when no embedding is configured; optional qdrant backend.
- Q&A sedimentation and skill retrieval strategy (ADR-015): explicit `save_to_wiki`/`sediment`, or similar question ≥3 times + quality rules auto-sediments; artifacts go through the Change audit chain and follow `ingest_mode`; graph node `query_hits` citation heat (30-day window); SKILL.md `retrieval` field injected into retrieval after attach.
- Knowledge Agent, Memory, Skills, Python worker pool, local retrieval, and optional Qdrant.
- Admin console, Docker image, and MCP JSON-RPC.

Not claimed: multi-node high availability, public-internet administrator security, transparent upstream token streaming, scanned-PDF OCR, full payment subscription, and functional parity with reference products.

## 2. Test groups

| Group | Coverage |
|---|---|
| Functional | Auth, quotas, routing, failover, Provider lifecycle, knowledge merge, conflicts, imports, Agent, Memory, Skills, retrieval, ADR-015 sedimentation and skill injection |
| API | OpenAI/Anthropic envelopes, SSE, error codes, request IDs, health checks, MCP |
| LLM Wiki | wiki-phase0~8: system-page installation, two-step compilation, dedupe, degraded pages, Lint, graph, export, hybrid RRF, pseudo-rerank/rewrite, sedimentation, citation heat, skill retrieval |
| Performance | Gateway latency, retrieval, worker reuse, queue saturation, crash recovery, shutdown, import bounds |
| Security | Secret isolation, risk blocking, scope, allowlist, package validation, path safety |
| Interaction | Console views, imports, graph, Review, balance refresh, secret display |

## 3. Business rules

- Unauthorized or insufficient-scope requests must fail before any upstream call.
- Vision requests must never reach a text model.
- Every Provider attempt must enter the audit log.
- Pending Changes must not enter Master retrieval.
- Publication must expose either the complete old version or the complete new version to readers.
- Historical versions and merged Changes are immutable.
- Agents must cite published evidence and explicitly refuse to guess when evidence is insufficient.
- With `use_memory=false`, Memory must not be read or written.
- Local feature vectors must not be labeled as semantic Embeddings.
- System pages (`index.md`/`log.md`/`overview.md`) are compiler-maintained, with `purpose`/`schema` human co-authored; `atlasgate-degraded` degraded pages are excluded from retrieval by default.
- Q&A sedimentation has exactly two entry points: explicit `save_to_wiki`/`sediment`, or a similar question ≥3 times passing quality rules (≥2 source citations, no insufficient-evidence marker, content ≥80 characters); the pending Change for the same slug is reused instead of accumulating duplicates.
- A skill's `retrieval` declaration (`top_k`/`multihop`/`include_raw`/`directories`) is injected into retrieval after attach: `multihop`/`include_raw` activate when either is true, `top_k` takes the maximum; explicit caller parameters take priority.
- Hybrid retrieval must auto-degrade to pure lexical when no embedding is configured — no silent failures.

## 4. Run commands

```bash
npm test          # full Node + Python suite (Node 92 / Python 19)
npm run test:node # Node only (node --test)
python3 -m unittest discover -s python/tests -v   # Python only
npm run test:performance  # performance benchmarks (test/performance.bench.js)
npm run check     # syntax checks + full test gate
```

The npm scripts in `package.json` literally call `python`; environments without that alias should use `python3` explicitly. The runtime service resolves `ATLASGATE_PYTHON` or auto-detects `python`/`python3`, but the npm test scripts do not.

## 5. Reproducible examples

### 5.1 Start the service and smoke test (default port 4310, default credentials)

```bash
npm start   # console http://127.0.0.1:4310; admin/atlasgate-admin; gateway key atlasgate-dev-key

# Admin: log in first to save the session, then reuse it with -b cookies.txt
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/overview | python3 -m json.tool

# Gateway: Bearer auth
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
curl http://127.0.0.1:4310/health
```

### 5.2 Run the full suite

```bash
# Full (recommended): Node 92 + Python 19
npm test

# Equivalent step-by-step commands
npm run test:node
python3 -m unittest discover -s python/tests -v
npm run test:performance
```

## 6. Release gates

Every `implemented` capability must have matching code, tests, and boundary notes. Real Provider, Embedding, Qdrant, Docker, and browser tests must record the actual runtime environment; mock or fallback results must not be reported as production-quality evidence.
