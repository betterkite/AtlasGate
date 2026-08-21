# API Reference

All JSON mutation endpoints require `Content-Type: application/json`. Gateway endpoints require a client API key (default `Authorization: Bearer atlasgate-dev-key`); management endpoints require the console administrator session cookie (`atlasgate_admin_session`, HttpOnly). Every management `/api/*` endpoint except `/api/auth/*` requires an administrator session.

## Data plane

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/models` | API Key | List available models and the `auto` alias |
| POST | `/v1/chat/completions` | API Key | OpenAI Chat Completions-compatible API and SSE |
| POST | `/v1/responses` | API Key | OpenAI Responses-compatible API and SSE |
| POST | `/v1/messages` | API Key | Anthropic Messages-compatible API |
| POST | `/v1/messages/count_tokens` | API Key | Input token estimate |
| POST | `/v1/embeddings` | API Key | Generate embeddings through a Provider |
| POST | `/mcp` | MCP client | JSON-RPC initialize, list tools, and call tools |
| GET | `/health` | none | Health check (version, database, Python pool, retrieval status) |

Responses expose `x-atlas-request-id`, `x-atlas-routing-decision-id`, and `x-atlas-provider`. Routing headers include `x-atlas-routing-profile`, `x-atlas-session-id`, and `x-atlas-risk-mode`.

Gateway examples (default port 4310, development key `atlasgate-dev-key`; copy as-is to reproduce):

```bash
curl http://127.0.0.1:4310/v1/models \
  -H "Authorization: Bearer atlasgate-dev-key"

curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer atlasgate-dev-key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## Management API groups

Management endpoints all use a cookie session: log in once to save the session, then send the cookie on subsequent requests (see "Call examples" below).

### Authentication and sessions

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Administrator login; body `{"username","password"}`, sets HttpOnly cookie |
| POST | `/api/auth/logout` | Log out and invalidate the session |
| GET | `/api/auth/session` | Inspect the current session |
| POST | `/api/auth/password` | Change password; body `{"current_password","new_password"}` (new password must be at least 12 characters) |

### Platform and usage

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview?range=7d` | Console overview (trends, team distribution, etc.) |
| GET | `/api/logs?limit=100` | Recent operation/event logs |
| GET | `/api/usage/breakdown` | Usage breakdown statistics |
| GET | `/api/provider-attempts?limit=100` | Trace of every upstream attempt |
| GET | `/health` | Health check (no auth) |

### Organizations / teams / users

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/organizations` | List / create organizations |
| GET / POST | `/api/teams` | List / create teams |
| POST | `/api/teams/:id/members` | Add a team member |
| GET / POST | `/api/users` | List / create users |

### Providers, model mappings, and keys

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/providers` | List / create Providers (`kind`: `openai` / `anthropic` / `mock`) |
| PATCH / DELETE | `/api/providers/:id` | Enable/disable (body `{"enabled"}`) / delete a Provider |
| POST | `/api/providers/:id/test` | Connectivity test |
| POST | `/api/providers/:id/balance` | Refresh upstream balance (e.g. DeepSeek) |
| GET / POST | `/api/providers/:id/credentials` | Credential pool: list / add |
| PATCH | `/api/providers/:id/credentials/:credentialId` | Enable/disable a credential |
| GET / POST | `/api/model-mappings` | List / create model mappings |
| PATCH / DELETE | `/api/model-mappings/:id` | Edit / delete a model mapping |
| POST | `/api/routing/simulate` | Routing decision diagnostic simulation |
| GET / POST | `/api/keys` | Client keys: list / create |
| PATCH / DELETE | `/api/keys/:id` | Enable/disable / delete a client key |

Provider keys are stored server-side only; the API never returns key contents.

### Knowledge bases and version governance

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/knowledge-bases` | List / create knowledge bases (body may include `name`, `description`, `ingest_mode` (`review`/`auto`), `merge_batch_size`, `merge_interval_minutes`, `compile_model`) |
| PATCH / DELETE | `/api/knowledge-bases/:id` | Update knowledge base config / delete the knowledge base |
| POST | `/api/knowledge-bases/:id/import` | Import a document as a pending Change (body `filename`, `media_type`, `data_base64`, `author`, optional `path`, `publish`) |
| GET | `/api/knowledge-bases/:id/imports` | Import records |
| GET | `/api/knowledge-bases/:id/documents?version=` | Document list for the current (or given) version |
| GET | `/api/knowledge-bases/:id/document?path=&version=` | Single document content |
| GET | `/api/knowledge-bases/:id/pages?page_type=&version=` | Page list (filterable by `page_type`) |
| GET | `/api/knowledge-bases/:id/versions` | Immutable Master version list |
| GET | `/api/knowledge-bases/:id/versions/:version` | Snapshot of a given version |
| GET / POST | `/api/knowledge-bases/:id/changes` | List pending Changes / submit a Change (body `base_version`, `path`, `operation` (`upsert`/`delete`), `content`, `author`, optional `batch_id`) |
| PATCH / DELETE | `/api/knowledge-bases/:id/changes/:changeId` | Edit / delete a Change |
| GET | `/api/knowledge-bases/:id/changes/:changeId/revisions` | Change revision history |
| POST | `/api/knowledge-bases/:id/merge` | Merge pending Changes into a new immutable Master (body `summary`) |
| POST | `/api/knowledge/merge-due` | Manually trigger due auto-merge (only `auto`-mode bases) |
| POST | `/api/knowledge-bases/:id/maintenance` | Maintenance tasks (clean expired Memory, duplicate chunk detection, due merge) |
| GET / PUT | `/api/knowledge-bases/:id/schema` | Read / update schema.md (human collaboration, through the Change chain) |
| GET / PUT | `/api/knowledge-bases/:id/purpose` | Read / update purpose.md (human collaboration, through the Change chain) |
| GET | `/api/knowledge-bases/:id/conflicts` | Conflict ledger |
| GET / POST | `/api/knowledge-bases/:id/collaborators` | Collaborator list / set member role (body `user_id`, `role`) |

### LLM Wiki ingest, review, lint, sync, and export

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/knowledge-bases/:id/ingest` | Enqueue ingestion (returns 202); body `kind` (`document`/`paste`/`url`), `filename`, `text`/`url`/`data_base64`+`media_type`, optional `force: true` to force re-ingestion, `author` |
| GET | `/api/knowledge-bases/:id/ingest-queue?limit=` | Ingestion queue |
| POST | `/api/knowledge-bases/:id/ingest-queue/:jobId/cancel` | Cancel an ingestion job |
| POST | `/api/knowledge-bases/:id/ingest-queue/:jobId/retry` | Retry an ingestion job |
| GET | `/api/knowledge-bases/:id/sources` | List of ingested source material |
| GET | `/api/knowledge-bases/:id/research-jobs?status=` | Research tasks raised by the compiler |
| GET | `/api/knowledge-bases/:id/reviews?status=open` | Batch review items (default `open`) |
| PATCH | `/api/knowledge-bases/:id/reviews/:reviewId` | Resolve a review item (body `status`: `open`/`resolved`/`dismissed`, optional `action`) |
| POST | `/api/knowledge-bases/:id/reviews/resolve` | Batch-resolve review items (body `ids`, optional `action`) |
| POST | `/api/knowledge-bases/:id/lint` | Run lint (body `mode`: `structural` automatic / `llm` manual, requires a real model) |
| GET | `/api/knowledge-bases/:id/lint-reports?status=open` | Lint reports (default `open`) |
| PATCH | `/api/knowledge-bases/:id/lint-reports/:reportId` | Update report status |
| POST | `/api/knowledge-bases/:id/lint-reports/:reportId/create-page` | Generate a page directly from a lint report (201) |
| POST | `/api/knowledge-bases/:id/sync` | Trigger the `knowledge/<base>/` md mirror sync after publish |
| GET | `/api/knowledge-bases/:id/export?version=` | Export a ZIP (`application/zip` attachment) |

### Retrieval and semantic index

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/knowledge-bases/:id/search` | Hybrid retrieval (default): body `query`, `top_k` (≤20), `min_score`, `keyword_weight`, `vector_weight`, `path_glob`, `include_raw` (include degraded pages), `include_system` (include system pages); degrades to lexical-only when no embedding is configured |
| GET | `/api/knowledge-bases/:id/semantic-index` | Semantic index job list |
| POST | `/api/knowledge-bases/:id/semantic-index` | Rebuild the vector index for the given `version` (default Master) (202) |

### Agents, skills, and memory

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/agents/knowledge/ask` | Ask the knowledge Agent; body `kb_id`, `question`, optional `model`, `save_to_wiki`/`sediment` (explicit sedimentation), `query_title`, `use_memory`, `session_id`, `memory_importance`, and retrieval params `top_k`/`multihop`/`include_raw`/`directories`. Returns `run_id`/`answer`/`sources`/`routing`/`memory`/`skills`/`runtime`/`retrieval_mode`/`rewritten_question`; includes `saved_to_wiki` on successful sedimentation |
| GET | `/api/agents/knowledge/status?model=auto` | Model actually routed to by the Agent and execution mode |
| GET | `/api/agents/runs?limit=20` | Run records (question/answer/cited sources/duration) |
| GET / POST | `/api/skills` | List / create skills (body may include `retrieval`: `top_k`, `multihop`, `include_raw`, `directories`) |
| POST | `/api/skills/import` | Import a skill package from `SKILL.md` / `skill.json` |
| GET | `/api/skill-imports?limit=100` | Skill import ledger |
| PATCH / DELETE | `/api/skills/:id` | Update / delete a skill (DELETE auto-detaches) |
| GET | `/api/skills/:id/versions` | Skill version history |
| POST | `/api/skills/recommend` | Recommend skills by description (body `description`, `limit`) |
| POST | `/api/skills/merge` | Merge skills |
| POST | `/api/agents/:agentId/skills/:skillId` | Attach/detach a skill to/from an Agent (body `attached`, e.g. `/api/agents/knowledge-agent/skills/:id`); after attach its `retrieval` declaration is injected into retrieval params |
| GET / POST | `/api/memories` | Memory: list (filter by `session_id`/`agent_id`/`status`) / create (body `session_id`, `content` required) |
| DELETE | `/api/memories/:id` | Forget a Memory (body `reason`) |
| POST | `/api/memories/:id/supersede` | Supersede an old Memory with a new one |

## Call examples

> The commands below were tested against the default development configuration (`npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin). Log in once on the management side and save the session; subsequent requests all use `-b cookies.txt`:

```bash
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
```

Create a knowledge base → import → view Changes → merge (`$KB` holds the id returned by creation):

```bash
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Example KB","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"getting-started.md","media_type":"text/markdown","data_base64":"IyBBdGxhc0dhdGUg5YWl6ZeoCgpBdGxhc0dhdGUg5piv6Z2i5ZCR5bCP5Z6L5Zui6Zif55qE5pys5ZywIExNTSDln7rnoYDorr7mlr3vvJrlpJrljY/orq7nvZHlhbMgKyDniYjmnKzljJYgTExNIFdpa2kgKyDnn6Xor4YgQWdlbnTjgIIK","author":"tester"}'

curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes"
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"First release"}'
```

Hybrid retrieval (degrades to lexical-only automatically when no embedding is configured):

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/search" \
  -H 'content-type: application/json' -d '{"query":"AtlasGate","top_k":5}'
```

LLM Wiki ingestion (two-step compilation; degrades to an archived raw page without a real model) plus review/lint:

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"paste","filename":"source.md","text":"Xiang Dingtian found half a stone wall at the bottom of a dry well."}'

curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/reviews?status=open"
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/lint" \
  -H 'content-type: application/json' -d '{"mode":"structural"}'
```

Knowledge Agent question + Q&A sedimentation (ADR-015), and skill attach:

```bash
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What is AtlasGate\",\"save_to_wiki\":true}"
# Response includes saved_to_wiki (sedimented as a queries/ page; pending in review-mode bases)

SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-8","description":"Deep-fetch 8 pages","instructions":"Answer based on evidence","retrieval":{"top_k":8,"multihop":true}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'
```

Semantic index, md mirror sync, and ZIP export:

```bash
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/semantic-index" \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/sync" \
  -H 'content-type: application/json' -d '{}'
curl -b cookies.txt -o wiki.zip "http://127.0.0.1:4310/api/knowledge-bases/$KB/export"
unzip -l wiki.zip | head
```

## Knowledge retrieval conventions

Retrieval results include the evidence page path, section, chunk number, score, content, and Master version. Pending Changes are never returned as production evidence; system pages (`index.md`/`log.md`/`purpose.md`/`schema.md`/`overview.md`) and degraded pages (`atlasgate-degraded` marker) do not participate in retrieval by default (pass `include_system`/`include_raw` to include them explicitly).

Example Change submission:

```json
{
  "base_version": 3,
  "path": "policies/token-budget.md",
  "operation": "upsert",
  "content": "# Token budget\n...",
  "author": "ops-agent"
}
```

The full route list and stable error codes are defined in `src/app.js`.
