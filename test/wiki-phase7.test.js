// ADR-015 direction A: query sedimentation — explicit & auto triggers,
// smart classification (concept/entity link), quality gate, audit chain.
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

const PAGES = {
  routing: { path: "concepts/路由.md", body: "路由与网关的调度原理说明：按质量成本延迟选择上游模型，支持故障转移。" },
  gateway: { path: "entities/网关.md", body: "网关是统一入口，负责模型路由、限流与配额。" },
};

function scriptedProvider(t, { answer }) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      const text = (payload.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      let content;
      if (text.includes("STAGE: analysis")) content = ANALYSIS_JSON;
      else if (text.includes("GENERATION stage")) content = JSON.stringify({ pages: [
        { path: PAGES.routing.path, content: `---\ntype: concept\ntitle: 路由\nsources: ["raw/demo.md"]\nconfidence: EXTRACTED\ntags: []\n---\n${PAGES.routing.body}` },
        { path: PAGES.gateway.path, content: `---\ntype: entity\ntitle: 网关\nsources: ["raw/demo.md"]\nconfidence: EXTRACTED\ntags: []\n---\n${PAGES.gateway.body}` },
      ] });
      else content = answer;
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

const GOOD_ANSWER = "路由与网关共同构成统一入口：路由负责按质量、成本、延迟选择上游模型并支持故障转移，网关负责限流、配额与审计账本，二者结合实现多协议统一接入与可观测性，让团队只需关心业务而无需各自对接模型厂商。";
const WEAK_ANSWER = "没有找到足够相关的证据，因此无法回答这个问题。";

async function sedimentApp(t, { answer = GOOD_ANSWER, overrides = {} } = {}) {
  const llmBase = await scriptedProvider(t, { answer });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-wiki7-"));
  const dbPath = path.join(directory, "atlasgate.db");
  const app = createApp({ dbPath, devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "", adminUsername: "console-admin", adminPassword: "console-secret", ...overrides });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  t.after(() => { app.stop(); app.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app.services.gateway.createProvider({
    name: "Scripted", kind: "openai", base_url: llmBase,
    models: ["compile-model"], quality: 0.9, latency_hint_ms: 50, reliability: 0.99,
  });
  const kb = app.services.knowledge.createKnowledgeBase({ name: "Sediment", ingest_mode: "auto" });
  await app.services.wikiCompiler.enqueue(kb.id, { kind: "paste", filename: "demo.md", text: "路由与网关。" });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const rows = await app.services.ingestQueue.list(kb.id);
    if (!rows.some((r) => r.status === "pending" || r.status === "running")) break;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "console-admin", password: "console-secret" }),
  });
  const cookie = login.headers.get("set-cookie");
  const ask = async (body) => {
    const response = await fetch(`${base}/api/agents/knowledge/ask`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ kb_id: kb.id, ...body }),
    });
    return response.json();
  };
  return { app, kb, ask };
}

test("explicit save_to_wiki sediments a query page linked to a concept page", async (t) => {
  const { app, kb, ask } = await sedimentApp(t);
  const result = await ask({ question: "路由与网关怎么配合工作", save_to_wiki: true });
  assert.ok(result.saved_to_wiki, "explicit request must sediment");
  assert.match(result.saved_to_wiki.path, /^queries\//);
  assert.ok(result.saved_to_wiki.linked_to, "smart classification must link a concept/entity page");
  assert.match(result.saved_to_wiki.linked_to, /^(concepts|entities)\//);
  const doc = app.db.prepare("SELECT content FROM knowledge_documents WHERE kb_id=? AND path=?").get(kb.id, result.saved_to_wiki.path);
  assert.ok(doc, "sedimented page must be published in master (auto KB)");
  assert.match(doc.content, /\[\[/, "page content must carry the wikilink");
});

test("repeated similar questions auto-sediment a high-quality answer", async (t) => {
  const { app, kb, ask } = await sedimentApp(t);
  const timestamp = new Date().toISOString();
  const insert = app.db.prepare(`INSERT INTO agent_runs (id,agent_id,session_id,question,answer,sources_json,memory_used,skill_ids_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 3; i += 1) {
    insert.run(`run_seed_${i}`, "knowledge-agent", "s1", `路由 网关 怎么工作 ${i}`, "seed", "[]", 0, "[]", timestamp);
  }
  const result = await ask({ question: "路由 网关 怎么工作" });
  assert.ok(result.saved_to_wiki, "3 similar past questions + quality answer must auto-sediment");
  assert.ok(result.saved_to_wiki.published, "auto KB merges the sedimented page");
  assert.match(result.saved_to_wiki.path, /^queries\//);
});

test("low-quality answer (insufficient evidence) is not sedimented", async (t) => {
  const { app, kb, ask } = await sedimentApp(t, { answer: WEAK_ANSWER });
  const result = await ask({ question: "路由与网关怎么配合工作" });
  assert.equal(result.saved_to_wiki, undefined, "insufficient-evidence answer must not sediment");
  const pending = app.db.prepare("SELECT COUNT(*) AS c FROM knowledge_changes WHERE kb_id=? AND path LIKE 'queries/%'").get(kb.id).c;
  assert.equal(pending, 0);
});

test("sedimentation can be disabled via config", async (t) => {
  const { app, kb, ask } = await sedimentApp(t, { overrides: { querySedimentEnabled: false } });
  const result = await ask({ question: "路由与网关怎么配合工作", save_to_wiki: true });
  assert.equal(result.saved_to_wiki, undefined, "disabled config must skip sedimentation");
});
