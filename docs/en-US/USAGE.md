# Usage Overview

The console is organized around the daily workflows of a small engineering team.

> Version baseline: **0.4.0** (tested Node 92 / Python 19; zero npm runtime dependencies; start with `npm start`, console http://127.0.0.1:4310, default `admin / atlasgate-admin`, gateway key `atlasgate-dev-key`). This document is a tour of the console and common task flows. Per-module deep dives live on the [navigation home](README.md).

## The 8 console views

| View | # | Purpose |
| --- | --- | --- |
| **Overview** | 01 | Upstream API Key balance (auto-refresh) + two hoverable request/Token curve charts (24h/7d/30d) |
| **Knowledge Agent** | 02 | Ask the knowledge base: evidence-cited answers, optional Memory, "Save to Wiki" sediments good answers as pages (ADR-015: explicit `save_to_wiki`/`sediment`, or a similar question asked ≥3 times + quality rules auto-sediment) |
| **Knowledge versions** | 03 | Knowledge base management: import, pending Changes, merge publish, version/conflict ledger, relation graph, Wiki settings (ingest mode review/auto), ingest queue, Review queue, Lint health |
| **Model gateway** | 04 | Provider/credentials/model mappings/client keys/balances/health test |
| **Routing strategy** | 05 | Routing simulation and exclusion diagnostics (scoring signals: quality/cost/latency/reliability) |
| **Skills & Memory** | 06 | Skill package upload/version/enable/disable/delete; `SKILL.md` frontmatter can declare a `retrieval` strategy (injected after attach); Memory lifecycle |
| **Audit evidence** | 07 | Request ledger: **every request shows the calling key**, routing decision, usage, risk |
| **Wiki knowledge base** | 08 | Three-pane reading (page tree/Markdown/graph): browse, edit (via Change), graph search/drag/hover, sync md, export zip |

## Minimal copy-paste example

Verified against the default dev config (`npm start`). Admin `/api/*` uses cookie sessions (login first and save `cookies.txt`); gateway `/v1/*` uses `Authorization: Bearer atlasgate-dev-key`:

```bash
# 0) Login (all subsequent admin requests use -b cookies.txt)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 1) Gateway call (built-in atlas-mini mock verifies the full chain offline)
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"

# 2) Create a KB (review mode: compiled output stays pending for human review;
#    use an ASCII name to avoid export-zip filename errors)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"usage-demo","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) Ingest a source (without a real Provider it degrades to a sources/source.md raw archive page,
#    publishable the same way)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone slab at the bottom of a dry well."}'

# 4) Review the batch (shared batch_id, author=wiki-compiler) -> publish (runs structural Lint
#    and syncs the md mirror)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" | python3 -m json.tool
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"First publish"}'

# 5) Ask the Knowledge Agent and sediment explicitly (ADR-015: the response carries saved_to_wiki,
#    the queries/<slug>.md artifact goes through the Change audit chain)
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"

# 6) Lint health (structural level runs free and automatically; LLM level needs a real model,
#    triggered manually)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint" \
  -H 'content-type: application/json' -d '{"mode":"structural"}'
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint-reports?status=open"
```

## Common task flows

### Connect a new model (DeepSeek example)
1. "Model gateway" -> Add Provider: name=`deepseek`, kind=`openai`, base_url=`https://api.deepseek.com`, API Key=your key, models=`deepseek-chat, deepseek-reasoner`.
2. "Test" to confirm health -> "Balance" to pull the account balance (DeepSeek automatically uses the official `/user/balance`; it appears on the Overview view).
3. If needed, add a credential pool (multi-key rotation) and model mappings (alias -> upstream model).

### Let a business system call the gateway
1. "Model gateway" -> issue a **client key**: set scope (`gateway:invoke`), model whitelist, RPM/TPM, token quota, monthly budget.
2. Hand the key to the caller, who calls `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/embeddings` with `Authorization: Bearer <key>` (in dev you can also use `atlasgate-dev-key`).
3. "Audit evidence" shows **which key** made every request (key name + prefix); internal calls are marked "internal call".

### Sediment knowledge (LLM Wiki compilation + ADR-015 Q&A sediment)
1. "Knowledge versions" -> create a KB (review mode, the default).
2. "Ingest queue" tab: paste text / fetch URL / upload md·txt·pdf; identical content is deduped by SHA256 and skipped, `force:true` forces re-ingestion.
3. Without a real model: source archive + raw text pages (degraded pages carry the `atlasgate-degraded` marker and do not participate in retrieval by default); after configuring a real model such as DeepSeek: two-step compilation (analysis -> generation) automatically produces entity/concept/summary pages, output lands in Pending.
4. "Pending merge changes": review per batch (the whole batch can be rejected) -> "Publish merge" -> new immutable Master.
5. "Wiki knowledge base": browse/edit; "Sync md" mirrors pages to `knowledge/<kb>/` (one-way, openable in Obsidian); "Export zip" packages them for Obsidian.
6. **Q&A sediment (ADR-015)**: check "Save to Wiki" when asking, or pass `save_to_wiki:true`/`sediment:true` in the API to sediment explicitly; or the same similar question asked ≥3 times with an answer meeting quality rules (≥2 source citations, no "insufficient evidence" marker, content ≥80 characters) auto-sediments. The artifact is a `queries/<slug>.md` page, auto-`[[wikilink]]`ed to `concepts/`/`entities/` pages, and goes through the Change audit chain (review KBs stay pending); a pending change with the same slug is updated in place instead of accumulating. Sedimented pages can be edited/deleted/rolled back in the Wiki view. Set `ATLASGATE_QUERY_SEDIMENT_ENABLED=false` to disable auto-sediment.

### Health-check a knowledge base
1. "Knowledge versions -> Lint health": structural checks (orphan pages/broken links/index consistency) are pure SQL, free, and **run automatically on every publish**; LLM-level checks (contradictions/outdated/data gaps) need a real model and are triggered manually.
2. Reports can be acked / ignored / one-click create the missing page (via Change).

## Permission & key cheat sheet (important)

- **Administrator account** (`admin`) -> logs into the console, manages everything; only via browser/API session (HttpOnly cookie); cannot call `/v1/*`.
- **Client key** -> calls `/v1/*`; has token quota/rate limit/budget; cannot log into the console; **there is no such thing as a "user account login"** (`users` are just accounting entities for key ownership).
- **Upstream API Key** (DeepSeek etc.) -> used by the gateway to call upstreams; the balance shows on the Overview and is unrelated to client-key quotas.

## More
- Gateway deep dive: [GATEWAY.md](GATEWAY.md)
- Knowledge versions deep dive: [KNOWLEDGE.md](KNOWLEDGE.md)
- LLM Wiki deep dive (where the md files live): [WIKI.md](WIKI.md)
- Agent deep dive (Memory/Skills/sediment): [AGENT.md](AGENT.md)
- Operations and troubleshooting: [CONSOLE_OPS.md](CONSOLE_OPS.md)
- Console and MCP: [guides/06-console-and-mcp.md](guides/06-console-and-mcp.md)
