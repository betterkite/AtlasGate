import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { SYSTEM_PAGE_PATHS } from "../src/services/knowledge.js";

function fixture() {
  return createApp({ dbPath: ":memory:", devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
}

test("createKnowledgeBase installs five system pages as version-1 documents", () => {
  const app = fixture();
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Wiki Test", ingest_mode: "review" });
  const documents = app.services.knowledge.listDocuments(kb.id);
  const paths = Object.values(SYSTEM_PAGE_PATHS);
  assert.equal(documents.length, paths.length);
  for (const pagePath of paths) {
    const document = documents.find((item) => item.path === pagePath);
    assert.ok(document, `missing system page ${pagePath}`);
    assert.ok(["purpose", "schema", "index", "log", "overview"].includes(document.page_type));
    assert.ok(document.title);
  }
  const pages = app.services.knowledge.listPages(kb.id, { page_type: "schema" });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].path, "schema.md");
  assert.deepEqual(pages[0].frontmatter, { type: "schema", title: pages[0].title, confidence: "INFERRED", tags: [] });
  assert.deepEqual(pages[0].sources, []);
  app.db.close();
});

test("knowledge base ingest_mode defaults to review and validates values", () => {
  const app = fixture();
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Mode Test" });
  assert.equal(app.services.knowledge.getKnowledgeBase(kb.id).ingest_mode, "review");
  const updated = app.services.knowledge.updateKnowledgeBase(kb.id, { ingest_mode: "auto" });
  assert.equal(updated.ingest_mode, "auto");
  assert.throws(() => app.services.knowledge.updateKnowledgeBase(kb.id, { ingest_mode: "banana" }), /ingest_mode must be review or auto/);
  app.db.close();
});

test("updateSchema and updatePurpose stage pending changes and refresh KB columns", () => {
  const app = fixture();
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Contract Test" });
  const schema = "# Wiki 公约\n\n- 中文页面\n";
  const purpose = "# 目的\n\n- 关键问题：X\n";
  const schemaResult = app.services.knowledge.updateSchema(kb.id, { content: schema, author: "local-user" });
  assert.equal(schemaResult.content, schema);
  assert.equal(schemaResult.change.status, "pending");
  assert.equal(app.services.knowledge.getSchema(kb.id).content, schema);
  const purposeResult = app.services.knowledge.updatePurpose(kb.id, { content: purpose, author: "local-user" });
  assert.equal(purposeResult.change.path, "purpose.md");
  assert.equal(app.services.knowledge.getPurpose(kb.id).content, purpose);
  assert.throws(() => app.services.knowledge.updateSchema(kb.id, { content: "   " }), /content is required/);
  app.db.close();
});

test("legacy system page seeding is one-time and idempotent across restarts", (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki-"));
  const dbPath = path.join(dbDir, "atlasgate.db");
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));

  const first = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  first.stop();
  first.db.close();

  // Simulate a legacy knowledge base created before the wiki model: a KB row,
  // a version row, and a plain document but no system pages. Reset the seeding
  // marker so the next startup runs the upgrade pass against it.
  {
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.prepare("INSERT INTO knowledge_bases (id,name,description,master_version,merge_batch_size,merge_interval_minutes,created_at,updated_at) VALUES ('kb_legacy','Legacy','old',1,3,60,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    raw.prepare("INSERT INTO knowledge_versions (id,kb_id,version,parent_version,summary,change_count,conflict_count,created_at) VALUES ('ver_legacy_1','kb_legacy',1,NULL,'Initial',0,0,'2026-01-01T00:00:00Z')").run();
    raw.prepare("INSERT INTO knowledge_documents (id,kb_id,version,path,content,content_hash,updated_at) VALUES ('doc_legacy','kb_legacy',1,'entities/old.md','# Old\nlegacy body','hash','2026-01-01T00:00:00Z')").run();
    raw.prepare("DELETE FROM system_metadata WHERE key='wiki_system_pages_v1'").run();
    raw.close();
  }

  const upgraded = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  const pending = upgraded.db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes WHERE kb_id='kb_legacy' AND status='pending'").get().count;
  assert.equal(pending, Object.keys(SYSTEM_PAGE_PATHS).length, "legacy KB must get one pending change per missing system page");
  upgraded.stop();
  upgraded.db.close();

  const reopened = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
  const after = reopened.db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes WHERE kb_id='kb_legacy' AND status='pending'").get().count;
  assert.equal(after, Object.keys(SYSTEM_PAGE_PATHS).length, "system page seeding must run exactly once");
  reopened.stop();
  reopened.db.close();
});

test("wiki model upgrade backfills page metadata for legacy documents", () => {
  const app = fixture();
  const row = app.db.prepare("SELECT id,path,page_type,title,frontmatter_json FROM knowledge_documents WHERE path='handbook/overview.md'").get();
  assert.equal(row.page_type, "wiki");
  assert.equal(row.title, "AtlasGate");
  assert.equal(JSON.parse(row.frontmatter_json).type, undefined);
  app.db.close();
});

test("search excludes system pages by default and honors include_system", () => {
  const app = fixture();
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Search Test" });
  const question = "知识库";
  const defaultHits = app.services.knowledge.search(kb.id, question, { top_k: 10, min_score: 0 });
  assert.equal(defaultHits.some((item) => item.path === "overview.md"), false);
  assert.equal(defaultHits.some((item) => item.path === "index.md"), false);
  const withSystem = app.services.knowledge.search(kb.id, question, { top_k: 10, min_score: 0, include_system: true });
  assert.ok(withSystem.some((item) => item.path === "overview.md"), "include_system must surface system pages");
  app.db.close();
});
