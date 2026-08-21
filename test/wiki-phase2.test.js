import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

function fixture() {
  return createApp({ dbPath: ":memory:", devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
}

test("structural lint runs automatically after publish and finds orphans and broken links", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Lint Auto" });
  knowledge.submitChange(kb.id, { path: "entities/alpha.md", content: "# Alpha\n\n[[beta]] 与 [[nonexistent-topic]] 关联。", author: "tester" });
  knowledge.submitChange(kb.id, { path: "entities/beta.md", content: "# Beta\n\n独立页面。", author: "tester" });
  knowledge.merge(kb.id, "publish for lint");

  const reports = app.services.lintService.listReports(kb.id, "open");
  assert.ok(reports.some((report) => report.kind === "orphan_page" && report.path_a === "entities/alpha.md"), "alpha has no inbound link");
  assert.ok(!reports.some((report) => report.kind === "orphan_page" && report.path_a === "entities/beta.md"), "beta is linked by alpha");
  assert.ok(reports.some((report) => report.kind === "missing_link" && report.path_b === "nonexistent-topic"), "[[nonexistent-topic]] is a broken reference");
  assert.ok(!reports.some((report) => report.kind === "orphan_page" && report.path_a === "index.md"), "system pages are not orphans");
  app.db.close();
});

test("structural lint deduplicates open reports and respects lifecycle transitions", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Lint Lifecycle" });
  knowledge.submitChange(kb.id, { path: "entities/only.md", content: "# Only\n\n孤立页面。", author: "tester" });
  knowledge.merge(kb.id, "publish"); // publish hook runs structural lint automatically
  const reports = app.services.lintService.listReports(kb.id, "open");
  assert.equal(reports.length, 1);
  const again = app.services.lintService.structuralLint(kb.id);
  assert.equal(again.length, 0, "duplicate open reports must be suppressed");

  const acked = app.services.lintService.updateReport(kb.id, reports[0].id, { status: "acked" });
  assert.equal(acked.status, "acked");
  const third = app.services.lintService.structuralLint(kb.id);
  assert.equal(third.length, 1, "acked report frees the slot for a fresh report");
  app.db.close();
});

test("one-click create-page stages a stub Change for missing_page reports", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Lint Create" });
  const report = app.services.lintService.addReport(kb.id, 1, "missing_page", "index.md", "missing-topic",
    "index.md references [[missing-topic]] but no page exists", "warn", { suggested_path: "concepts/missing-topic.md" });
  const result = app.services.lintService.createPageFromLint(kb.id, report.id, {});
  assert.equal(result.change.path, "concepts/missing-topic.md");
  assert.equal(result.change.status, "pending");
  assert.equal(result.report.status, "fixed");
  assert.throws(() => app.services.lintService.createPageFromLint(kb.id, report.id, {}), /already resolved/);
  app.db.close();
});

test("query answers persist to queries/ via saveQueryAnswer and merge in auto mode", (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki2-"));
  const dbPath = path.join(dbDir, "atlasgate.db");
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));

  const reviewApp = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  const reviewKb = reviewApp.services.knowledge.createKnowledgeBase({ name: "Save Review", ingest_mode: "review" });
  const saved = reviewApp.services.wikiCompiler.saveQueryAnswer(reviewKb.id, {
    question: "怎么合并变更？", answer: "通过 merge 发布。", sources: [{ path: "handbook/overview.md" }],
  });
  assert.match(saved.path, /^queries\//);
  assert.equal(saved.published, null);
  const pending = reviewApp.db.prepare("SELECT * FROM knowledge_changes WHERE kb_id=? AND status='pending'").all(reviewKb.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].path, saved.path);
  reviewApp.stop();
  reviewApp.db.close();

  const autoApp = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  const autoKb = autoApp.services.knowledge.updateKnowledgeBase(reviewKb.id, { ingest_mode: "auto" });
  const autoSaved = autoApp.services.wikiCompiler.saveQueryAnswer(autoKb.id, {
    question: "第二个问题", answer: "第二个回答。", sources: [],
  });
  assert.equal(autoSaved.published, 2, "auto mode merges the saved query");
  const pages = autoApp.services.knowledge.listPages(autoKb.id, { page_type: "query" });
  assert.ok(pages.some((page) => page.path === autoSaved.path));
  autoApp.stop();
  autoApp.db.close();
});

test("ask route persists answers when save_to_wiki is enabled", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki2-"));
  const dbPath = path.join(directory, "atlasgate.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "", adminUsername: "console-admin", adminPassword: "console-secret" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "console-admin", password: "console-secret" }),
  });
  const cookie = login.headers.get("set-cookie");
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Ask Save", ingest_mode: "review" });

  const response = await fetch(`${base}/api/agents/knowledge/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ kb_id: kb.id, question: "什么是 AtlasGate？", save_to_wiki: true }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.ok(payload.saved_to_wiki.path.startsWith("queries/"), "route must persist the answer");
  const pending = app.db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes WHERE kb_id=? AND status='pending'").get(kb.id).count;
  assert.equal(pending, 1);
  app.stop();
  app.db.close();
});
