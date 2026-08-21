# Management Console and MCP

> IDs: `UI-001`, `API-001`  
> Status: `implemented` (version 0.4.0)

## 1. Purpose and boundary

The build-free native web console (8 views) operates the gateway, knowledge base, Wiki, graph, Agent, Skills/Memory, and operations; MCP exposes a small governed capability set (knowledge retrieval/ask/graph/Change/merge/ingest/review/Lint/Memory/Skills — 12 tools in total) to external Agents over JSON-RPC. The console currently suits loopback or a trusted private network and should not be treated as a public administrator product.

## 2. Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTML | `web/index.html` | 8 `data-view` panels | View containers (01 Overview / 02 Knowledge Agent / 03 Knowledge versions / 04 Model gateway / 05 Routing strategy / 06 Skills & Memory / 07 Audit evidence / 08 Wiki knowledge base) |
| UI | `web/app.js` | view handlers | API calls, state, and forms |
| Wiki UI | `web/knowledge-tabs.js` | knowledge tabs | Pages, changes, imports, graph, and conflict views |
| Graph UI | `web/graph.js` | Canvas renderer | Graph interaction (ForceAtlas2-style layout, drag, community coloring, citation heat) |
| MCP | `src/services/mcp.js` | `McpService.handle()` | JSON-RPC 2.0: `initialize` / `tools/list` / `tools/call` (12 governed tools) |
| HTTP | `src/app.js` | `/mcp`, `/api/*`, `/v1/*` | Auth (admin cookie / gateway Bearer), routing, and error responses |

## 3. The 8 console views and operation steps

| # | View | Operation steps (minimal loop) |
|---|---|---|
| 01 | Overview | Open and see: upstream balance (auto-refresh) + request/Token curves (24h/7d/30d switch, hover for values). Backing API: `GET /api/overview?range=` |
| 02 | Knowledge Agent | Pick a KB -> enter a question -> optionally check Memory (`use_memory`) and "Save to Wiki" (`save_to_wiki`) -> submit. The answer carries `sources` citations; the response includes `rewritten_question` (zero-evidence rewrite) and `retrieval_mode` |
| 03 | Knowledge versions | Create a KB (`ingest_mode` review/auto) -> import/ingest (paste/URL/file) -> review pending Changes per batch (whole batch can be rejected) -> merge-publish as a new Master -> conflict ledger/version history/ingest queue/Review queue/Lint health |
| 04 | Model gateway | Provider CRUD + credential pool + model mappings + issue client keys (scope/whitelist/RPM/TPM/quota/budget) + test/balance |
| 05 | Routing strategy | Routing simulation: pick a model to see candidates and exclusion reasons (quality/cost/latency/reliability scores); `POST /api/routing/simulate` |
| 06 | Skills & Memory | Upload a skill (`SKILL.md` frontmatter can declare `retrieval`: top_k/multihop/include_raw/directories) -> attach to knowledge-agent -> ask to verify parameter injection (multihop/include_raw turn on when either is true, top_k takes the max, explicit caller params win); Memory list/create/forget/supersede (`supersede`) |
| 07 | Audit evidence | Inspect the request ledger per entry: calling key (name + prefix), routing decision, usage, risk markers; `GET /api/logs`, `GET /api/provider-attempts` |
| 08 | Wiki knowledge base | Three-pane reading (page tree/Markdown/graph): browse and edit (via Change) -> graph search/drag/hover (incl. `query_hits` citation heat) -> sync md (`knowledge/<kb>/`) -> export zip |

## 4. MCP tools and call examples

Endpoint `POST /mcp`, JSON-RPC 2.0 (protocol `2025-03-26`). **Not under `/api/*` and does not require an admin session**, but only exposes the declared governed tools: `knowledge_search` / `knowledge_ask` / `knowledge_graph` / `knowledge_submit_change` / `knowledge_merge` / `memory_list` / `skill_list` / `wiki_ingest` / `wiki_reviews_list` / `wiki_reviews_resolve` / `wiki_lint_run` / `wiki_lint_list`.

```bash
# 1) Tool list (default dev config npm start, http://127.0.0.1:4310)
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 2) Call a governed tool: search the published Master ($KB is the id returned by KB creation,
#    see the USAGE.md example)
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"knowledge_search\",\"arguments\":{\"kb_id\":\"$KB\",\"query\":\"stone slab clue\",\"top_k\":5}}}"

# 3) Knowledge Agent ask (structuredContent includes sources citation evidence)
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"knowledge_ask\",\"arguments\":{\"kb_id\":\"$KB\",\"question\":\"What are the side effects of the anchor-detach technique?\"}}}"

# 4) Submit a governed change (goes through the Change audit chain; review KBs stay pending)
curl -s http://127.0.0.1:4310/mcp \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"knowledge_submit_change\",\"arguments\":{\"kb_id\":\"$KB\",\"path\":\"notes/example.md\",\"operation\":\"upsert\",\"content\":\"---\\ntype: note\\ntitle: Example\\n---\\n\\nContent\",\"author\":\"mcp-demo\"}}}"
```

## 5. Security boundary

- `/api/*` (except auth endpoints) requires an admin session (HttpOnly + SameSite=Lax cookie); `/v1/*` requires a Bearer gateway key; `/mcp` needs no session but only exposes the governed tool set above.
- Provider secrets must never appear in the UI, API responses, logs, or error bodies.
- File imports must pass size, encoding, format, and path validation.
- MCP tools can only call the declared governed capabilities and never return any keys.

## 6. Current limitations

The console has no standalone public admin identity system, TLS termination, or fine-grained multi-tenant UI permissions. Therefore the completeness of the interface and its public-internet security must be evaluated separately.

## 7. Verification

```bash
npm test    # Full suite: Node 92 + Python 19, zero npm runtime dependencies
node --test test/atlasgate.test.js test/graph-layout.test.js   # gateway/console APIs + graph layout
```

End-to-end reproduction: `npm start` -> open http://127.0.0.1:4310 in a browser (admin / atlasgate-admin) and walk through the 8 views as in Section 3; the Section 4 MCP commands are copy-paste runnable (create a KB first to get `$KB`).
