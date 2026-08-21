# Management Console and MCP

> IDs: `UI-001`, `API-001`  
> Status: `partial` / `implemented`

The build-free web console operates the gateway, knowledge base, Wiki, graph, Agent, and operations views. MCP exposes a governed subset of capabilities to external Agents. The console is intended for loopback or a trusted private network, not direct public administration.

| Layer | File | Responsibility |
|---|---|---|
| HTML | `web/index.html` | Page skeleton |
| UI | `web/app.js` | API calls, state, and forms |
| Wiki UI | `web/knowledge-tabs.js` | Knowledge tabs |
| Graph UI | `web/graph.js` | Canvas graph interaction |
| MCP | `src/services/mcp.js` | JSON-RPC tool list and calls |
| HTTP | `src/app.js` | Auth, routing, and error responses |

Administrator APIs require a session. Provider secrets must never appear in UI, responses, logs, or errors. File imports require size, encoding, format, and path validation. MCP tools may call only declared governed capabilities.

