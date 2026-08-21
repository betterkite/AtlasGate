import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

function syncFixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-sync-"));
  const syncDir = path.join(directory, "vault");
  const app = createApp({ dbPath: path.join(directory, "atlasgate.db"), devMode: true, devKey: "test-key", port: 0, wikiSyncDir: syncDir, ...overrides });
  t.after(() => { app.stop(); app.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, syncDir };
}

test("sync mirrors master pages to disk with vault config and manifest", (t) => {
  const { app, syncDir } = syncFixture(t);
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "同步测试库" });
  knowledge.submitChange(kb.id, {
    path: "entities/x.md",
    content: "---\ntype: entity\ntitle: X\nsources: []\nconfidence: EXTRACTED\ntags: []\n---\n# X\n\n内容。",
    author: "tester",
  });
  knowledge.merge(kb.id, "publish for sync");

  const result = app.services.wikiSync.syncKnowledgeBase(kb.id);
  assert.equal(result.synced, true);
  assert.ok(result.files >= 6, `expected system pages + entities, got ${result.files}`);
  const kbDir = path.join(syncDir, "同步测试库");
  assert.equal(fs.existsSync(path.join(kbDir, "purpose.md")), true);
  assert.equal(fs.existsSync(path.join(kbDir, "schema.md")), true);
  assert.equal(fs.existsSync(path.join(kbDir, "entities/x.md")), true);
  assert.equal(fs.readFileSync(path.join(kbDir, "entities/x.md"), "utf8").includes("# X"), true);
  assert.equal(fs.existsSync(path.join(syncDir, ".obsidian/app.json")), true);
  assert.equal(fs.existsSync(path.join(kbDir, ".atlasgate-manifest.json")), true);
});

test("publish hook auto-syncs and deleted pages are removed from disk", (t) => {
  const { app, syncDir } = syncFixture(t);
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Auto Sync" });
  knowledge.submitChange(kb.id, { path: "notes/tmp.md", content: "# Tmp\n", author: "tester" });
  knowledge.merge(kb.id, "v2"); // publish hook syncs automatically
  const kbDir = path.join(syncDir, "auto-sync");
  assert.equal(fs.existsSync(path.join(kbDir, "notes/tmp.md")), true, "publish hook must mirror files");

  knowledge.submitChange(kb.id, { path: "notes/tmp.md", operation: "delete", author: "tester" });
  knowledge.merge(kb.id, "v3");
  assert.equal(fs.existsSync(path.join(kbDir, "notes/tmp.md")), false, "deleted page must vanish from the mirror");
});

test("sync can be disabled and unsafe paths are never written", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-sync-"));
  const app = createApp({ dbPath: path.join(directory, "atlasgate.db"), devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  t.after(() => { app.stop(); app.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Disabled Sync" });
  const disabled = app.services.wikiSync.syncKnowledgeBase(kb.id);
  assert.equal(disabled.synced, false);
  assert.equal(disabled.reason, "sync_disabled");
});

test("unsafe relative paths are skipped during sync", (t) => {
  const { app, syncDir } = syncFixture(t);
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Safe Sync" });
  // Insert a path-traversal document directly at master version 1.
  app.db.prepare(`INSERT INTO knowledge_documents (id,kb_id,version,path,content,content_hash,updated_at,page_type,title,frontmatter_json,confidence,sources_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "doc_evil", kb.id, 1, "../evil.md", "# Evil", "hash", new Date().toISOString(), "wiki", "Evil", "{}", "INFERRED", "[]",
  );
  const result = app.services.wikiSync.syncKnowledgeBase(kb.id);
  assert.ok(result.skipped >= 1, "traversal path must be skipped");
  assert.equal(fs.existsSync(path.join(syncDir, "..", "evil.md")), false);
  assert.equal(fs.existsSync(path.join(syncDir, "safe-sync", "..", "evil.md")), false);
});
