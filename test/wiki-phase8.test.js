// ADR-015 directions B (usage heat in the graph) and C (skill × retrieval).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

function fileApp(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki8-"));
  const dbPath = path.join(directory, "atlasgate.db");
  const app = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "", ...overrides });
  t.after(() => { app.stop(); app.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return app;
}

function seedPage(app, kbId, pathName, content) {
  app.db.prepare(`INSERT INTO knowledge_documents
    (id,kb_id,version,path,content,content_hash,updated_at,page_type,title,frontmatter_json,confidence,sources_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `doc_${pathName.replace(/[^a-z0-9]/gi, "_")}`, kbId, 1, pathName, content, "h", new Date().toISOString(),
    pathName.startsWith("concepts/") ? "concept" : "entity", pathName.split("/")[1], "{}", "INFERRED", "[]",
  );
}

test("query hits accumulate, dedupe, reset after 30-day idle, and surface in the graph", (t) => {
  const app = fileApp(t);
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Heat" });
  seedPage(app, kb.id, "concepts/routing.md", "路由与网关。");
  seedPage(app, kb.id, "entities/gateway.md", "网关实体。");
  const knowledge = app.services.knowledge;
  knowledge.rebuildGraph(kb.id, 1); // system pages already built the graph; force include seeded docs
  assert.equal(knowledge.recordQueryHits(kb.id, ["concepts/routing.md", "concepts/routing.md", "entities/gateway.md"]), 2, "paths dedupe");
  knowledge.recordQueryHits(kb.id, ["concepts/routing.md"]);
  let rows = app.db.prepare("SELECT path,hits FROM wiki_query_hits ORDER BY path").all();
  assert.deepEqual(rows.map((r) => [r.path, r.hits]), [["concepts/routing.md", 2], ["entities/gateway.md", 1]]);
  // 31 days idle -> counter resets to 1.
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  app.db.prepare("UPDATE wiki_query_hits SET last_hit_at=? WHERE path=?").run(old, "concepts/routing.md");
  knowledge.recordQueryHits(kb.id, ["concepts/routing.md"]);
  assert.equal(app.db.prepare("SELECT hits FROM wiki_query_hits WHERE path='concepts/routing.md'").get().hits, 1);
  // Graph nodes carry query_hits.
  const graph = knowledge.graph(kb.id);
  const doc = graph.nodes.find((node) => node.kind === "document" && node.document_path === "concepts/routing.md");
  assert.equal(doc.query_hits, 1);
});

test("skill retrieval config is stored, parsed and merged with caller params winning", (t) => {
  const app = fileApp(t);
  const agent = app.services.agent;
  const skill = agent.createSkill({
    name: "deep-lookup", description: "深度检索", instructions: "按证据回答。",
    retrieval: { multihop: true, top_k: 8, include_raw: false },
  });
  assert.deepEqual(JSON.parse(skill.retrieval_json), { multihop: true, top_k: 8, include_raw: false });
  agent.attachSkill("knowledge-agent", skill.id, true);
  const params = agent.retrievalParamsFromSkills();
  assert.equal(params.multihop, true);
  assert.equal(params.top_k, 8);
  assert.equal(params.include_raw, false);
  // Multiple skills: multihop OR, top_k max.
  const wide = agent.createSkill({ name: "wide", description: "x", instructions: "y", retrieval: { multihop: false, top_k: 12, directories: ["concepts/"] } });
  agent.attachSkill("knowledge-agent", wide.id, true);
  const merged = agent.retrievalParamsFromSkills();
  assert.equal(merged.multihop, true, "any-true wins");
  assert.equal(merged.top_k, 12, "max wins");
  assert.deepEqual(merged.directories, ["concepts/"]);
});

test("SKILL.md with a structured retrieval frontmatter imports it", (t) => {
  const app = fileApp(t);
  const skillMd = `---
name: targeted
description: 定向检索
version: 1.0.0
retrieval: {"top_k": 6, "include_raw": true}
---
按证据回答，必要时含原文。
`;
  const dataBase64 = Buffer.from(skillMd, "utf8").toString("base64");
  const imported = app.services.agent.importSkill({ filename: "SKILL.md", data_base64: dataBase64 });
  assert.deepEqual(JSON.parse(imported.skill.retrieval_json), { top_k: 6, include_raw: true });
});
