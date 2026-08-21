# Knowledge Versions, Changes, and Master Publication

> ID: `KB-001`  
> Status: `implemented`

## Purpose and boundary

Knowledge bases turn edits, imports, LLM output, and deletion into pending Changes before publishing an immutable Master version. Agents therefore never read half-completed edits, and each publication remains traceable.

## Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| HTTP | `src/app.js` | `/changes`, `/merge`, `/versions` | Version-management API |
| Service | `src/services/knowledge.js` | `submitChange()`, `merge()` | Changes, conflicts, publication |
| Storage | `src/db.js` | knowledge tables | Versioned data |
| Derived data | `src/services/knowledge.js` | chunk and graph rebuild | Retrieval and graph artifacts |
| Tests | `test/wiki-phase*.test.js` | Wiki phase tests | Behavioral evidence |

## Publication flow

```text
edit/import/compile -> pending Change -> revision check
  -> BEGIN IMMEDIATE -> copy Master to vN+1
  -> apply Changes in order -> record conflict/tombstone
  -> rebuild chunks and graph -> advance master_version -> COMMIT
```

## Invariants

- Agents read only `master_version`.
- Pending Changes are absent from production retrieval.
- Readers observe a complete old or new version.
- Merged Changes and historical versions are immutable.
- Same-path conflicts use the explicit latest-submitted-wins policy.
- Deletion is published through a delete Change and tombstone.

High-risk domains should add reviewer/approval states or a domain merge function instead of reusing latest-wins.

