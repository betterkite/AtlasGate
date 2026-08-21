import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZip, readZip } from "../src/core/zip.js";
import { createApp } from "../src/app.js";

function fixture() {
  return createApp({ dbPath: ":memory:", devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
}

test("zip writer round-trips UTF-8 names and contents", () => {
  const files = [
    { path: "entities/混合.md", content: "# 混合\n\n中文内容。" },
    { path: "purpose.md", content: "# 目的\n" },
    { path: "empty.md", content: "" },
  ];
  const buffer = createZip(files);
  const read = readZip(buffer);
  assert.deepEqual(Object.keys(read).sort(), ["empty.md", "entities/混合.md", "purpose.md"]);
  assert.equal(read["entities/混合.md"].toString("utf8"), "# 混合\n\n中文内容。");
  assert.equal(read["purpose.md"].toString("utf8"), "# 目的\n");
});

test("wiki export includes system pages, business pages and preserved frontmatter", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Export Test" });
  knowledge.submitChange(kb.id, {
    path: "entities/x.md",
    content: "---\ntype: entity\ntitle: X\nsources: [\"raw/a.md\"]\nconfidence: EXTRACTED\ntags: [demo]\n---\n# X\n\n实体内容。",
    author: "tester",
  });
  knowledge.merge(kb.id, "publish for export");

  const result = app.services.wikiExport.exportZip(kb.id);
  assert.match(result.filename, /^Export-Test-v2\.zip$/);
  const entries = readZip(result.buffer);
  assert.ok(entries["purpose.md"], "purpose.md must be exported");
  assert.ok(entries["schema.md"], "schema.md must be exported");
  assert.ok(entries[".obsidian/app.json"], "Obsidian config must be exported");
  const page = entries["entities/x.md"].toString("utf8");
  assert.match(page, /^---\ntype: entity/);
  assert.match(page, /sources: \["raw\/a\.md"\]/);
  assert.match(entries["README.md"].toString("utf8"), /Export Test/);
  app.db.close();
});

test("export honors an explicit version", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Version Export" });
  knowledge.submitChange(kb.id, { path: "notes/one.md", content: "# One\n", author: "tester" });
  knowledge.merge(kb.id, "v2");
  const v2 = app.services.wikiExport.exportZip(kb.id, 2);
  const entries = readZip(v2.buffer);
  assert.ok(entries["notes/one.md"]);
  app.db.close();
});

test("research jobs are listed with parsed queries (D6 reserved)", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Research List" });
  app.db.prepare(`INSERT INTO research_jobs (id,kb_id,topic,queries_json,provider,status,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("rsr_test", kb.id, "AtlasGate 架构", JSON.stringify(["q1", "q2"]), "", "pending", new Date().toISOString());
  const jobs = app.services.wikiCompiler.listResearchJobs(kb.id, "pending");
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].queries, ["q1", "q2"]);
  assert.equal(jobs[0].status, "pending");
  app.db.close();
});

test("export endpoint streams a zip for an authenticated admin session", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki4-"));
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
  const kb = app.services.knowledge.createKnowledgeBase({ name: "HTTP Export" });

  const response = await fetch(`${base}/api/knowledge-bases/${kb.id}/export`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/zip/);
  const entries = readZip(Buffer.from(await response.arrayBuffer()));
  assert.ok(entries["purpose.md"]);
  app.stop();
  app.db.close();
});
