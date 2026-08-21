# Knowledge Agent

The Knowledge Agent answers from published evidence, cites sources, and optionally uses Memory, Skills, and Wiki write-back.

## Request

```http
POST /api/agents/knowledge/ask
```

```json
{"kb_id":"kb_xxx","question":"How are changes merged?","model":"auto","session_id":"opaque-session","use_memory":false,"save_to_wiki":false}
```

## Runtime pipeline

```text
validate -> retrieve Master evidence -> optional Memory recall
  -> load attached Skills -> build governed prompt -> route model
  -> validate citations -> record agent_runs
```

The Python worker performs retrieval preparation. With the mock Provider, the answer is local extractive output; a real Provider is required for synthesized LLM answers.

Memory is a hard opt-in: `use_memory=true` is required for both reads and writes. Skills can be created, versioned, imported from `SKILL.md` or `skill.json`, recommended, merged, and attached. A Skill is content, not executable code.

`save_to_wiki=true` stores the answer and source traceability in `queries/<slug>.md` as a pending Change. If evidence is missing, the Agent must say so instead of inventing an answer.

