import assert from "node:assert/strict";
import test from "node:test";
import { louvain } from "../src/core/louvain.js";
import { computeRelatedEdges } from "../src/core/relevance.js";
import { computeGraphInsights } from "../src/services/insights.js";
import { createApp } from "../src/app.js";

function fixture() {
  return createApp({ dbPath: ":memory:", devMode: true, devKey: "test-key", port: 0, wikiSyncDir: "" });
}

test("louvain is deterministic and separates two cliques joined by a weak bridge", () => {
  const nodes = ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) => ({ id }));
  const edges = [
    ["a1", "a2", 3], ["a1", "a3", 3], ["a2", "a3", 3],
    ["b1", "b2", 3], ["b1", "b3", 3], ["b2", "b3", 3],
    ["a1", "b1", 1],
  ].map(([source, target, weight]) => ({ source, target, weight }));

  const first = louvain(nodes, edges);
  const second = louvain(nodes, edges);
  assert.deepEqual(first.communities, second.communities, "louvain must be deterministic");
  assert.equal(first.communities.a1, first.communities.a2);
  assert.equal(first.communities.a2, first.communities.a3);
  assert.equal(first.communities.b1, first.communities.b2);
  assert.equal(first.communities.b2, first.communities.b3);
  assert.notEqual(first.communities.a1, first.communities.b1, "the two cliques should split");
});

test("louvain handles disconnected and single-node graphs", () => {
  const single = louvain([{ id: "solo" }], []);
  assert.equal(single.communities.solo, 0);
  const disconnected = louvain([{ id: "x" }, { id: "y" }], []);
  assert.equal(disconnected.communities.x, disconnected.communities.y);
});

test("related edges combine the four signals", () => {
  const documents = [
    { path: "entities/x.md", page_type: "entity", sources: ["raw/a.md"] },
    { path: "entities/y.md", page_type: "entity", sources: ["raw/a.md", "raw/b.md"] },
    { path: "concepts/z.md", page_type: "concept", sources: ["raw/b.md"] },
  ];
  const related = computeRelatedEdges(documents, [["entities/x.md", "entities/y.md"]]);
  const xy = related.find((edge) => edge.source === "document:entities/x.md" && edge.target === "document:entities/y.md");
  assert.ok(xy, "x and y must be related");
  assert.equal(xy.weight, 3 + 4 + 1, "direct 3 + source overlap 4 + type affinity 1");
  assert.equal(xy.signals.direct_link, 3);
  assert.equal(xy.signals.source_overlap, 4);
  const yz = related.find((edge) => edge.source === "document:concepts/z.md" && edge.target === "document:entities/y.md");
  assert.ok(yz, "y and z share source b");
  assert.equal(yz.signals.source_overlap, 4);
});

test("graph() returns related edges, communities and insights after publish", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Graph Enhance" });
  knowledge.submitChange(kb.id, {
    path: "entities/x.md",
    content: "---\ntype: entity\ntitle: X\nsources: [\"raw/a.md\"]\nconfidence: EXTRACTED\ntags: []\n---\n# X\n\n[[y]] 关联。",
    author: "tester",
  });
  knowledge.submitChange(kb.id, {
    path: "entities/y.md",
    content: "---\ntype: entity\ntitle: Y\nsources: [\"raw/a.md\"]\nconfidence: EXTRACTED\ntags: []\n---\n# Y\n\n内容。",
    author: "tester",
  });
  knowledge.merge(kb.id, "publish graph");

  const graph = knowledge.graph(kb.id);
  const related = graph.edges.filter((edge) => edge.relation === "related");
  assert.ok(related.length >= 1, "related edges must exist after publish");
  const xy = related.find((edge) => edge.source === "document:entities/x.md" && edge.target === "document:entities/y.md");
  assert.equal(xy.weight, 8);
  assert.deepEqual(xy.metadata.signals, { direct_link: 3, source_overlap: 4, adamic_adar: 0, type_affinity: 1, lexical_overlap: 0 });
  const xNode = graph.nodes.find((node) => node.id === "document:entities/x.md");
  assert.equal(typeof xNode.community, "number");
  assert.ok(Array.isArray(graph.communities));
  assert.ok(graph.insights, "insights must be present");
  app.db.close();
});

test("legacy versions lazily recompute related edges on graph read", () => {
  const app = fixture();
  const knowledge = app.services.knowledge;
  const kb = knowledge.createKnowledgeBase({ name: "Legacy Graph" });
  knowledge.submitChange(kb.id, {
    path: "entities/a.md",
    content: "---\ntype: entity\ntitle: A\nsources: [\"raw/s.md\"]\nconfidence: EXTRACTED\ntags: []\n---\n# A\n\n内容。",
    author: "tester",
  });
  knowledge.submitChange(kb.id, {
    path: "entities/b.md",
    content: "---\ntype: entity\ntitle: B\nsources: [\"raw/s.md\"]\nconfidence: EXTRACTED\ntags: []\n---\n# B\n\n内容。",
    author: "tester",
  });
  knowledge.merge(kb.id, "publish");
  assert.ok(knowledge.graph(kb.id).edges.some((edge) => edge.relation === "related"));

  // Simulate a pre-Phase-3 version: drop all related edges.
  app.db.prepare("DELETE FROM knowledge_graph_edges WHERE kb_id=? AND version=? AND relation='related'").run(kb.id, 2);
  const rebuilt = knowledge.graph(kb.id);
  assert.ok(rebuilt.edges.some((edge) => edge.relation === "related"), "graph read must lazily restore related edges");
  app.db.close();
});

test("graph insights detect isolated pages and bridges", () => {
  const nodes = ["document:a", "document:b", "document:c", "document:d"].map((id) => ({ id, label: id }));
  const edges = [
    { source: "document:a", target: "document:b", weight: 5 },
    { source: "document:b", target: "document:c", weight: 5 },
    { source: "document:c", target: "document:a", weight: 5 },
    { source: "document:b", target: "document:d", weight: 1 },
  ];
  const communities = { "document:a": 0, "document:b": 3, "document:c": 1, "document:d": 2 };
  const insights = computeGraphInsights(nodes, edges, communities);
  assert.ok(insights.bridges.some((bridge) => bridge.id === "document:b"), "b links three communities");
  assert.equal(insights.bridges[0].communities, 3);
  assert.ok(insights.surprising.some((edge) => edge.source === "document:b" && edge.target === "document:d"), "cross-community edge is surprising");
});

test("lexical overlap connects related pages without links or shared sources", () => {
  const documents = [
    { path: "sources/第020章_青云宗的黑暗面.md", page_type: "source", sources: [], content: "向顶天在青云宗的黑暗面中看到那道纹路，石壁上的走法让他想起堂主召见那回。夜色里叩门声响起，他把半块石头放进怀里，又拿起写着归的纸条看了一息。第020章的剧情围绕向顶天与石壁纹路展开，暗光在火光里泛着。" },
    { path: "sources/第021章_内门的人.md", page_type: "source", sources: [], content: "向顶天在灯下看那半块石头，断口在火光里泛着暗光，石壁上的纹路与走法是一个意思。门外响起三声轻叩，他把石头塞回怀里，又拿起写着归的纸条看了一息。第021章的剧情围绕向顶天与石壁纹路与叩门声展开。" },
    { path: "concepts/定价模型.md", page_type: "concept", sources: [], content: "量子计算与股票市场的随机游走模型，波动率与布朗运动的关系，定价公式的推导过程。完全不同的主题，没有任何词汇重叠。" },
  ];
  const related = computeRelatedEdges(documents, []);
  const edge = related.find((e) => e.source === "document:sources/第020章_青云宗的黑暗面.md" && e.target === "document:sources/第021章_内门的人.md");
  assert.ok(edge, "related chapters must be connected by lexical overlap");
  assert.equal(edge.signals.lexical_overlap, 1.5);
  assert.ok(!related.some((e) => e.source === "document:sources/第020章_青云宗的黑暗面.md" && e.target === "document:concepts/定价模型.md"), "unrelated pages must stay disconnected");
});
