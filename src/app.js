import http from "node:http";
import path from "node:path";
import { loadConfig } from "./config.js";
import { errorPayload, HttpError, readJson, Router, sendJson, serveStatic } from "./core/http.js";
import { sendAnthropicStream, sendOpenAIStream, sendResponsesStream } from "./core/sse.js";
import { openDatabase } from "./db.js";
import { AgentService } from "./services/agent.js";
import { AuthService } from "./services/auth.js";
import { DocumentParser } from "./services/document-parser.js";
import { GatewayService } from "./services/gateway.js";
import { IngestQueue } from "./services/ingest-queue.js";
import { KnowledgeService } from "./services/knowledge.js";
import { LintService } from "./services/lint.js";
import { McpService } from "./services/mcp.js";
import { PlatformService } from "./services/platform.js";
import { PythonAgentBridge } from "./services/python-agent.js";
import { SemanticIndexService } from "./services/semantic-index.js";
import { WikiCompiler } from "./services/wiki-compiler.js";
import { WikiExportService } from "./services/wiki-export.js";
import { WikiSyncService } from "./services/wiki-sync.js";
import { chatToAnthropic, chatToResponse, fromAnthropic, fromResponses } from "./services/protocol.js";

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDatabase(config);
  const auth = new AuthService(db, config);
  const gateway = new GatewayService(db, config);
  const documentParser = new DocumentParser(config);
  const knowledge = new KnowledgeService(db, documentParser, config);
  const pythonAgent = new PythonAgentBridge(config);
  const semanticIndex = new SemanticIndexService(db, config);
  const agent = new AgentService(db, gateway, pythonAgent, semanticIndex, config);
  const platform = new PlatformService(db);
  const ingestQueue = new IngestQueue(db);
  const wikiCompiler = new WikiCompiler(db, config, knowledge, pythonAgent, gateway, documentParser,
    (kbId, version) => semanticIndex.enabled() ? semanticIndex.indexVersion(kbId, version) : Promise.resolve());
  wikiCompiler.queue = ingestQueue;
  const lintService = new LintService(db, config, knowledge, pythonAgent, gateway);
  knowledge.publishHooks.push((kbId, version) => {
    try { lintService.structuralLint(kbId, version); } catch (error) { console.error("Structural lint after publish failed", error); }
  });
  const wikiExport = new WikiExportService(db, knowledge);
  const wikiSync = new WikiSyncService(db, config, knowledge);
  knowledge.publishHooks.push((kbId, version) => {
    try { wikiSync.syncKnowledgeBase(kbId, version); } catch (error) { console.error("Wiki md mirror after publish failed", error); }
  });
  const mcp = new McpService(knowledge, agent, wikiCompiler, lintService);
  try {
    // One-time LLM Wiki upgrade: stage missing system pages for pre-existing
    // knowledge bases as pending Changes for owner review.
    const seeded = knowledge.ensureSystemPagesForAll();
    if (seeded.created > 0) console.log(`Wiki model: staged ${seeded.created} system page change(s) for legacy knowledge bases`);
  } catch (error) { console.error("Wiki system page seeding failed", error); }
  try {
    // Startup catch-up: mirror any published masters that changed while the
    // service was not running (Q7).
    const synced = wikiSync.syncAll();
    if (synced.synced > 0) console.log(`Wiki md mirror: synced ${synced.synced} knowledge base(s), ${synced.files} file(s) -> ${wikiSync.vaultRoot()}`);
  } catch (error) { console.error("Wiki md mirror startup sync failed", error); }
  wikiCompiler.start();
  const router = new Router();
  const mergeTimer = setInterval(async () => {
    try {
      const merged = knowledge.mergeDueBases();
      if (semanticIndex.enabled()) await Promise.allSettled(merged.map((item) => semanticIndex.indexVersion(item.kb_id, item.version)));
    } catch (error) { console.error("Scheduled knowledge merge failed", error); }
  }, 60_000);
  mergeTimer.unref();

  router.get("/health", () => ({
    status: 200,
    body: { status: "ok", service: "atlasgate", version: "0.4.0", database: "ready", agent_runtime: "python", python_pool: pythonAgent.status(), retrieval: semanticIndex.status() },
  }));
  router.get("/api/auth/session", ({ req }) => ({ body: { authenticated: Boolean(auth.current(req)), user: auth.current(req) } }));
  router.post("/api/auth/login", ({ body }) => {
    const result = auth.login(body.username, body.password);
    return { body: { authenticated: true, user: result.user, expires_at: result.expires_at }, headers: { "set-cookie": result.cookie } };
  });
  router.post("/api/auth/logout", ({ req }) => {
    const result = auth.logout(req);
    return { body: { authenticated: false }, headers: { "set-cookie": result.cookie } };
  });
  router.post("/api/auth/password", ({ req, body }) => ({ body: auth.changePassword(req, body.current_password, body.new_password) }));
  router.get("/api/overview", ({ url }) => ({ body: platform.overview(url.searchParams.get("range") ?? "7d") }));
  router.get("/api/logs", ({ url }) => ({ body: platform.logs(url.searchParams.get("limit") ?? 100) }));
  router.get("/api/usage/breakdown", () => ({ body: platform.usageBreakdown() }));
  router.get("/api/organizations", () => ({ body: platform.listOrganizations() }));
  router.post("/api/organizations", ({ body }) => ({ status: 201, body: platform.createOrganization(body) }));
  router.get("/api/teams", () => ({ body: platform.listTeams() }));
  router.post("/api/teams", ({ body }) => ({ status: 201, body: platform.createTeam(body) }));
  router.post("/api/teams/:id/members", ({ params, body }) => ({ status: 201, body: platform.addTeamMember(params.id, body) }));
  router.get("/api/users", () => ({ body: platform.listUsers() }));
  router.post("/api/users", ({ body }) => ({ status: 201, body: platform.createUser(body) }));

  router.get("/api/providers", () => ({ body: gateway.listProviders() }));
  router.post("/api/providers", ({ body }) => ({ status: 201, body: gateway.createProvider(body) }));
  router.patch("/api/providers/:id", ({ params, body }) => ({ body: gateway.setProviderEnabled(params.id, body.enabled) }));
  router.delete("/api/providers/:id", ({ params }) => ({ body: gateway.deleteProvider(params.id) }));
  router.post("/api/providers/:id/test", async ({ params }) => ({ body: await gateway.testProvider(params.id) }));
  router.post("/api/providers/:id/balance", async ({ params }) => ({ body: await gateway.refreshProviderBalance(params.id) }));
  router.get("/api/providers/:id/credentials", ({ params }) => ({ body: gateway.listCredentials(params.id) }));
  router.post("/api/providers/:id/credentials", ({ params, body }) => ({ status: 201, body: gateway.createCredential(params.id, body) }));
  router.patch("/api/providers/:id/credentials/:credentialId", ({ params, body }) => ({ body: gateway.setCredentialEnabled(params.id, params.credentialId, body.enabled) }));
  router.get("/api/model-mappings", () => ({ body: gateway.listMappings() }));
  router.post("/api/model-mappings", ({ body }) => ({ status: 201, body: gateway.createMapping(body) }));
  router.patch("/api/model-mappings/:id", ({ params, body }) => ({ body: gateway.updateMapping(params.id, body) }));
  router.delete("/api/model-mappings/:id", ({ params }) => ({ body: gateway.deleteMapping(params.id) }));
  router.get("/api/provider-attempts", ({ url }) => ({ body: gateway.listAttempts(url.searchParams.get("limit") ?? 100) }));
  router.get("/api/keys", () => ({ body: gateway.listKeys() }));
  router.post("/api/keys", ({ body }) => ({ status: 201, body: gateway.createKey(body) }));
  router.patch("/api/keys/:id", ({ params, body }) => ({ body: gateway.setKeyEnabled(params.id, body.enabled) }));
  router.delete("/api/keys/:id", ({ params }) => ({ body: gateway.deleteKey(params.id) }));
  router.post("/api/routing/simulate", ({ body, req }) => ({ body: publicPlan(gateway.simulate(body, req.headers)) }));

  router.get("/v1/models", ({ req }) => {
    gateway.authenticate(req);
    return { body: gateway.listModels() };
  });
  router.post("/v1/chat/completions", async ({ req, res, body }) => {
    const apiKey = gateway.authenticate(req);
    const completion = await gateway.complete(body, { headers: req.headers, apiKey });
    if (body.stream) {
      sendOpenAIStream(res, completion.response, completion.headers);
      return null;
    }
    return { body: completion.response, headers: completion.headers };
  });
  router.post("/v1/responses", async ({ req, res, body }) => {
    const apiKey = gateway.authenticate(req);
    const request = fromResponses(body);
    const completion = await gateway.completeRequest(request, { headers: req.headers, apiKey, route: "/v1/responses" });
    if (request.stream) {
      sendResponsesStream(res, completion.response, completion.headers);
      return null;
    }
    return { body: chatToResponse(completion.response), headers: completion.headers };
  });
  router.post("/v1/messages", async ({ req, res, body }) => {
    const apiKey = gateway.authenticate(req);
    const request = fromAnthropic(body);
    const completion = await gateway.completeRequest(request, { headers: req.headers, apiKey, route: "/v1/messages" });
    if (request.stream) {
      sendAnthropicStream(res, completion.response, completion.headers);
      return null;
    }
    return { body: chatToAnthropic(completion.response), headers: completion.headers };
  });
  router.post("/v1/messages/count_tokens", ({ req, body }) => {
    gateway.authenticate(req);
    return { body: gateway.countTokens(fromAnthropic(body)) };
  });
  router.post("/v1/embeddings", async ({ req, body }) => {
    const apiKey = gateway.authenticate(req);
    const result = await gateway.embeddings(body, { apiKey, headers: req.headers });
    return { body: result.response, headers: result.headers };
  });

  router.get("/api/knowledge-bases", () => ({ body: knowledge.listKnowledgeBases() }));
  router.post("/api/knowledge-bases", ({ body }) => {
    const kb = knowledge.createKnowledgeBase(body);
    try { wikiSync.syncKnowledgeBase(kb.id); } catch (error) { console.error("Wiki md mirror on create failed", error); }
    return { status: 201, body: kb };
  });
  router.patch("/api/knowledge-bases/:id", ({ params, body }) => ({ body: knowledge.updateKnowledgeBase(params.id, body) }));
  router.delete("/api/knowledge-bases/:id", ({ params }) => ({ body: knowledge.deleteKnowledgeBase(params.id) }));
  router.get("/api/knowledge-bases/:id/documents", ({ params, url }) => ({ body: knowledge.listDocuments(params.id, url.searchParams.get("version")) }));
  router.get("/api/knowledge-bases/:id/document", ({ params, url }) => ({ body: knowledge.getDocument(params.id, url.searchParams.get("path"), url.searchParams.get("version")) }));
  router.get("/api/knowledge-bases/:id/changes", ({ params }) => ({ body: knowledge.listChanges(params.id) }));
  router.get("/api/knowledge-bases/:id/versions", ({ params }) => ({ body: knowledge.listVersions(params.id) }));
  router.get("/api/knowledge-bases/:id/versions/:version", ({ params }) => ({ body: knowledge.getVersion(params.id, params.version) }));
  router.get("/api/knowledge-bases/:id/graph", ({ params, url }) => ({ body: knowledge.graph(params.id, url.searchParams.get("version")) }));
  router.get("/api/knowledge-bases/:id/conflicts", ({ params }) => ({ body: knowledge.listConflicts(params.id) }));
  router.get("/api/knowledge-bases/:id/imports", ({ params }) => ({ body: knowledge.listImports(params.id) }));
  router.post("/api/knowledge-bases/:id/import", async ({ params, body }) => ({ status: 201, body: await knowledge.importDocument(params.id, body) }));
  router.get("/api/knowledge-bases/:id/collaborators", ({ params }) => ({ body: knowledge.listCollaborators(params.id) }));
  router.post("/api/knowledge-bases/:id/collaborators", ({ params, body }) => ({ status: 201, body: knowledge.setCollaborator(params.id, body.user_id, body.role) }));
  router.post("/api/knowledge-bases/:id/changes", ({ params, body }) => ({ status: 201, body: knowledge.submitChange(params.id, body) }));
  router.patch("/api/knowledge-bases/:id/changes/:changeId", ({ params, body }) => ({ body: knowledge.updateChange(params.id, params.changeId, body) }));
  router.delete("/api/knowledge-bases/:id/changes/:changeId", ({ params }) => ({ body: knowledge.deleteChange(params.id, params.changeId) }));
  router.get("/api/knowledge-bases/:id/changes/:changeId/revisions", ({ params }) => ({ body: knowledge.listChangeRevisions(params.id, params.changeId) }));
  router.post("/api/knowledge-bases/:id/merge", async ({ params, body }) => {
    const result = knowledge.merge(params.id, body.summary);
    if (semanticIndex.enabled()) await semanticIndex.indexVersion(params.id, result.version);
    return { body: result };
  });
  router.post("/api/knowledge-bases/:id/maintenance", ({ params, body }) => ({ body: knowledge.maintenance(params.id, body) }));
  router.get("/api/knowledge-bases/:id/schema", ({ params }) => ({ body: knowledge.getSchema(params.id) }));
  router.put("/api/knowledge-bases/:id/schema", ({ params, body }) => ({ body: knowledge.updateSchema(params.id, body) }));
  router.get("/api/knowledge-bases/:id/purpose", ({ params }) => ({ body: knowledge.getPurpose(params.id) }));
  router.put("/api/knowledge-bases/:id/purpose", ({ params, body }) => ({ body: knowledge.updatePurpose(params.id, body) }));
  router.get("/api/knowledge-bases/:id/pages", ({ params, url }) => ({ body: knowledge.listPages(params.id, { page_type: url.searchParams.get("page_type") ?? undefined, version: url.searchParams.get("version") ?? undefined }) }));
  router.post("/api/knowledge-bases/:id/ingest", async ({ params, body }) => ({ status: 202, body: await wikiCompiler.enqueue(params.id, body) }));
  router.get("/api/knowledge-bases/:id/ingest-queue", ({ params, url }) => ({ body: ingestQueue.list(params.id, url.searchParams.get("limit")) }));
  router.post("/api/knowledge-bases/:id/ingest-queue/:jobId/cancel", ({ params }) => ({ body: ingestQueue.cancel(params.jobId) }));
  router.post("/api/knowledge-bases/:id/ingest-queue/:jobId/retry", ({ params }) => ({ body: ingestQueue.retry(params.jobId) }));
  router.get("/api/knowledge-bases/:id/sources", ({ params }) => ({ body: wikiCompiler.listSources(params.id) }));
  router.get("/api/knowledge-bases/:id/research-jobs", ({ params, url }) => ({ body: wikiCompiler.listResearchJobs(params.id, url.searchParams.get("status")) }));
  router.get("/api/knowledge-bases/:id/export", ({ params, url, res }) => {
    const result = wikiExport.exportZip(params.id, url.searchParams.get("version"));
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "content-length": result.buffer.length,
    });
    res.end(result.buffer);
    return null;
  });
  router.post("/api/knowledge-bases/:id/sync", ({ params }) => ({ body: wikiSync.syncKnowledgeBase(params.id) }));
  router.get("/api/knowledge-bases/:id/reviews", ({ params, url }) => ({ body: wikiCompiler.listReviews(params.id, url.searchParams.get("status") ?? "open") }));
  router.patch("/api/knowledge-bases/:id/reviews/:reviewId", ({ params, body }) => ({ body: wikiCompiler.resolveReview(params.id, params.reviewId, body) }));
  router.post("/api/knowledge-bases/:id/reviews/resolve", ({ params, body }) => ({ body: wikiCompiler.bulkResolveReviews(params.id, body) }));
  router.post("/api/knowledge-bases/:id/lint", async ({ params, body }) => ({ body: { reports: await lintService.runLint(params.id, body.mode ?? "structural") } }));
  router.get("/api/knowledge-bases/:id/lint-reports", ({ params, url }) => ({ body: lintService.listReports(params.id, url.searchParams.get("status") ?? "open") }));
  router.patch("/api/knowledge-bases/:id/lint-reports/:reportId", ({ params, body }) => ({ body: lintService.updateReport(params.id, params.reportId, body) }));
  router.post("/api/knowledge-bases/:id/lint-reports/:reportId/create-page", ({ params, body }) => ({ status: 201, body: lintService.createPageFromLint(params.id, params.reportId, body) }));
  router.post("/api/knowledge/merge-due", () => ({ body: knowledge.mergeDueBases() }));
  router.post("/api/knowledge-bases/:id/search", async ({ params, body }) => ({
    body: semanticIndex.enabled() ? await semanticIndex.search(params.id, body.query, body) : knowledge.search(params.id, body.query, body),
  }));
  router.get("/api/knowledge-bases/:id/semantic-index", ({ params }) => ({ body: semanticIndex.listJobs(params.id) }));
  router.post("/api/knowledge-bases/:id/semantic-index", async ({ params, body }) => ({ status: 202, body: await semanticIndex.indexVersion(params.id, body.version) }));

  router.post("/api/agents/knowledge/ask", async ({ body }) => {
    const result = await agent.ask(body);
    // ADR-015 (B): record which pages the answer cited (usage heat).
    if (body.kb_id) knowledge.recordQueryHits(body.kb_id, (result.sources ?? []).map((source) => source.path));
    // ADR-015 (A): sediment Q&A into the wiki — explicit request (save_to_wiki /
    // sediment) or auto (same question asked >=3 times + quality rule).
    if (body.kb_id) {
      const sediment = wikiCompiler.autoSediment(body.kb_id, {
        question: body.question, answer: result.answer, sources: result.sources,
        explicit: body.save_to_wiki === true || body.sediment === true,
        title: body.query_title,
      });
      if (sediment) result.saved_to_wiki = sediment;
    }
    return { body: result };
  });
  router.get("/api/agents/knowledge/status", ({ url }) => ({ body: agent.status(url.searchParams.get("model") ?? "auto") }));
  router.get("/api/agents/runs", ({ url }) => ({ body: agent.listRuns(url.searchParams.get("limit") ?? 20) }));
  router.get("/api/skills", () => ({ body: agent.listSkills() }));
  router.post("/api/skills", ({ body }) => ({ status: 201, body: agent.createSkill(body) }));
  router.post("/api/skills/import", ({ body }) => ({ status: 201, body: agent.importSkill(body) }));
  router.get("/api/skill-imports", ({ url }) => ({ body: agent.listSkillImports(url.searchParams.get("limit") ?? 100) }));
  router.patch("/api/skills/:id", ({ params, body }) => ({ body: agent.updateSkill(params.id, body) }));
  router.delete("/api/skills/:id", ({ params }) => ({ body: agent.deleteSkill(params.id) }));
  router.get("/api/skills/:id/versions", ({ params }) => ({ body: agent.skillVersions(params.id) }));
  router.post("/api/skills/recommend", ({ body }) => ({ body: agent.recommendSkills(body.description ?? "", body.limit) }));
  router.post("/api/skills/merge", ({ body }) => ({ status: 201, body: agent.mergeSkills(body) }));
  router.post("/api/agents/:agentId/skills/:skillId", ({ params, body }) => ({
    body: agent.attachSkill(params.agentId, params.skillId, body.attached !== false),
  }));
  router.get("/api/memories", ({ url }) => ({ body: agent.listMemories({ session_id: url.searchParams.get("session_id"), agent_id: url.searchParams.get("agent_id") ?? "knowledge-agent", status: url.searchParams.get("status") ?? "active" }) }));
  router.post("/api/memories", ({ body }) => ({ status: 201, body: agent.createMemory(body) }));
  router.delete("/api/memories/:id", ({ params, body }) => ({ body: agent.forgetMemory(params.id, body.reason) }));
  router.post("/api/memories/:id/supersede", ({ params, body }) => ({ status: 201, body: agent.supersedeMemory(params.id, body) }));

  router.post("/mcp", async ({ body }) => {
    const response = await mcp.handle(body);
    return response === null ? { status: 202, body: {} } : { body: response };
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? `${config.host}:${config.port}`}`);
    const matched = router.match(req.method, url.pathname);
    if (matched) {
      try {
        if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/")) auth.require(req);
        if (["POST", "PATCH", "PUT"].includes(req.method) && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw new HttpError(415, "Content-Type must be application/json", "unsupported_media_type");
        }
        const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readJson(req) : {};
        const result = await matched.handler({ req, res, url, params: matched.params, body });
        if (!res.writableEnded) sendJson(res, result?.status ?? 200, result?.body ?? {}, result?.headers);
      } catch (error) {
        if (!res.writableEnded) {
          const payload = errorPayload(error);
          sendJson(res, payload.status, payload.body);
        }
      }
      return;
    }
    if (req.method === "GET" && serveStatic(res, path.join(config.root, "web"), url.pathname)) return;
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
      sendJson(res, 404, { error: { code: "not_found", message: "Endpoint not found" } });
      return;
    }
    if (req.method === "GET" && serveStatic(res, path.join(config.root, "web"), "/")) return;
    const payload = errorPayload(new HttpError(404, "Not found", "not_found"));
    sendJson(res, payload.status, payload.body);
  });

  return {
    server,
    db,
    config,
    services: { auth, gateway, knowledge, agent, platform, mcp, pythonAgent, semanticIndex, wikiCompiler, ingestQueue, lintService, wikiExport, wikiSync },
    stop: () => {
      clearInterval(mergeTimer);
      wikiCompiler.stop();
      pythonAgent.stop();
    },
  };
}

function publicPlan(plan) {
  return {
    ...plan,
    selected: plan.selected ? withoutSecret(plan.selected) : null,
    candidates: plan.candidates.map(withoutSecret),
  };
}

function withoutSecret(candidate) {
  const { api_key, legacy_api_key, ...safe } = candidate;
  return safe;
}
