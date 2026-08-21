# Architecture

## Modular monolith

AtlasGate keeps the gateway, knowledge control plane, Agent adapter, and console in one Node process while domain contracts stabilize. SQLite provides transactions, versioned evidence, and a portable local volume.

| Current module | Future service boundary |
|---|---|
| GatewayService | gateway-plane |
| KnowledgeService | knowledge-control and index-worker |
| Python Agent bridge | agent-runtime |
| PlatformService | evidence-query |

## Gateway

Requests are authenticated, governed, capability-filtered, scored, assigned a credential, attempted through a bounded route list, and written to routing/usage audit tables.

## Knowledge

`master_version` is the production pointer. Changes record base version, path, operation, author, and time. Merge runs in a transaction, copies the old Master, applies Changes in order, records conflicts and tombstones, rebuilds chunks and graph, and advances the pointer atomically.

## Retrieval and Agent

Local retrieval is deterministic and explainable. Hybrid retrieval optionally fuses lexical and dense page hits. Qdrant is an optional semantic backend. A bounded Python worker pool prepares evidence, Memory, Skills, and governed prompts.

## Wiki and graph

Raw sources, compiled Markdown pages, schema/purpose pages, system index/log pages, versioned graphs, and Markdown mirrors form the LLM Wiki layer. Graph nodes and edges are version-scoped; graph relations are separate from retrieval chunks.

See [architecture decisions](DECISIONS.md) for the reasons behind these choices.

