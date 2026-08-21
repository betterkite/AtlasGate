# Knowledge Agent (Agent / Skills / Memory)

This module backs console views 02 "Knowledge Agent" and 06 "Skills & Memory". Core principle: **answer only questions with evidence, cite sources, and optionally use Memory and Skills.** Retrieval defaults to hybrid (lexical bigram page-level + local dense vectors fused by RRF); without an embedding service it degrades to pure lexical automatically.

## 1. Invocation

### Console
In the "Knowledge Agent" view: pick a knowledge base + model → ask → get an answer with cited evidence; in the "Graph" view nodes are colored by `query_hits` (question-answer citation heat).

### HTTP API
```bash
POST /api/agents/knowledge/ask   # Admin API, requires admin cookie
{
  "kb_id": "kb_xxx", "question": "How are changes merged?",
  "model": "auto", "session_id": "any-id",
  "use_memory": false, "save_to_wiki": false, "sediment": false,
  "query_title": "optional sediment page title",
  "top_k": 5, "multihop": true, "include_raw": false,
  "retrieval_mode": "page"              # page (default) / chunk
}
```
Returns: `run_id`, `answer`, `sources[]`, `routing`, `memory{enabled,recalled,stored}`, `skills[]`, `runtime`, `retrieval_mode` (`hybrid` / `semantic_qdrant` / `page` / `chunk`), `rewritten_question` (non-empty when the query was rewritten), `saved_to_wiki` (when sedimented explicitly or automatically).

### MCP tools
`knowledge_ask`, `knowledge_search`, `knowledge_graph`, `knowledge_submit_change`, `knowledge_merge`, `memory_list`, `skill_list`, `wiki_ingest`, `wiki_reviews_list/resolve`, `wiki_lint_run/list`.

## 2. Answer pipeline

```
validate -> retrieve Master evidence (hybrid by default: lexical bigram page-level + dense vectors fused by RRF)
        -> pseudo-rerank (graph related edge degree, only breaks RRF ties)
        -> wikilink multi-hop expansion ([[wikilink]] follow-up, zero extra LLM calls)
        -> zero-evidence first round -> LLM query rewrite -> retry once (ATLASGATE_QUERY_REWRITE_ENABLED)
        -> optional Memory recall (read only when use_memory=true)
        -> load attached Skills (retrieval declarations inject retrieval params)
        -> build governed prompt (evidence numbers [1][2]...)
        -> route model (auto / explicit provider:model)
        -> validate citations -> write audit ledger (agent_runs) -> accumulate query_hits -> optional sediment
```

- **Hybrid retrieval (hybrid, default)**: lexical bigram page-level scoring + local dense vectors (`semantic_vectors` table, SQLite cosine) fused by RRF; without an embedding service (`ATLASGATE_EMBEDDING_BASE_URL` unset) it degrades automatically to pure lexical; `ATLASGATE_RETRIEVAL_MODE=qdrant` uses the Qdrant backend.
- **Pseudo-rerank**: a small boost from graph `related` edge degree (α=0.05) that only breaks RRF ties, never overrides the fused ranking.
- **Zero-evidence query rewrite**: when the first round finds nothing and the route is a real model, the LLM rewrites the question into a more retrievable form and retries once; skipped with mock or `ATLASGATE_QUERY_REWRITE_ENABLED=false`.
- **Wikilink multi-hop**: `[[wikilink]]` targets in first-round hits are resolved by basename and appended as extended evidence (multihop on by default; `multihop:false` turns it off).
- **Evidence sufficiency**: with insufficient evidence the Agent explicitly says "no sufficiently relevant evidence found" instead of inventing an answer.
- **Local mock mode**: extractive answers (lists the most relevant evidence) without simulated reasoning; with a real Provider configured, the answer goes through LLM synthesis.

## 3. Wiki write-back (save_to_wiki / sediment)

- `save_to_wiki:true` or `sediment:true` is **explicit sedimentation**: the answer + cited pages are saved as `queries/<slug>.md` (frontmatter carries `sources[]`, `linked_to`).
- **Smart classification**: on sedimentation the hybrid retrieval matches `concepts/` / `entities/` pages; on a strong top-1 match (score ≥0.2) the sediment page is linked via `[[wikilink]]` so it is not orphaned.
- Same slug with an existing pending change is **updated in place**, no duplicate accumulation.
- Follows the Change audit chain per `ingest_mode`: review mode → pending (editable / deletable / rollback before merge); auto mode → published directly.
- **Automatic sedimentation**: `ATLASGATE_QUERY_SEDIMENT_ENABLED` on by default; similar questions (30-day window, bigram Jaccard ≥0.3) asked ≥3 times + quality rules (≥2 source citations, no insufficient-evidence marker, content ≥80 characters) sediment automatically; explicit requests are not bound by the quality rules.
- Value: sediment exploration results back into the knowledge base (Karpathy's "good answers are written back").

## 4. Memory (explicit memory)

- **Hard rule**: reads and writes only happen with `use_memory=true`; with it off, neither read nor write.
- Kind (episodic/semantic...), scope (session...), importance, expires_at, superseded_by, forgotten.
- Recall ranks by content relevance and accumulates `access_count` / `last_accessed_at`; expired memories are forgotten automatically (maintenance), `supersede` replaces.
- Use: remember user preferences/conclusions across turns (sanitized summaries). API: `GET/POST /api/memories`, `DELETE /api/memories/:id`, `POST /api/memories/:id/supersede`.

## 5. Skills (skill packages)

- Upload `SKILL.md` (frontmatter: name/description/version/scope + body) or `skill.json` (`POST /api/skills` or `POST /api/skills/import`); versioning, import ledger, merge, and recommendation are supported.
- When attached to `knowledge-agent`, its instructions are injected into the answer prompt (`POST /api/agents/knowledge-agent/skills/:id`, body `{"attached":true}`).
- **Retrieval strategy binding (ADR-015/C)**: SKILL.md frontmatter may declare a `retrieval` field (top_k / multihop / include_raw / directories); once attached, retrieval params are injected automatically — multihop/include_raw turn on when either is true, top_k takes the max, directories take the union; **explicit caller params win over the skill**.
- Built-in: grounded-research (cite evidence), data-analysis (verify before analyzing).
- Management: `PATCH/DELETE /api/skills/:id` (DELETE supported, auto-detaches), `/api/skills/:id/versions`, `/api/skills/recommend`, `/api/skills/merge`.
- Security: skill packages are "content", not executable code; platform-level signing/evaluation is future work.

## 5.1 Memory and knowledge loop (ADR-015/A)

- With `use_memory:true` + session, Q&A summaries are injected into the prompt per conversation (episodic memory).
- **Sedimentation**: explicit via `save_to_wiki` / `sediment`, or automatic via ≥3 similar questions + quality rules; the Q&A becomes a `queries/` wiki page (audit chain, deletable and rollbackable); sediment pages link to concept/entity pages via `[[wikilink]]`.
- Every answer accumulates `query_hits` on cited pages (graph heat, 30-day window: pages unreferenced for over 30 days reset to 1).

## 6. Audit

Every ask writes `agent_runs` (sanitized question, answer, sources, skills, memory_used); skill calls write `skill_events` and accumulate `usage_count` / `success_count`; Q&A through the gateway also writes `usage_logs` (attributed to "internal calls"); sedimentation and merges go through the `knowledge_changes` audit chain.

## 7. Common pitfalls

- **Memory not working**: request missing `use_memory: true`.
- **Always extractive answers**: no real Provider configured (or auto only picked mock).
- **Empty citations**: the knowledge base has no published content, or the question is unrelated to the knowledge (check whether query rewrite triggered; degraded pages do not participate in retrieval by default, `include_raw:true` opens them).
- **save_to_wiki does nothing**: checkbox not selected; in `review` mode the output sits in pending and is only visible after merge; `ATLASGATE_QUERY_SEDIMENT_ENABLED=false` also disables explicit sedimentation.
- **Multi-hop not working**: hit pages have no `[[wikilink]]`, or the link targets are system pages / degraded pages that are excluded.

## 8. End-to-end reproduction

Verified against the default dev config (`npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin). Admin `/api/*` uses cookie sessions (login first to get the cookie, then reuse with `-b cookies.txt`); gateway `/v1/*` uses `Authorization: Bearer atlasgate-dev-key`.

### 8.1 Ask + explicit sedimentation

```bash
# 1) Login
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Create a KB and capture its id (auto mode: sediment publishes directly; review mode leaves pending)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"agent-demo","ingest_mode":"auto"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) Ask + explicit sedimentation (save_to_wiki / sediment either true = explicit)
#    Response includes answer / sources / retrieval_mode / rewritten_question / saved_to_wiki
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"How are changes merged?\",\"session_id\":\"demo-1\",\"use_memory\":true,\"save_to_wiki\":true}" \
  | python3 -m json.tool

# 4) Sediment output queries/<slug>.md (auto: published; review: pending until merged)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages" \
  | python3 -c 'import json,sys; [print(p["path"]) for p in json.load(sys.stdin) if p["path"].startswith("queries/")]'

# 5) Gateway /v1/* uses the Bearer key (same process as the Agent; shows the gateway auth mode)
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

### 8.2 Create a skill with a retrieval strategy and attach

```bash
# 1) Login (same as above; $KB carries the id from 8.1)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Create a skill: retrieval declares multi-hop + top_k=8 + concepts/ directory (equivalent to SKILL.md frontmatter)
SKILL=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/skills \
  -H 'content-type: application/json' \
  -d '{"name":"deep-retrieval","description":"Deep multi-hop retrieval","instructions":"Prefer a multi-hop evidence chain and cite each piece as [n].","retrieval":{"multihop":true,"top_k":8,"include_raw":false,"directories":["concepts/"]}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "SKILL=$SKILL"

# 3) Attach to knowledge-agent (body attached:true; attached:false detaches)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/agents/knowledge-agent/skills/$SKILL" \
  -H 'content-type: application/json' -d '{"attached":true}'

# 4) Verify injection: ask returns skills[] containing the skill; explicit multihop:false wins over the skill declaration
curl -b cookies.txt -X POST http://127.0.0.1:4310/api/agents/knowledge/ask \
  -H 'content-type: application/json' \
  -d "{\"kb_id\":\"$KB\",\"question\":\"What are the side effects of de-anchoring?\",\"multihop\":false}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("skills:", [s["name"] for s in d["skills"]], "| sources:", len(d["sources"]))'

# 5) Delete the skill (DELETE /api/skills/:id supported, auto-detaches)
curl -b cookies.txt -X DELETE "http://127.0.0.1:4310/api/skills/$SKILL"
```

## 9. Related docs

- [API.md](API.md) (ask / memories / skills / mcp endpoints)
- [WIKI.md](WIKI.md) (compiler pipeline prompts and validation)
- [RAG_PLAN.md](RAG_PLAN.md) (hybrid RRF / pseudo-rerank / rewrite / multi-hop / evidence-sufficiency three-stage decisions)
- [Architecture](ARCHITECTURE.md) (Python worker pool)
