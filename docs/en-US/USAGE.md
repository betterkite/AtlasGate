# Usage Overview

The console is organized around the daily workflows of a small engineering team.

| View | Use |
|---|---|
| Overview | Usage, spend, tokens, success rate, Provider health, and recent requests |
| Knowledge Agent | Ask evidence-grounded questions and manage Memory/Skills |
| Knowledge versions | Review Changes, versions, documents, imports, conflicts, and graph |
| Model gateway | Manage Providers, credentials, model mappings, balances, and client keys |
| Routing strategy | Simulate candidate selection and inspect reasons |
| Wiki knowledge base | Browse pages, frontmatter, links, communities, and insights |
| Operations | Backups, maintenance, logs, and health information |
| Settings | Administrator password and project configuration |

The normal knowledge workflow is:

```text
create base -> import or ingest -> review Changes -> merge -> search/ask -> optionally save answer
```

Edits to published pages always create Changes. The Markdown mirror is read-only. Use the console's confirmation steps for Provider and knowledge-base deletion.

