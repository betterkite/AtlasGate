import assert from "node:assert/strict";
import test from "node:test";
import { runForceAtlas } from "../web/graph.js";

test("force layout produces finite normalized coordinates for every node", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const edges = [
    { source: "a", target: "b", weight: 4 },
    { source: "a", target: "c", weight: 3 },
    { source: "b", target: "c", weight: 3 },
    { source: "c", target: "d", weight: 1 },
    { source: "d", target: "e", weight: 1 },
  ];
  const { nodes: laidOut } = runForceAtlas(nodes, edges);
  assert.equal(laidOut.length, 5);
  for (const node of laidOut) {
    assert.ok(Number.isFinite(node.x), `${node.id}.x must be finite`);
    assert.ok(Number.isFinite(node.y), `${node.id}.y must be finite`);
    assert.ok(node.x >= -2 && node.x <= 2, `${node.id}.x normalized: ${node.x}`);
    assert.ok(node.y >= -2 && node.y <= 2, `${node.id}.y normalized: ${node.y}`);
  }
  // Closely related nodes should not all collapse onto the same point.
  const positions = new Set(laidOut.map((node) => `${node.x.toFixed(3)},${node.y.toFixed(3)}`));
  assert.ok(positions.size >= 4, `expected spread-out layout, got ${positions.size} distinct positions`);
});

test("force layout is deterministic for the same input", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
  const edges = [
    { source: "a", target: "b", weight: 3 },
    { source: "b", target: "c", weight: 3 },
    { source: "c", target: "d", weight: 3 },
    { source: "d", target: "a", weight: 3 },
  ];
  const first = runForceAtlas(nodes.map((node) => ({ id: node.id })), edges);
  const second = runForceAtlas(nodes.map((node) => ({ id: node.id })), edges);
  first.nodes.forEach((node, index) => {
    assert.ok(Math.abs(node.x - second.nodes[index].x) < 1e-9);
    assert.ok(Math.abs(node.y - second.nodes[index].y) < 1e-9);
  });
});
