# Knowledge Versions, Changes, and Master Publication

> ID: `KB-001`  
> Status: `implemented` (version 0.4.0)

## Purpose and boundary

Knowledge bases unify multi-user edits, imports, LLM output, and deletion into pending Changes (LLM compile batches share a `batch_id`), then publish an immutable Master version. Agents therefore never read half-completed edits, and each publication stays traceable to its author, conflicts (conflict ledger), and deletions (tombstone). Historical versions are immutable and remain independently retrievable and reviewable.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTTP | `src/app.js` | `/changes`, `/changes/:changeId` (PATCH/DELETE), `/merge`, `/versions`, `/versions/:version`, `/documents?version=`, `/document?path=&version=`, `/graph?version=`, `/conflicts` | Version-management API |
| Service | `src/services/knowledge.js` | `submitChange()`, `updateChange()`, `merge()`, `listVersions()`, `listConflicts()` | Change, conflict, and publication rules |
| Storage | `src/db.js` | `knowledge_changes`, `knowledge_change_revisions`, `knowledge_versions`, `knowledge_documents`, `knowledge_conflicts`, `knowledge_tombstones` | Versioned data and audit ledgers |
| Derived data | `src/services/knowledge.js` | chunk and graph rebuild (5-signal related edges) | Retrieval and graph artifacts |
| Tests | `test/wiki-phase*.test.js` | Wiki phase tests | Behavioral evidence |

## Publication flow

```text
edit/import/compile (LLM batches share batch_id)
  -> knowledge_changes(status=pending, revision=1)
  -> expected_revision check (optimistic concurrency)
  -> BEGIN IMMEDIATE
  -> copy current Master to vN+1
  -> apply Changes in created_at,rowid order
  -> conflict detection (stale_base_version / concurrent_path_update) → conflict ledger
  -> delete Change → tombstone
  -> rebuild chunks and graph (including 5-signal related edges)
  -> advance master_version
  -> COMMIT
```

## Invariants

- Agents read only `master_version`.
- Pending Changes never appear in production retrieval.
- Readers observe a complete old or new version (atomic transaction).
- Merged Changes and historical versions are immutable.
- Same-path conflicts use the explicit latest-submitted-wins policy and are recorded in the conflict ledger (`knowledge_conflicts`).
- Deletion is published through a delete Change and tombstone (`knowledge_tombstones`), never by erasing live content.
- Historical versions are independently retrievable: `/documents?version=`, `/document?path=&version=`, `/versions/:version`, `/graph?version=`.

## Extension boundary

High-risk domains should not reuse latest-wins directly; add reviewer/approval states to Changes, or inject a domain-level merge function. Migrations must preserve versions, conflicts, and audit evidence.

## Verification

```bash
npm test    # full suite: Node 92 + Python 19, zero npm runtime dependencies
node --test test/wiki-phase0.test.js test/wiki-phase2.test.js test/wiki-phase3.test.js   # version-governance cases
```

## End-to-end reproduction (import → pending → merge → version list)

Verified against the default dev config (`npm start`, console http://127.0.0.1:4310, admin / atlasgate-admin). Admin `/api/*` uses cookie sessions:

```bash
# 1) Login (cookie session)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# 2) Create a knowledge base (ingest_mode=review: output stays pending for human review)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"版本演示库","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# 3) Import a document → creates a pending Change (no Master pollution)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/import" \
  -H 'content-type: application/json' \
  -d '{"filename":"入门.md","media_type":"text/markdown","author":"tester","data_base64":"IyDmnq/kupXlupXnn7Plo4EKCuWQkemhtuWkqeWcqOaer+S6leW6leWPkeeOsOWNiuWdl+efs+Wjge+8jOS4iumdouWIu+edgOaooeeziueahOe6uei3r+OAgui/meaYr+acrOefpeivhuW6k+eahOesrOS4gOS7vee0oOadkOOAggoKLSDlhbPplK7or43vvJrnn7Plo4HjgIHmnq/kupXjgIHnurnot68KLSDlvZLlsZ7vvJrmtYvor5XntKDmnZA="}'

# 4) Inspect pending changes (status=pending, includes revision / batch_id)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  | python3 -m json.tool

# 5) Merge-publish → returns the new version number and conflict count
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"首次发布"}'
# → {"kb_id":"...","version":2,"parent_version":1,"change_count":1,"conflict_count":0}

# 6) List versions (immutable version history)
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/versions" \
  | python3 -m json.tool
```

Conflict ledger and tombstone demo (two upserts on the same path, then merge; deletion goes through a delete Change):

```bash
# Two upserts on the same path → merge records concurrent_path_update, latest-submitted-wins
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"alice","content":"# 修订 A\n\nAlice 的版本。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"upsert","author":"bob","content":"# 修订 B\n\nBob 后提交。"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"并发提交合并"}'   # conflict_count=1

curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/conflicts" \
  | python3 -m json.tool   # conflict ledger: earlier/winning change, reason, resolution

# Deletion goes through a delete Change + tombstone; version retrieval still sees history
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/changes" \
  -H 'content-type: application/json' \
  -d '{"path":"入门.md","operation":"delete","author":"tester"}'
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/merge" \
  -H 'content-type: application/json' -d '{"summary":"删除入门.md"}'
curl -b cookies.txt -G "http://127.0.0.1:4310/api/knowledge-bases/$KB/document" \
  --data-urlencode "path=入门.md" --data-urlencode "version=2"   # still readable at v2
```

Gateway `/v1/*` uses a Bearer key (`atlasgate-dev-key`):

```bash
curl http://127.0.0.1:4310/v1/models -H "Authorization: Bearer atlasgate-dev-key"
```

Full usage guide: [`docs/en-US/KNOWLEDGE.md`](../KNOWLEDGE.md).
