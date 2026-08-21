import { HttpError } from "../core/http.js";

const TOOLS = [
  {
    name: "knowledge_search",
    description: "Search the published master version of an AtlasGate knowledge base.",
    inputSchema: {
      type: "object",
      properties: { kb_id: { type: "string" }, query: { type: "string" }, top_k: { type: "integer" } },
      required: ["kb_id", "query"],
    },
  },
  {
    name: "knowledge_ask",
    description: "Ask the governed knowledge agent and receive cited sources.",
    inputSchema: {
      type: "object",
      properties: { kb_id: { type: "string" }, question: { type: "string" }, use_memory: { type: "boolean" }, session_id: { type: "string" } },
      required: ["kb_id", "question"],
    },
  },
  {
    name: "knowledge_graph",
    description: "Read the document, heading, tag and link graph for a published knowledge version.",
    inputSchema: { type: "object", properties: { kb_id: { type: "string" }, version: { type: "integer" } }, required: ["kb_id"] },
  },
  {
    name: "knowledge_submit_change",
    description: "Submit an auditable upsert or delete against a knowledge master version.",
    inputSchema: { type: "object", properties: { kb_id: { type: "string" }, path: { type: "string" }, operation: { type: "string" }, content: { type: "string" }, author: { type: "string" }, base_version: { type: "integer" } }, required: ["kb_id", "path", "author"] },
  },
  {
    name: "knowledge_merge",
    description: "Publish pending knowledge changes as a new immutable master version.",
    inputSchema: { type: "object", properties: { kb_id: { type: "string" }, summary: { type: "string" } }, required: ["kb_id"] },
  },
  {
    name: "memory_list",
    description: "List active opt-in memories for a session.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "skill_list",
    description: "List available agent skills and lifecycle metrics.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wiki_ingest",
    description: "Enqueue a source into the LLM Wiki compile pipeline (paste text, url or a data_base64 document).",
    inputSchema: {
      type: "object",
      properties: { kb_id: { type: "string" }, kind: { type: "string" }, text: { type: "string" }, url: { type: "string" }, filename: { type: "string" }, data_base64: { type: "string" }, media_type: { type: "string" }, author: { type: "string" } },
      required: ["kb_id"],
    },
  },
  {
    name: "wiki_reviews_list",
    description: "List open human-review items produced by wiki ingest.",
    inputSchema: { type: "object", properties: { kb_id: { type: "string" }, status: { type: "string" } }, required: ["kb_id"] },
  },
  {
    name: "wiki_reviews_resolve",
    description: "Resolve one or more review items (status resolved/dismissed, optional action label).",
    inputSchema: { type: "object", properties: { kb_id: { type: "string" }, ids: { type: "array", items: { type: "string" } }, action: { type: "string" } }, required: ["kb_id", "ids"] },
  },
  {
    name: "wiki_lint_run",
    description: "Run a lint pass: structural (SQL, free) or llm (needs a real model provider).",
    inputSchema: { type: "object", properties: { kb_id: { type: "string" }, mode: { type: "string" } }, required: ["kb_id"] },
  },
  {
    name: "wiki_lint_list",
    description: "List lint reports (default status=open).",
    inputSchema: { type: "object", properties: { kb_id: { type: "string" }, status: { type: "string" } }, required: ["kb_id"] },
  },
];

export class McpService {
  constructor(knowledge, agent, wikiCompiler = null, lintService = null) {
    this.knowledge = knowledge;
    this.agent = agent;
    this.wikiCompiler = wikiCompiler;
    this.lintService = lintService;
  }

  async handle(message) {
    const { id, method, params = {} } = message;
    if (message.jsonrpc !== "2.0" || !method) throw new HttpError(400, "Invalid JSON-RPC request", "invalid_jsonrpc");
    if (method === "initialize") {
      return result(id, { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "atlasgate", version: "0.3.0" } });
    }
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return result(id, { tools: TOOLS });
    if (method === "tools/call") {
      const args = params.arguments ?? {};
      if (params.name === "knowledge_search") {
        const data = this.knowledge.search(args.kb_id, args.query, { top_k: args.top_k });
        return result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { results: data } });
      }
      if (params.name === "knowledge_ask") {
        const data = await this.agent.ask(args);
        if (args.save_to_wiki === true && this.wikiCompiler) {
          data.saved_to_wiki = this.wikiCompiler.saveQueryAnswer(args.kb_id, {
            question: args.question, answer: data.answer, sources: data.sources, title: args.query_title,
          });
        }
        return result(id, { content: [{ type: "text", text: data.answer }], structuredContent: data });
      }
      if (params.name === "knowledge_graph") {
        const data = this.knowledge.graph(args.kb_id, args.version);
        return result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
      }
      if (params.name === "knowledge_submit_change") {
        const data = this.knowledge.submitChange(args.kb_id, args);
        return result(id, { content: [{ type: "text", text: `Change ${data.change.id} staged.` }], structuredContent: data });
      }
      if (params.name === "knowledge_merge") {
        const data = this.knowledge.merge(args.kb_id, args.summary);
        return result(id, { content: [{ type: "text", text: `Published master v${data.version}.` }], structuredContent: data });
      }
      if (params.name === "memory_list") {
        const data = this.agent.listMemories({ session_id: args.session_id });
        return result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { memories: data } });
      }
      if (params.name === "skill_list") {
        const data = this.agent.listSkills();
        return result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { skills: data } });
      }
      if (params.name === "wiki_ingest") {
        if (!this.wikiCompiler) return failure(id, -32602, "Wiki compiler is unavailable");
        const data = await this.wikiCompiler.enqueue(args.kb_id, args);
        return result(id, { content: [{ type: "text", text: data.skipped ? `Skipped: ${data.reason}` : `Ingest job ${data.job.id} queued.` }], structuredContent: data });
      }
      if (params.name === "wiki_reviews_list") {
        if (!this.wikiCompiler) return failure(id, -32602, "Wiki compiler is unavailable");
        const data = this.wikiCompiler.listReviews(args.kb_id, args.status ?? "open");
        return result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { reviews: data } });
      }
      if (params.name === "wiki_reviews_resolve") {
        if (!this.wikiCompiler) return failure(id, -32602, "Wiki compiler is unavailable");
        const data = this.wikiCompiler.bulkResolveReviews(args.kb_id, args);
        return result(id, { content: [{ type: "text", text: `Resolved ${data.count} review item(s).` }], structuredContent: data });
      }
      if (params.name === "wiki_lint_run") {
        if (!this.lintService) return failure(id, -32602, "Lint service is unavailable");
        const data = await this.lintService.runLint(args.kb_id, args.mode ?? "structural");
        return result(id, { content: [{ type: "text", text: `Lint created ${data.length} report(s).` }], structuredContent: { reports: data } });
      }
      if (params.name === "wiki_lint_list") {
        if (!this.lintService) return failure(id, -32602, "Lint service is unavailable");
        const data = this.lintService.listReports(args.kb_id, args.status ?? "open");
        return result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { reports: data } });
      }
      return failure(id, -32602, `Unknown tool: ${params.name}`);
    }
    return failure(id, -32601, `Unknown method: ${method}`);
  }
}

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
