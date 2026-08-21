import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const ANALYSIS_JSON = JSON.stringify({
  key_entities: [{ name: "AtlasGate", type: "product", summary: "LLM 网关", confidence: "EXTRACTED" }],
  key_concepts: [],
  arguments: [],
  connections: [],
  contradictions: [],
  page_plan: [
    { action: "create", path: "sources/demo.md", type: "source", title: "Demo 素材", rationale: "素材摘要" },
    { action: "create", path: "entities/atlasgate.md", type: "entity", title: "AtlasGate", rationale: "实体页" },
  ],
  review_items: [{ kind: "verify", payload: { claim: "需人工核实" }, suggested_action: "核实后放行" }],
  research_queries: ["AtlasGate wiki 架构"],
  privacy_flags: [],
});

const GENERATION_JSON = JSON.stringify({ pages: [
  {
    path: "sources/demo.md",
    content: "---\ntype: source\ntitle: Demo 素材\nsources: [\"raw/demo.md\"]\nconfidence: EXTRACTED\ntags: [demo]\n---\n# Demo 素材\n\n演示内容。",
  },
  {
    path: "entities/atlasgate.md",
    content: "---\ntype: entity\ntitle: AtlasGate\nsources: [\"raw/demo.md\"]\nconfidence: INFERRED\ntags: [llm]\n---\n# AtlasGate\n\n一个 LLM 网关。",
  },
] });

const GENERATION_WITH_DEFECTS = JSON.stringify({ pages: [
  {
    path: "sources/demo.md",
    content: "---\ntype: source\ntitle: Demo 素材\nsources: [\"raw/demo.md\"]\nconfidence: EXTRACTED\ntags: [demo]\n---\n# Demo 素材\n\n演示内容。",
  },
  { path: "../evil.md", content: "---\ntype: entity\ntitle: Evil\n---\n# Evil" },
  { path: "entities/leak.md", content: "---\ntype: entity\ntitle: Leak\nsources: [\"raw/demo.md\"]\nconfidence: EXTRACTED\ntags: []\n---\n# Leak\n\n密钥 sk-abcdefghijklmnopqrstuvwxyz123" },
] });

function scriptedProvider(t, script) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      const text = (payload.messages ?? []).map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
      const content = script(text, payload);
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki1-"));
  const dbPath = path.join(directory, "atlasgate.db");
  const app = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "", ...overrides });
  t.after(() => { app.stop(); app.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return app;
}

function addCompileProvider(app, baseUrl) {
  app.services.gateway.createProvider({
    name: "Scripted Compiler", kind: "openai", base_url: baseUrl,
    models: ["compile-model"], quality: 0.9, latency_hint_ms: 50, reliability: 0.99,
  });
}

async function waitForQueue(app, kbId, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await app.services.ingestQueue.list(kbId);
    if (!rows.some((row) => row.status === "pending" || row.status === "running")) return rows;
    if (Date.now() > deadline) throw new Error(`ingest queue did not drain: ${JSON.stringify(rows.map((row) => row.status))}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

test("ingest degrades to a raw staged page when only the demo provider is routed", async (t) => {
  const app = fileApp(t);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Degrade Test", ingest_mode: "review" });
  const result = await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "demo.md", text: "# Demo\n\n离线内容。", author: "tester" });
  assert.equal(result.skipped, false);
  const rows = await waitForQueue(app, kb.id);
  assert.equal(rows[0].status, "done");
  const source = app.db.prepare("SELECT * FROM wiki_sources WHERE kb_id=?").get(kb.id);
  assert.equal(source.status, "ingested");
  const pending = app.db.prepare("SELECT * FROM knowledge_changes WHERE kb_id=? AND status='pending'").all(kb.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].author, "wiki-compiler");
  assert.match(pending[0].path, /^sources\//);
  assert.ok(pending[0].batch_id);
  assert.equal(app.services.knowledge.getKnowledgeBase(kb.id).master_version, 1, "review mode must not merge");
});

test("degraded ingest auto-merges when ingest_mode is auto", async (t) => {
  const app = fileApp(t);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Degrade Auto", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "note.md", text: "# Note\n\n自动合并测试。" });
  await waitForQueue(app, kb.id);
  assert.equal(app.services.knowledge.getKnowledgeBase(kb.id).master_version, 2);
  const pages = app.services.knowledge.listPages(kb.id, {});
  assert.ok(pages.some((page) => page.path.startsWith("sources/")));
});

test("two-step compile stages batch changes, review items and research jobs", async (t) => {
  const baseUrl = await scriptedProvider(t, (text) => (text.includes("STAGE: analysis") ? ANALYSIS_JSON : GENERATION_JSON));
  const app = fileApp(t);
  addCompileProvider(app, baseUrl);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Compile Test", ingest_mode: "review" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "demo.md", text: "# Demo\n\nAtlasGate 是一个 LLM 网关。", author: "tester" });
  await waitForQueue(app, kb.id);

  const pending = app.db.prepare("SELECT * FROM knowledge_changes WHERE kb_id=? AND status='pending'").all(kb.id);
  assert.equal(pending.length, 2);
  assert.equal(new Set(pending.map((change) => change.batch_id)).size, 1, "compiler pages share one batch_id");
  const reviews = app.services.wikiCompiler.listReviews(kb.id, "open");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].kind, "verify");
  const research = app.db.prepare("SELECT * FROM research_jobs WHERE kb_id=?").all(kb.id);
  assert.equal(research.length, 1);
  assert.equal(app.services.knowledge.getKnowledgeBase(kb.id).master_version, 1, "review mode keeps changes pending");
});

test("auto ingest_mode merges compiler pages with derived wiki metadata", async (t) => {
  const baseUrl = await scriptedProvider(t, (text) => (text.includes("STAGE: analysis") ? ANALYSIS_JSON : GENERATION_JSON));
  const app = fileApp(t);
  addCompileProvider(app, baseUrl);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Compile Auto", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "demo.md", text: "# Demo\n\nAtlasGate 是一个 LLM 网关。" });
  await waitForQueue(app, kb.id);

  assert.equal(app.services.knowledge.getKnowledgeBase(kb.id).master_version, 2);
  const pages = app.services.knowledge.listPages(kb.id, {});
  const sourcePage = pages.find((page) => page.path === "sources/demo.md");
  assert.ok(sourcePage, "merged compiler page must exist");
  assert.equal(sourcePage.page_type, "source");
  assert.equal(sourcePage.confidence, "EXTRACTED");
  assert.deepEqual(sourcePage.sources, ["raw/demo.md"]);
  assert.equal(sourcePage.frontmatter.title, "Demo 素材");
  const entityPage = pages.find((page) => page.path === "entities/atlasgate.md");
  assert.equal(entityPage.page_type, "entity");
});

test("dedup skips identical source content", async (t) => {
  const app = fileApp(t);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Dedup Test" });
  const first = await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "a.md", text: "相同内容" });
  const second = await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "b.md", text: "相同内容" });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "duplicate_content");
  await waitForQueue(app, kb.id);
  const sources = app.db.prepare("SELECT COUNT(*) AS count FROM wiki_sources WHERE kb_id=?").get(kb.id).count;
  assert.equal(sources, 1);
  void first;
});

test("validation discards path violations and secrets, staging only valid pages", async (t) => {
  const baseUrl = await scriptedProvider(t, (text) => (text.includes("STAGE: analysis") ? ANALYSIS_JSON : GENERATION_WITH_DEFECTS));
  const app = fileApp(t);
  addCompileProvider(app, baseUrl);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Validation Test", ingest_mode: "review" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "demo.md", text: "# Demo\n\n内容。" });
  await waitForQueue(app, kb.id);

  const pending = app.db.prepare("SELECT * FROM knowledge_changes WHERE kb_id=? AND status='pending'").all(kb.id);
  assert.equal(pending.length, 1, "only the valid page is staged");
  assert.equal(pending[0].path, "sources/demo.md");
  const log = app.db.prepare("SELECT detail FROM wiki_log WHERE kb_id=? AND kind='ingest' ORDER BY created_at DESC LIMIT 1").get(kb.id);
  assert.match(log.detail, /discarded \(path_violation, secret_detected\)/);
});

test("running ingest jobs are recovered to pending after restart", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki1-"));
  const dbPath = path.join(directory, "atlasgate.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  const kb = first.services.knowledge.createKnowledgeBase({ name: "Recovery Test" });
  const now = new Date().toISOString();
  first.db.prepare(`INSERT INTO wiki_sources
    (id,kb_id,path,filename,media_type,content,content_hash,size_bytes,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    "src_recovery", kb.id, "raw/recovery.md", "recovery.md", "text/markdown", "content", "hash", 7, "queued", now,
  );
  first.db.prepare(`INSERT INTO ingest_queue
    (id,kb_id,source_id,kind,payload_json,status,attempt,created_at,started_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "inq_recovery", kb.id, "src_recovery", "paste", "{}", "running", 0, now, now,
  );
  first.stop();
  first.db.close();

  const second = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  const job = second.db.prepare("SELECT status,error FROM ingest_queue WHERE id=?").get("inq_recovery");
  assert.equal(job.status, "pending", "running jobs must be requeued on boot");
  assert.match(job.error, /Recovered after restart/);
  second.stop();
  second.db.close();
});

test("force re-ingest bypasses the dedup cache", async (t) => {
  const app = fileApp(t);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Force Reingest" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "a.md", text: "相同内容" });
  const second = await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "b.md", text: "相同内容" });
  assert.equal(second.skipped, true);
  const forced = await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "c.md", text: "相同内容", force: true });
  assert.equal(forced.skipped, false);
  assert.ok(forced.job, "force re-ingest must create a fresh job");
  const sources = app.db.prepare("SELECT COUNT(*) AS count FROM wiki_sources WHERE kb_id=?").get(kb.id).count;
  assert.equal(sources, 1, "prior source must be replaced by the forced one");
});

test("LLM compile failure degrades to a raw archived page", async (t) => {
  const baseUrl = await scriptedProvider(t, () => "");
  const app = fileApp(t);
  addCompileProvider(app, baseUrl);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Compile Fallback", ingest_mode: "review" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "story.md", text: "# 故事\n\n内容。" });
  await waitForQueue(app, kb.id);
  const source = app.db.prepare("SELECT * FROM wiki_sources WHERE kb_id=?").get(kb.id);
  assert.equal(source.status, "ingested", "failed compile must still land the source as ingested (degraded)");
  const pending = app.db.prepare("SELECT * FROM knowledge_changes WHERE kb_id=? AND status='pending'").all(kb.id);
  assert.ok(pending.some((change) => change.path.startsWith("sources/")), "a raw page change must be staged");
  const log = app.db.prepare("SELECT detail FROM wiki_log WHERE kb_id=? AND kind='ingest' ORDER BY created_at DESC LIMIT 1").get(kb.id);
  assert.match(log.detail, /LLM compile failed.*raw page staged/);
});

test("compiler maintains index/log/overview system pages through governance", async (t) => {
  const baseUrl = await scriptedProvider(t, (text) => {
    if (text.includes("STAGE: analysis")) return ANALYSIS_JSON;
    return JSON.stringify({ pages: [
      { path: "sources/demo.md", content: "---\ntype: source\ntitle: Demo\nsources: [\"raw/demo.md\"]\nconfidence: EXTRACTED\ntags: []\n---\n# Demo\n\n内容。" },
      { path: "index.md", content: "---\ntype: index\ntitle: 索引\nconfidence: INFERRED\ntags: []\n---\n# 索引\n\n- [[sources/demo]] Demo 摘要" },
      { path: "log.md", content: "---\ntype: log\ntitle: 日志\nconfidence: INFERRED\ntags: []\n---\n# 日志\n\n## [2026-08-20] ingest | Demo" },
      { path: "overview.md", content: "---\ntype: overview\ntitle: 总览\nconfidence: INFERRED\ntags: []\n---\n# 总览\n\n新增 Demo 素材。" },
    ] });
  });
  const app = fileApp(t);
  addCompileProvider(app, baseUrl);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "SysPages Compile", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "demo.md", text: "# Demo\n\n内容。" });
  await waitForQueue(app, kb.id);
  const pages = app.services.knowledge.listPages(kb.id, {});
  const paths = pages.map((page) => page.path);
  assert.ok(paths.includes("index.md"), "index.md must exist after compile");
  assert.ok(paths.includes("log.md"), "log.md must exist after compile");
  assert.ok(paths.includes("overview.md"), "overview.md must exist after compile");
  const read = (path) => app.services.knowledge.getDocument(kb.id, path).content;
  assert.match(read("index.md"), /sources\/demo/, "index.md must be updated by the compiler");
  assert.match(read("log.md"), /## \[2026-08-20\] ingest/, "log.md must be updated by the compiler");
  assert.match(read("overview.md"), /新增 Demo/, "overview.md must be updated by the compiler");
});

test("degraded raw pages are excluded from default search and marked as archives", async (t) => {
  const app = fileApp(t);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Degraded Search", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "archive.md", text: "向顶天与石壁纹路的神秘联系" });
  await waitForQueue(app, kb.id);
  const pages = app.services.knowledge.listPages(kb.id, {});
  const raw = pages.find((page) => page.path.startsWith("sources/"));
  assert.ok(raw, "degraded raw page must exist");
  assert.equal(raw.frontmatter["atlasgate-degraded"], true, "degraded page must carry the archive marker");
  const hits = app.services.knowledge.search(kb.id, "向顶天 石壁 纹路", { top_k: 10, min_score: 0 });
  assert.equal(hits.some((hit) => hit.path === raw.path), false, "degraded page must not appear in default search");
  const withRaw = app.services.knowledge.search(kb.id, "向顶天 石壁 纹路", { top_k: 10, min_score: 0, include_raw: true });
  assert.ok(withRaw.some((hit) => hit.path === raw.path), "include_raw must surface degraded pages");
});
