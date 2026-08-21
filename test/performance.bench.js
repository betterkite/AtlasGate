import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createApp } from "../src/app.js";

test("mock gateway overhead remains bounded", async (t) => {
  const app = createApp({ dbPath: ":memory:", devMode: true, devKey: "perf-key", wikiSyncDir: "" });
  t.after(() => { app.stop(); app.db.close(); });
  const latencies = [];
  const total = 1_000;
  let next = 0;
  async function runner() {
    while (next < total) {
      const index = next++;
      const started = performance.now();
      const result = await app.services.gateway.complete({ model: "atlas-mini", messages: [{ role: "user", content: `request ${index}` }] });
      latencies.push(performance.now() - started);
      assert.equal(result.response.choices.length, 1);
    }
  }
  await Promise.all(Array.from({ length: 20 }, runner));
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  console.log(JSON.stringify({ benchmark: "mock-gateway", requests: total, concurrency: 20, p95_ms: Number(p95.toFixed(3)) }));
  assert.ok(p95 <= 50, `gateway p95 ${p95.toFixed(2)} ms exceeds 50 ms`);
});

test("Python pool handles concurrent work without per-request process startup", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlasgate-perf-"));
  const app = createApp({ dbPath: path.join(directory, "atlasgate.db"), pythonWorkerPoolSize: 2, pythonWorkerQueueLimit: 40, wikiSyncDir: "" });
  t.after(() => { app.stop(); app.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = { kb_id: "kb_atlas_handbook", question: "How does routing work?" };
  await app.services.pythonAgent.prepare(request);
  const startedWorkers = app.services.pythonAgent.status().started;
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 40 }, () => app.services.pythonAgent.prepare(request)));
  const elapsed = performance.now() - started;
  assert.ok(results.every((result) => result.sources.length > 0));
  assert.equal(app.services.pythonAgent.status().started, startedWorkers);
  assert.equal(app.services.pythonAgent.status().queued, 0);
  console.log(JSON.stringify({ benchmark: "python-pool", requests: 40, concurrency: 40, pool_size: 2, elapsed_ms: Number(elapsed.toFixed(3)) }));
});
