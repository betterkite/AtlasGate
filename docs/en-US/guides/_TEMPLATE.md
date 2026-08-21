# Feature Name

> ID: `XXX-001`  
> Status: `implemented | partial | fallback | planned | deprecated`  
> Last verified: YYYY-MM-DD

## 1. Purpose and boundary

Describe the problem, callers, user value, and explicit non-goals.

## 2. Contract

Describe inputs, outputs, HTTP or internal interfaces, success conditions, stable errors, and permissions.

## 3. Code map

| Layer | File | Symbol or entry | Responsibility |
|---|---|---|---|
| Entry | `src/app.js` | `METHOD /path` | Request handling |
| Service | `src/services/example.js` | `ExampleService.method()` | Business rules |
| Core | `src/core/example.js` | `function()` | Algorithm or conversion |
| Storage | `src/db.js` | `table_name` | Persistence |
| Test | `test/example.test.js` | `describe(...)` | Behavioral evidence |

## 4. Execution flow

Use a sequence diagram, flowchart, or pseudocode for the normal path.

## 5. Implementation principles

Explain algorithms, transactions, state machines, caches, queues, concurrency, and version semantics.

## 6. Data lifecycle

Describe tables, fields, indexes, creation, update, publication, deletion, and audit retention.

## 7. Invariants and security boundaries

List rules that must always hold and boundaries around secrets, paths, user input, and external services.

## 8. Failure, retry, and fallback

Describe timeouts, duplicates, conflicts, crashes, and unavailable dependencies.

## 9. Tests and verification

List test files, commands, key scenarios, and remaining risks.

## 10. Extension points

Describe what must change when adding a Provider, protocol, page type, retrieval backend, or UI view.

## 11. Current limitations

Do not present mock, fallback, or reserved interfaces as complete production capabilities.

## 12. Related documentation

