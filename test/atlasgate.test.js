import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { splitDocument } from "../src/services/knowledge.js";
import { activateKnowledgeTab } from "../web/knowledge-tabs.js";

function fixture() {
  return createApp({ dbPath: ":memory:", devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
}

function fileFixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-test-"));
  const app = createApp({ dbPath: path.join(directory, "atlasgate.db"), devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "", ...overrides });
  t.after(() => {
    app.stop();
    app.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return app;
}

test("knowledge chunker hard-splits oversized wiki sections and records hierarchy metadata", () => {
  const newline = String.fromCharCode(10);
  const content = `# 运营规范${newline}${newline}## 告警处理${newline}${newline}${"企业告警处理流程。".repeat(180)}`;
  const chunks = splitDocument(content, 180, 30);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((chunk) => chunk.char_count <= 180));
  assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), chunks.map((_, index) => index));
  assert.ok(chunks.every((chunk) => chunk.heading_path === "运营规范 / 告警处理"));
  assert.ok(chunks.every((chunk) => chunk.char_count === chunk.content.length));
});

test("gateway authenticates, routes vision requests and records evidence", async (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const unauthorized = await fetch(`${base}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-key" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: [{ type: "text", text: "read" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.model, "atlas-vision");
  assert.match(response.headers.get("x-atlas-routing-decision-id"), /^rtd_/);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM routing_decisions").get().count, 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM usage_logs").get().count, 1);
});

test("knowledge batch merge applies newest change and marks conflict", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Policy", merge_batch_size: 10 });
  knowledge.submitChange(kb.id, { path: "limits.md", content: "Limit is 10.", author: "alice" });
  knowledge.submitChange(kb.id, { path: "limits.md", content: "Limit is 20 and this is current.", author: "bob" });

  const result = knowledge.merge(kb.id, "Resolve concurrent policy edits");
  assert.equal(result.version, 2);
  assert.equal(result.change_count, 2);
  assert.equal(result.conflict_count, 1);
  const document = app.db.prepare("SELECT content FROM knowledge_documents WHERE kb_id=? AND version=2 AND path='limits.md'").get(kb.id);
  assert.equal(document.content, "Limit is 20 and this is current.");
  assert.equal(knowledge.search(kb.id, "current limit", { top_k: 1 })[0].version, 2);
});

test("agent memory is neither read nor written without explicit opt-in", async (t) => {
  const app = fileFixture(t);
  const agent = app.services.agent;
  const input = { kb_id: "kb_atlas_handbook", question: "How does memory work?", session_id: "session-a" };

  const privateRun = await agent.ask({ ...input, use_memory: false });
  assert.equal(privateRun.runtime, "python");
  assert.equal(privateRun.memory.enabled, false);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 0);

  const rememberedRun = await agent.ask({ ...input, use_memory: true });
  assert.equal(rememberedRun.memory.stored, true);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 1);
  const recalledRun = await agent.ask({ ...input, use_memory: true });
  assert.ok(recalledRun.memory.recalled >= 1);
});

test("Python Agent bridge preserves Chinese UTF-8 and rejects zero-score evidence", async (t) => {
  const app = fileFixture(t);
  const knowledge = app.services.knowledge;
  knowledge.submitChange("kb_atlas_handbook", {
    path: "policies/expense.md",
    content: "公司报销规则：交通费用上限为二百元。",
    author: "tester",
  });
  knowledge.merge("kb_atlas_handbook", "Add Chinese policy");

  const relevant = await app.services.agent.ask({
    kb_id: "kb_atlas_handbook",
    question: "交通费用上限是多少？",
    use_memory: false,
  });
  assert.equal(relevant.runtime, "python");
  assert.ok(relevant.sources.some((source) => source.snippet.includes("交通费用上限为二百元")));
  assert.equal(relevant.answer.includes("�"), false);

  const unrelated = await app.services.agent.ask({
    kb_id: "kb_atlas_handbook",
    question: "1+1等于几",
    use_memory: false,
  });
  assert.deepEqual(unrelated.sources, []);
  assert.match(unrelated.answer, /没有找到足够相关的证据/);
});

test("MCP exposes governed knowledge tools", async (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const response = await app.services.mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "knowledge_search", "knowledge_ask", "knowledge_graph", "knowledge_submit_change",
    "knowledge_merge", "memory_list", "skill_list",
    "wiki_ingest", "wiki_reviews_list", "wiki_reviews_resolve",
    "wiki_lint_run", "wiki_lint_list",
  ]);
});

test("gateway serves OpenAI Responses, Anthropic Messages, embeddings and SSE", async (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { "content-type": "application/json", authorization: "Bearer test-key" };

  const responses = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "atlas-mini", input: "hello" }) });
  const responsePayload = await responses.json();
  assert.equal(responsePayload.object, "response");
  assert.match(responsePayload.output_text, /hello/);

  const messages = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "atlas-mini", max_tokens: 100, messages: [{ role: "user", content: "你好" }] }) });
  const messagePayload = await messages.json();
  assert.equal(messagePayload.type, "message");
  assert.equal(messagePayload.role, "assistant");

  const embeddings = await fetch(`${base}/v1/embeddings`, { method: "POST", headers, body: JSON.stringify({ model: "atlas-mini", input: ["alpha", "beta"] }) });
  const embeddingPayload = await embeddings.json();
  assert.equal(embeddingPayload.data.length, 2);
  assert.equal(embeddingPayload.data[0].embedding.length, 96);

  const stream = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "atlas-mini", stream: true, messages: [{ role: "user", content: "stream me" }] }) });
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const streamText = await stream.text();
  assert.match(streamText, /chat\.completion\.chunk/);
  assert.match(streamText, /\[DONE\]/);
});

test("console management APIs require an admin session, independent of client API keys", async (t) => {
  const app = fileFixture(t, { adminUsername: "console-admin", adminPassword: "console-secret" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const unauthorized = await fetch(`${base}/api/overview`);
  assert.equal(unauthorized.status, 401);

  const wrong = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "console-admin", password: "wrong" }) });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "console-admin", password: "console-secret" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /atlasgate_admin_session=/);

  const authorized = await fetch(`${base}/api/overview`, { headers: { cookie } });
  assert.equal(authorized.status, 200);
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json();
  assert.equal(session.user.username, "console-admin");

  const changed = await fetch(`${base}/api/auth/password`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ current_password: "console-secret", new_password: "console-secret-rotated" }) });
  assert.equal(changed.status, 200);
  assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "console-admin", password: "console-secret" }) })).status, 401);
  assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "console-admin", password: "console-secret-rotated" }) })).status, 200);
  assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie } })).status, 200);

  const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer test-key" } })).status, 200);
});

test("gateway fails over between mapped providers and records every attempt", async (t) => {
  const failing = http.createServer((_req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "first failed" } })); });
  const healthy = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "chatcmpl-upstream", object: "chat.completion", model: "shared-upstream", choices: [{ index: 0, message: { role: "assistant", content: "failover worked" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })); });
  await Promise.all([new Promise((resolve) => failing.listen(0, "127.0.0.1", resolve)), new Promise((resolve) => healthy.listen(0, "127.0.0.1", resolve))]);
  t.after(() => Promise.all([new Promise((resolve) => failing.close(resolve)), new Promise((resolve) => healthy.close(resolve))]));
  const app = fixture();
  t.after(() => app.db.close());
  app.services.gateway.createProvider({ name: "Fail first", kind: "openai", base_url: `http://127.0.0.1:${failing.address().port}/v1`, models: ["shared-upstream"], quality: 1 });
  app.services.gateway.createProvider({ name: "Healthy second", kind: "openai", base_url: `http://127.0.0.1:${healthy.address().port}/v1`, models: ["shared-upstream"], quality: 0.1 });
  const result = await app.services.gateway.complete({ model: "shared-upstream", messages: [{ role: "user", content: "route" }] });
  assert.equal(result.response.choices[0].message.content, "failover worked");
  const attempts = app.services.gateway.listAttempts();
  assert.equal(attempts.length, 2);
  assert.equal(attempts.some((attempt) => attempt.status === 502 && attempt.retryable === 1), true);
  assert.equal(result.headers["x-atlas-attempts"], "2");
});

test("tenant keys enforce scopes, model allowlists and request rates", async (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const organization = app.services.platform.createOrganization({ name: "Acme", monthly_budget_cents: 1000 });
  const team = app.services.platform.createTeam({ name: "Research", organization_id: organization.id, monthly_budget_cents: 500 });
  const user = app.services.platform.createUser({ email: "alice@example.test", display_name: "Alice" });
  app.services.platform.addTeamMember(team.id, { user_id: user.id, role: "member" });
  const issued = app.services.gateway.createKey({ name: "restricted", team_id: team.id, user_id: user.id, scopes: ["gateway:invoke"], allowed_models: ["atlas-mini"], requests_per_minute: 1 });
  const key = app.services.gateway.authenticate({ headers: { authorization: `Bearer ${issued.key}` } });
  await app.services.gateway.complete({ model: "atlas-mini", messages: [{ role: "user", content: "one" }] }, { apiKey: key });
  await assert.rejects(() => app.services.gateway.complete({ model: "atlas-mini", messages: [{ role: "user", content: "two" }] }, { apiKey: key }), /rate limit/i);
  const other = app.services.gateway.createKey({ name: "model-restricted", allowed_models: ["atlas-mini"] });
  const otherKey = app.services.gateway.authenticate({ headers: { "x-api-key": other.key } });
  await assert.rejects(() => app.services.gateway.complete({ model: "atlas-vision", messages: [{ role: "user", content: "no" }] }, { apiKey: otherKey }), /not allowed/i);
  const wrongScope = app.services.gateway.createKey({ name: "wrong-scope", scopes: ["knowledge:read"] });
  assert.throws(() => app.services.gateway.authenticate({ headers: { authorization: `Bearer ${wrongScope.key}` } }), /lacks scope/i);
});

test("client keys can be revoked, restored and removed while usage evidence is retained", async (t) => {
  const app = fixture();
  t.after(() => { app.stop(); app.db.close(); });
  const issued = app.services.gateway.createKey({ name: "Disposable client" });
  const configured = app.services.gateway.createKey({ name: "Configured client", scopes: ["gateway:invoke"], allowed_models: ["atlas-mini"], requests_per_minute: 7, tokens_per_minute: 7000, quota_tokens: 70000, monthly_budget_cents: 321, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.deepEqual({ scopes: configured.scopes, allowed_models: configured.allowed_models, requests_per_minute: configured.requests_per_minute, tokens_per_minute: configured.tokens_per_minute, quota_tokens: configured.quota_tokens, monthly_budget_cents: configured.monthly_budget_cents }, { scopes: ["gateway:invoke"], allowed_models: ["atlas-mini"], requests_per_minute: 7, tokens_per_minute: 7000, quota_tokens: 70000, monthly_budget_cents: 321 });
  assert.throws(() => app.services.gateway.createKey({ name: "Past client", expires_at: new Date(Date.now() - 1000).toISOString() }), /future date/i);
  const authenticated = app.services.gateway.authenticate({ headers: { authorization: `Bearer ${issued.key}` } });
  await app.services.gateway.complete({ model: "atlas-mini", messages: [{ role: "user", content: "record usage" }] }, { apiKey: authenticated });

  assert.equal(app.services.gateway.setKeyEnabled(issued.id, false).enabled, false);
  assert.throws(() => app.services.gateway.authenticate({ headers: { authorization: `Bearer ${issued.key}` } }), /invalid api key/i);
  assert.equal(app.services.gateway.setKeyEnabled(issued.id, true).enabled, true);
  assert.equal(app.services.gateway.authenticate({ headers: { authorization: `Bearer ${issued.key}` } }).id, issued.id);

  const removed = app.services.gateway.deleteKey(issued.id);
  assert.equal(removed.deleted, true);
  assert.equal(removed.retained_usage_logs, 1);
  assert.equal(app.services.gateway.listKeys().some((item) => item.id === issued.id), false);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM usage_logs WHERE api_key_id=?").get(issued.id).count, 1);
  assert.throws(() => app.services.gateway.authenticate({ headers: { authorization: `Bearer ${issued.key}` } }), /invalid api key/i);
  app.services.gateway.deleteKey(configured.id);
});

test("audit ledger attributes each request to its client key", async (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const issued = app.services.gateway.createKey({ name: "Ledger attribution", scopes: ["gateway:invoke"] });
  const authenticated = app.services.gateway.authenticate({ headers: { authorization: `Bearer ${issued.key}` } });
  await app.services.gateway.complete({ model: "atlas-mini", messages: [{ role: "user", content: "ping" }] }, { apiKey: authenticated });
  const logs = app.services.platform.logs(10);
  const row = logs.find((item) => item.api_key_name === "Ledger attribution");
  assert.ok(row, "ledger must expose the calling key name");
  assert.ok(issued.key.startsWith(row.api_key_prefix), "ledger prefix must match the issued key");
  app.services.gateway.deleteKey(issued.id);
});

test("knowledge imports UTF-8 text and PDF then builds a versioned relationship graph", async (t) => {
  const app = fileFixture(t);
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Imported", merge_batch_size: 20 });
  const markdown = "# 支付规则\n\n#finance\n\n参见 [[退款流程]]。";
  await knowledge.importDocument(kb.id, { filename: "rules.md", data_base64: Buffer.from(markdown).toString("base64"), author: "alice" });
  await knowledge.importDocument(kb.id, { filename: "refund.md", text: "# 退款流程\n\n退款在三天内完成。", author: "bob" });
  const pdf = minimalTextPdf("PDF risk policy evidence");
  const pdfImport = await knowledge.importDocument(kb.id, { filename: "risk.pdf", data_base64: pdf.toString("base64"), author: "alice" });
  assert.equal(pdfImport.pages, 1);
  knowledge.merge(kb.id, "Publish imported corpus");
  assert.match(knowledge.getDocument(kb.id, "risk.pdf").content, /PDF risk policy evidence/);
  assert.match(knowledge.getDocument(kb.id, "rules.md").content, /支付规则/);
  const graph = knowledge.graph(kb.id);
  assert.ok(graph.nodes.some((node) => node.kind === "tag" && node.label === "finance"));
  assert.ok(graph.nodes.some((node) => node.kind === "heading" && node.label === "支付规则"));
  assert.ok(graph.edges.some((edge) => edge.relation === "links_to"));
});

test("knowledge uses optimistic revisions and persists latest-wins conflicts", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Collaborative", merge_batch_size: 20, owner_id: "alice" });
  knowledge.setCollaborator(kb.id, "bob", "editor");
  const first = knowledge.submitChange(kb.id, { path: "policy.md", content: "A", author: "alice" }).change;
  const revised = knowledge.updateChange(kb.id, first.id, { content: "B", author: "bob", expected_revision: 1 });
  assert.equal(revised.revision, 2);
  assert.throws(() => knowledge.updateChange(kb.id, first.id, { content: "stale", author: "alice", expected_revision: 1 }), /modified by another editor/i);
  knowledge.submitChange(kb.id, { path: "policy.md", content: "C", author: "alice", base_version: 1 });
  const merged = knowledge.merge(kb.id, "Resolve concurrent edits");
  assert.equal(merged.conflict_count, 1);
  assert.equal(knowledge.getDocument(kb.id, "policy.md").content, "C");
  assert.equal(knowledge.listConflicts(kb.id)[0].resolution, "latest_submitted_wins");
  assert.equal(knowledge.listChangeRevisions(kb.id, first.id).length, 2);
});

test("knowledge scheduler publishes aged changes and retains delete tombstones", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Scheduled", ingest_mode: "auto", merge_batch_size: 20, merge_interval_minutes: 1 });
  knowledge.submitChange(kb.id, { path: "old.md", content: "temporary", author: "local-user" });
  app.db.prepare("UPDATE knowledge_changes SET created_at=? WHERE kb_id=?").run(new Date(Date.now() - 120_000).toISOString(), kb.id);
  assert.equal(knowledge.mergeDueBases()[0].version, 2);
  knowledge.submitChange(kb.id, { path: "old.md", operation: "delete", author: "local-user" });
  knowledge.merge(kb.id, "Forget deleted knowledge");
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM knowledge_tombstones WHERE kb_id=?").get(kb.id).count, 1);
  assert.throws(() => knowledge.getDocument(kb.id, "old.md"), /not found/i);
});

test("knowledge scheduler never auto-merges review-mode bases (Q4)", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Scheduled Review", ingest_mode: "review", merge_batch_size: 1, merge_interval_minutes: 1 });
  knowledge.submitChange(kb.id, { path: "r1.md", content: "review me", author: "local-user" });
  app.db.prepare("UPDATE knowledge_changes SET created_at=? WHERE kb_id=?").run(new Date(Date.now() - 120_000).toISOString(), kb.id);
  assert.equal(knowledge.mergeDueBases().length, 0, "review-mode changes must stay pending for human review");
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes WHERE kb_id=? AND status='pending'").get(kb.id).count, 1);
});

test("memory forgetting and skill version history are explicit", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const agent = app.services.agent;
  const memory = agent.createMemory({ session_id: "s1", content: "prefer concise answers", importance: 0.9 });
  assert.equal(agent.listMemories({ session_id: "s1" }).length, 1);
  agent.forgetMemory(memory.id, "user request");
  assert.equal(agent.listMemories({ session_id: "s1" }).length, 0);
  const skill = agent.createSkill({ name: "policy-review", description: "Review policy", instructions: "Check evidence first." });
  const updated = agent.updateSkill(skill.id, { instructions: "Check evidence and dates first." });
  assert.equal(updated.version, "1.0.1");
  assert.equal(agent.skillVersions(skill.id).length, 2);
  assert.equal(agent.recommendSkills("review policy evidence")[0].id, skill.id);
});

test("knowledge tabs switch all six active buttons and visible panels", () => {
  const names = ["changes", "versions", "documents", "import", "graph", "conflicts"];
  const buttons = names.map((name) => fakeTab(name));
  const panels = names.map((name) => ({ dataset: { knowledgePanel: name }, hidden: false }));
  const root = {
    querySelectorAll(selector) {
      return selector === "[data-knowledge-tab]" ? buttons : panels;
    },
  };

  assert.equal(activateKnowledgeTab(root, "versions"), "versions");
  assert.equal(buttons[1].active, true);
  assert.equal(buttons[1].attributes["aria-selected"], "true");
  assert.equal(panels[0].hidden, true);
  assert.equal(panels[1].hidden, false);
  assert.equal(panels[2].hidden, true);

  activateKnowledgeTab(root, "documents");
  assert.equal(buttons[2].active, true);
  assert.equal(panels[2].hidden, false);
  for (const [index, name] of names.entries()) {
    activateKnowledgeTab(root, name);
    assert.equal(buttons[index].active, true);
    assert.equal(panels[index].hidden, false);
  }
});

test("Python Agent uses a bounded persistent worker pool", async (t) => {
  const app = fileFixture(t);
  const bridge = app.services.pythonAgent;
  const request = { kb_id: "kb_atlas_handbook", question: "How does routing work?", use_memory: false };
  const first = await bridge.prepare(request);
  const started = bridge.status().started;
  const second = await bridge.prepare(request);
  assert.ok(first.sources.length > 0);
  assert.ok(second.sources.length > 0);
  assert.equal(bridge.status().started, started);
  assert.equal(bridge.status().requests, 2);
  assert.equal(bridge.status().configured_size, 2);
  assert.equal(bridge.status().queued, 0);
});

test("Python pool fails fast and backs off when the worker binary is missing", async (t) => {
  const app = fileFixture(t, { pythonCommand: "definitely-not-a-real-python-binary" });
  const bridge = app.services.pythonAgent;
  const request = { kb_id: "kb_atlas_handbook", question: "ping", use_memory: false };
  await assert.rejects(
    app.services.agent.ask(request),
    (error) => error.code === "python_agent_unavailable" || error.code === "python_agent_timeout",
  );
  const started = bridge.metrics.started;
  await assert.rejects(
    app.services.agent.ask(request),
    (error) => error.code === "python_agent_unavailable",
  );
  assert.equal(bridge.status().state, "unhealthy", "pool must mark itself unhealthy after consecutive spawn failures");
  // No runaway respawn: worker spawn attempts must stay bounded while unhealthy.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.ok(bridge.metrics.started - started <= 4, `respawn attempts must be bounded, grew by ${bridge.metrics.started - started}`);
});

test("Skill packages import from SKILL.md and reject duplicate versions", (t) => {
  const app = fixture();
  t.after(() => { app.stop(); app.db.close(); });
  const markdown = `---\nname: incident-triage\ndescription: Triage production incidents\nversion: 1.0.0\nscope: team\n---\nCheck impact, evidence, and rollback safety.`;
  const body = { filename: "SKILL.md", data_base64: Buffer.from(markdown).toString("base64"), author: "tester" };
  const imported = app.services.agent.importSkill(body);
  assert.equal(imported.skill.name, "incident-triage");
  assert.equal(imported.import.status, "imported");
  assert.throws(() => app.services.agent.importSkill(body), /already exists/i);
  assert.equal(app.services.agent.listSkillImports().filter((item) => item.filename === "SKILL.md").length, 2);
});

test("agent status exposes the actual routed model and execution mode", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const status = app.services.agent.status("auto");
  assert.equal(status.provider_name, "Local Demo Model");
  assert.equal(status.model, "atlas-mini");
  assert.equal(status.execution_mode, "local_extractive");
  assert.equal(status.agent_runtime, "python");
});

test("auto routing prefers a real provider over the demo provider", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  app.services.gateway.createProvider({
    name: "Test Upstream",
    kind: "openai",
    base_url: "http://127.0.0.1:9999/v1",
    models: ["test-model"],
    quality: 0.1,
    latency_hint_ms: 60_000,
    reliability: 0.1,
  });
  const status = app.services.agent.status("auto");
  assert.equal(status.provider_name, "Test Upstream");
  assert.equal(status.model, "test-model");
  assert.equal(status.execution_mode, "llm");
});

test("knowledge bases and pending changes support update and delete", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Draft KB", merge_batch_size: 10 });
  const updatedKb = knowledge.updateKnowledgeBase(kb.id, { name: "Policy KB", description: "Current policies" });
  assert.equal(updatedKb.name, "Policy KB");
  assert.equal(updatedKb.description, "Current policies");

  const submitted = knowledge.submitChange(kb.id, { path: "policy.md", content: "Version one", author: "alice" });
  const updatedChange = knowledge.updateChange(kb.id, submitted.change.id, { content: "Version two", author: "bob" });
  assert.equal(updatedChange.content, "Version two");
  assert.equal(updatedChange.author, "bob");
  assert.equal(knowledge.deleteChange(kb.id, submitted.change.id).deleted, true);
  assert.equal(knowledge.listChanges(kb.id).length, 0);
  assert.equal(knowledge.deleteKnowledgeBase(kb.id).deleted, true);
  assert.throws(() => knowledge.getKnowledgeBase(kb.id), /not found/i);
});

test("master document edits and deletes are published through versioned changes", (t) => {
  const app = fixture();
  t.after(() => app.db.close());
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Documents", merge_batch_size: 10 });
  knowledge.submitChange(kb.id, { path: "guide.md", content: "Original", author: "alice" });
  knowledge.merge(kb.id, "Create document");
  assert.equal(knowledge.getDocument(kb.id, "guide.md").content, "Original");

  const edit = knowledge.submitChange(kb.id, { path: "guide.md", content: "Revised", author: "alice" });
  knowledge.updateChange(kb.id, edit.change.id, { content: "Revised final" });
  knowledge.merge(kb.id, "Edit document");
  assert.equal(knowledge.getDocument(kb.id, "guide.md").content, "Revised final");

  knowledge.submitChange(kb.id, { path: "guide.md", operation: "delete", author: "alice" });
  knowledge.merge(kb.id, "Delete document");
  assert.throws(() => knowledge.getDocument(kb.id, "guide.md"), /not found/i);
});

test("Provider deletion cascades live configuration without exposing credentials", (t) => {
  const app = fixture();
  t.after(() => { app.stop(); app.db.close(); });
  const provider = app.services.gateway.createProvider({
    name: "Disposable", kind: "openai", base_url: "https://example.test/v1",
    models: ["temporary-model"], api_key: "test-secret-never-return",
  });
  assert.equal(provider.has_api_key, false);
  assert.equal(JSON.stringify(provider).includes("test-secret-never-return"), false);
  assert.equal(app.services.gateway.listCredentials(provider.id)[0].has_api_key, true);
  assert.equal(JSON.stringify(app.services.gateway.listCredentials(provider.id)).includes("test-secret-never-return"), false);
  const deleted = app.services.gateway.deleteProvider(provider.id);
  assert.equal(deleted.deleted, true);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM model_mappings WHERE provider_id=?").get(provider.id).count, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM provider_credentials WHERE provider_id=?").get(provider.id).count, 0);
  assert.throws(() => app.services.gateway.deleteProvider("prv_local_demo"), /cannot be deleted/i);
});

test("Provider balance normalizes payloads and keeps the last amount on failure", async (t) => {
  let fail = false;
  const upstream = http.createServer((_req, res) => {
    if (fail) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "temporary outage" } })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "88.50" }], is_available: true }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const app = fixture();
  t.after(() => { app.stop(); app.db.close(); });
  const provider = app.services.gateway.createProvider({
    name: "Balance test", kind: "openai", base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    balance_endpoint: `http://127.0.0.1:${upstream.address().port}/balance`, models: ["balance-model"], api_key: "fake-key",
  });
  const balance = await app.services.gateway.refreshProviderBalance(provider.id);
  assert.equal(balance.amount, 88.5);
  assert.equal(balance.currency, "CNY");
  fail = true;
  await assert.rejects(() => app.services.gateway.refreshProviderBalance(provider.id), /temporary outage/i);
  const afterFailure = app.services.gateway.listProviders().find((item) => item.id === provider.id).balance;
  assert.equal(afterFailure.amount, 88.5);
  assert.equal(afterFailure.status, "unavailable");
});

test("dashboard overview returns range-aware trends and real team distributions", async (t) => {
  const app = fixture();
  t.after(() => { app.stop(); app.db.close(); });
  const organization = app.services.platform.createOrganization({ name: "Dashboard Org" });
  const team = app.services.platform.createTeam({ name: "Research", organization_id: organization.id });
  const issued = app.services.gateway.createKey({ name: "dashboard-key", team_id: team.id });
  const apiKey = app.services.gateway.authenticate({ headers: { authorization: `Bearer ${issued.key}` } });
  await app.services.gateway.complete({ model: "atlas-mini", messages: [{ role: "user", content: "dashboard evidence" }] }, { apiKey });

  const day = app.services.platform.overview("24h");
  assert.equal(day.range, "24h");
  assert.equal(day.trend.length, 24);
  assert.ok(day.trend.some((bucket) => bucket.requests === 1));
  assert.equal(day.distributions.teams[0].label, "Research");
  assert.ok(day.distributions.models.some((item) => item.label === "atlas-mini"));
  assert.equal(typeof day.distributions.models[0].spend_cents, "number");
  assert.equal(app.services.platform.overview("30d").trend.length, 30);
  assert.equal(app.services.platform.overview("unsupported").range, "7d");
});

test("model mappings support edit, diagnostic simulation and deletion", (t) => {
  const app = fixture();
  t.after(() => { app.stop(); app.db.close(); });
  const provider = app.services.gateway.createProvider({
    name: "Routing test", kind: "openai", base_url: "https://routing.example.test/v1",
    models: ["upstream-v1"], supports_vision: true, quality: 0.91,
  });
  const original = app.services.gateway.listMappings().find((item) => item.provider_id === provider.id);
  const updated = app.services.gateway.updateMapping(original.id, {
    alias: "enterprise-chat", upstream_model: "upstream-v2", priority: 3, capabilities: ["text"],
  });
  assert.equal(updated.alias, "enterprise-chat");
  assert.equal(updated.priority, 3);

  const routed = app.services.gateway.simulate({ model: "enterprise-chat", messages: [{ role: "user", content: "route me" }] });
  assert.equal(routed.status, "routable");
  assert.equal(routed.selected.model, "upstream-v2");
  assert.equal(typeof routed.selected.signals.reliability, "number");

  const noVisionRoute = app.services.gateway.simulate({
    model: "enterprise-chat",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
  });
  assert.equal(noVisionRoute.status, "no_route");
  assert.ok(noVisionRoute.excluded.some((item) => item.reason === "mapping_lacks_vision"));
  assert.equal(app.services.gateway.deleteMapping(original.id).deleted, true);
  assert.equal(app.services.gateway.listMappings().some((item) => item.id === original.id), false);
});

test("Qdrant mode indexes embedding vectors and supplies semantic evidence to the Agent", async (t) => {
  const points = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/embeddings") {
      res.end(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })) }));
      return;
    }
    if (req.method === "PUT" && /\/points\?wait=true$/.test(req.url)) {
      points.push(...body.points); res.end(JSON.stringify({ status: "ok", result: { status: "completed" } })); return;
    }
    if (req.method === "PUT" && req.url.startsWith("/collections/")) {
      res.end(JSON.stringify({ status: "ok", result: true })); return;
    }
    if (req.method === "POST" && /\/points\/search$/.test(req.url)) {
      res.end(JSON.stringify({ result: points.slice(0, body.limit).map((point) => ({ id: point.id, score: 0.93, payload: point.payload })) })); return;
    }
    res.writeHead(404); res.end(JSON.stringify({ status: { error: "not found" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const app = fileFixture(t, {
    retrievalMode: "qdrant", embeddingBaseUrl: `${base}/v1`, embeddingModel: "mock-embed",
    embeddingDimensions: 4, qdrantUrl: base,
  });
  const indexed = await app.services.semanticIndex.indexVersion("kb_atlas_handbook", 1);
  assert.ok(indexed.pages > 0, "page-level vectors must be indexed");
  assert.equal(indexed.dimensions, 4);
  const sources = await app.services.semanticIndex.search("kb_atlas_handbook", "routing");
  assert.equal(sources[0].retrieval_mode, "semantic_qdrant");
  const run = await app.services.agent.ask({ kb_id: "kb_atlas_handbook", question: "How does routing work?", use_memory: false });
  assert.equal(run.retrieval_mode, "semantic_qdrant");
  assert.ok(run.sources.length > 0);
  assert.equal(app.services.semanticIndex.listJobs("kb_atlas_handbook")[0].status, "ready");
});

function fakeTab(name) {
  const tab = {
    dataset: { knowledgeTab: name },
    attributes: {},
    active: false,
    tabIndex: 0,
    classList: {
      toggle(_className, active) { this.owner.active = active; },
      owner: null,
    },
    setAttribute(attribute, value) { this.attributes[attribute] = value; },
  };
  tab.classList.owner = tab;
  return tab;
}

function minimalTextPdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}
