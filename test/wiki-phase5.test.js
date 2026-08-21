// RAG phase 1 (docs/RAG_PLAN.md): dense vectors + hybrid RRF retrieval.
// Covers: enabled()/degradation, page-level indexing (semantic_vectors),
// whole-page search with system/degraded exclusion, and the agent ask path
// reporting hybrid mode.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { tokenize } from "../src/core/utils.js";

// Deterministic mock embedding server: bag-of-bigrams vector, normalized.
// Semantically it is lexical-hash based, but it exercises the full dense
// pipeline (embed -> index -> search) without external dependencies.
function mockVector(text, dims = 512) {
  const vec = new Array(dims).fill(0);
  for (const token of tokenize(String(text ?? ""))) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vec[Math.abs(hash) % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function mockEmbeddingServer(t) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!req.url.endsWith("/embeddings")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const payload = JSON.parse(raw || "{}");
      const input = typeof payload.input === "string" ? [payload.input] : (payload.input ?? []);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "list", model: payload.model,
        data: input.map((text, index) => ({ object: "embedding", index, embedding: mockVector(text) })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
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

// Mock LLM compile provider: analysis returns a fixed plan; generation returns
// one real compiled source page whose body is the given pageContent.
function scriptedProvider(t, pageContent) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      const text = (payload.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const content = text.includes("STAGE: analysis")
        ? JSON.stringify({ key_entities: [], key_concepts: [], arguments: [], connections: [], contradictions: [], page_plan: [], review_items: [], research_queries: [], privacy_flags: [] })
        : JSON.stringify({ pages: [{
          path: "sources/demo.md",
          content: `---\ntype: source\ntitle: Demo\nsources: ["raw/demo.md"]\nconfidence: EXTRACTED\ntags: []\n---\n${pageContent}`,
        }] });
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

async function compiledApp(t, { retrievalMode = "hybrid", embeddingBaseUrl, pageContent, kbName }) {
  const llmBase = await scriptedProvider(t, pageContent);
  const app = fileApp(t, { retrievalMode, embeddingBaseUrl });
  app.services.gateway.createProvider({
    name: "Scripted Compiler", kind: "openai", base_url: llmBase,
    models: ["compile-model"], quality: 0.9, latency_hint_ms: 50, reliability: 0.99,
  });
  const kb = app.services.knowledge.createKnowledgeBase({ name: kbName ?? "Dense", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "demo.md", text: pageContent });
  await waitForQueue(app, kb.id);
  return { app, kb };
}

function fileApp(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki5-"));
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

test("hybrid mode enables only when an embedding service is configured", async (t) => {
  const baseUrl = await mockEmbeddingServer(t);
  const withEmbedding = fileApp(t, { retrievalMode: "hybrid", embeddingBaseUrl: baseUrl });
  assert.equal(withEmbedding.services.semanticIndex.enabled(), true);
  assert.equal(withEmbedding.services.semanticIndex.backend(), "local");
  assert.equal(withEmbedding.services.semanticIndex.status().mode, "hybrid");
  const degraded = fileApp(t, { retrievalMode: "hybrid", embeddingBaseUrl: "" });
  assert.equal(degraded.services.semanticIndex.enabled(), false, "no embedding service must degrade to lexical");
  assert.equal(degraded.services.semanticIndex.status().enabled, false);
});

test("page-level indexing stores one vector per wiki page and searches whole pages", async (t) => {
  const baseUrl = await mockEmbeddingServer(t);
  const { app, kb } = await compiledApp(t, { embeddingBaseUrl: baseUrl, pageContent: "脱锚副作用与丹药反噬的关系。" });
  const { pages } = await app.services.semanticIndex.indexVersion(kb.id);
  const count = app.db.prepare("SELECT COUNT(*) AS c FROM semantic_vectors WHERE kb_id=? AND version=?").get(kb.id, app.services.knowledge.getKnowledgeBase(kb.id).master_version).c;
  assert.equal(count, pages, "one vector per page");
  const hits = await app.services.semanticIndex.search(kb.id, "脱锚 副作用", { top_k: 5, min_score: 0 });
  assert.ok(hits.length > 0, "search must return dense hits");
  for (const hit of hits) {
    assert.ok(hit.content.length > 0, "hits carry whole page content");
    assert.equal(hit.vector_score > 0, true);
    assert.equal(hit.retrieval_mode, "hybrid");
    assert.ok(!hit.path.startsWith("index.md") && !hit.path.startsWith("log.md"), "system pages excluded by default");
  }
});

test("hybrid search respects include_system and exclude_raw semantics", async (t) => {
  const baseUrl = await mockEmbeddingServer(t);
  const { app, kb } = await compiledApp(t, { embeddingBaseUrl: baseUrl, pageContent: "向顶天与石壁纹路的联系。" });
  await app.services.semanticIndex.indexVersion(kb.id);
  const plain = await app.services.semanticIndex.search(kb.id, "索引 目录", { top_k: 10, min_score: 0 });
  assert.equal(plain.some((hit) => hit.path === "index.md"), false);
  const withSystem = await app.services.semanticIndex.search(kb.id, "索引 目录", { top_k: 10, min_score: 0, include_system: true });
  assert.ok(withSystem.some((hit) => hit.path === "index.md"), "include_system surfaces system pages");
});

test("agent ask reports hybrid mode when dense is enabled and page mode when degraded", async (t) => {
  const baseUrl = await mockEmbeddingServer(t);
  const { app, kb } = await compiledApp(t, { embeddingBaseUrl: baseUrl, pageContent: "深层链接与语义检索。" });
  const result = await app.services.agent.ask({ kb_id: kb.id, question: "深层链接 语义 检索" });
  assert.equal(result.retrieval_mode, "hybrid");

  const degradedApp = fileApp(t, { retrievalMode: "hybrid", embeddingBaseUrl: "" });
  const kb2 = degradedApp.services.knowledge.createKnowledgeBase({ name: "Dense Agent 2", ingest_mode: "auto" });
  await degradedApp.services.wikiCompiler.enqueue(kb2.id, { kind: "paste", filename: "note2.md", text: "# Note2\n\n纯词法降级测试。" });
  await waitForQueue(degradedApp, kb2.id);
  const degradedResult = await degradedApp.services.agent.ask({ kb_id: kb2.id, question: "纯词法 降级" });
  assert.equal(degradedResult.retrieval_mode, "page", "no embedding service -> lexical page mode");
});
