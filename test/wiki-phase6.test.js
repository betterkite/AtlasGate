// RAG phase 2 (docs/RAG_PLAN.md, Q8C + Q9): structural pseudo-rerank and
// zero-evidence query rewriting.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const ANALYSIS_JSON = JSON.stringify({
  key_entities: [], key_concepts: [], arguments: [], connections: [], contradictions: [],
  page_plan: [], review_items: [], research_queries: [], privacy_flags: [],
});

// Scripted provider distinguishing analysis / generation / rewrite / answer
// calls by prompt markers.
function scriptedProvider(t, { rewriteTo, pageContent }) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      const text = (payload.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      let content;
      if (text.includes("STAGE: analysis")) content = ANALYSIS_JSON;
      else if (text.includes("GENERATION stage")) content = JSON.stringify({ pages: [{
        path: "sources/story.md",
        content: `---\ntype: source\ntitle: Story\nsources: ["raw/story.md"]\nconfidence: EXTRACTED\ntags: []\n---\n${pageContent}`,
      }] });
      else if (text.includes("检索查询改写器")) content = rewriteTo;
      else content = "改写后检索命中的综合回答。";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test", object: "chat.completion", created: 0, model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}/v1`);
    });
  });
}

function fileApp(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki6-"));
  const dbPath = path.join(directory, "atlasgate.db");
  const app = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "", ...overrides });
  t.after(() => { app.stop(); app.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return app;
}

async function waitForQueue(app, kbId, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await app.services.ingestQueue.list(kbId);
    if (!rows.some((row) => row.status === "pending" || row.status === "running")) return rows;
    if (Date.now() > deadline) throw new Error(`ingest queue did not drain`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

// Material whose vocabulary shares nothing with the test question, so the
// first retrieval round finds zero evidence and triggers rewriting.
const MATERIAL = "甲戌年冬月，向顶天在枯井底发现半块石壁。";
const QUESTION = "脱锚副作用是什么";

test("zero-evidence question is rewritten once and retrieves evidence on retry", async (t) => {
  const llmBase = await scriptedProvider(t, { rewriteTo: "向顶天 枯井 石壁", pageContent: MATERIAL });
  const app = fileApp(t);
  app.services.gateway.createProvider({
    name: "Scripted", kind: "openai", base_url: llmBase,
    models: ["compile-model"], quality: 0.9, latency_hint_ms: 50, reliability: 0.99,
  });
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Rewrite", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "story.md", text: MATERIAL });
  await waitForQueue(app, kb.id);
  const result = await app.services.agent.ask({ kb_id: kb.id, question: QUESTION });
  assert.ok(result.sources.length > 0, "rewritten query must retrieve evidence");
  assert.equal(result.rewritten_question, "向顶天 枯井 石壁", "rewritten question must be reported");
  assert.equal(result.retrieval_mode, "page");
});

test("rewriting is skipped without a real provider (mock routing)", async (t) => {
  const app = fileApp(t); // only the built-in demo mock provider
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Rewrite Mock", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "story.md", text: MATERIAL });
  await waitForQueue(app, kb.id);
  const result = await app.services.agent.ask({ kb_id: kb.id, question: QUESTION });
  assert.equal(result.rewritten_question, null, "mock routing must not rewrite");
  assert.equal(result.sources.length, 0);
  assert.match(result.answer, /证据/i, "falls back to the no-evidence answer");
});

test("rewriting can be disabled via config", async (t) => {
  const llmBase = await scriptedProvider(t, { rewriteTo: "向顶天 枯井 石壁", pageContent: MATERIAL });
  const app = fileApp(t, { queryRewriteEnabled: false });
  app.services.gateway.createProvider({
    name: "Scripted", kind: "openai", base_url: llmBase,
    models: ["compile-model"], quality: 0.9, latency_hint_ms: 50, reliability: 0.99,
  });
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Rewrite Off", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "story.md", text: MATERIAL });
  await waitForQueue(app, kb.id);
  const result = await app.services.agent.ask({ kb_id: kb.id, question: QUESTION });
  assert.equal(result.rewritten_question, null);
  assert.equal(result.sources.length, 0);
});
