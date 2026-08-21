/**
 * Graph insights over the document-level related graph (G13):
 * - isolated pages (degree <= 1)
 * - sparse communities (cohesion < 0.15 with >= 3 members)
 * - bridge nodes (connecting >= 3 communities)
 * - surprising connections (related edges crossing communities)
 */

const SPARSE_COHESION_THRESHOLD = 0.15;
const SPARSE_MIN_MEMBERS = 3;
const BRIDGE_MIN_COMMUNITIES = 3;

/**
 * @param {Array<{id: string, label?: string, kind?: string}>} nodes document nodes
 * @param {Array<{source: string, target: string, weight: number}>} edges related edges
 * @param {Record<string, number>} communities node id -> community id
 */
export function computeGraphInsights(nodes, edges, communities) {
  const ids = new Set(nodes.map((node) => node.id));
  const degree = new Map([...ids].map((id) => [id, 0]));
  const neighbors = new Map([...ids].map((id) => [id, new Set()]));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    neighbors.get(edge.source).add(edge.target);
    neighbors.get(edge.target).add(edge.source);
  }

  const isolated = nodes
    .filter((node) => (degree.get(node.id) ?? 0) <= 1)
    .map((node) => ({ path: node.label ?? node.id, id: node.id }));

  const communityMembers = new Map();
  for (const node of nodes) {
    const c = communities[node.id] ?? 0;
    if (!communityMembers.has(c)) communityMembers.set(c, []);
    communityMembers.get(c).push(node.id);
  }
  const sparse = [];
  for (const [community, members] of communityMembers) {
    if (members.length < SPARSE_MIN_MEMBERS) continue;
    const memberSet = new Set(members);
    let intra = 0;
    for (const edge of edges) {
      if (memberSet.has(edge.source) && memberSet.has(edge.target)) intra += 1;
    }
    const possible = (members.length * (members.length - 1)) / 2;
    const cohesion = possible ? intra / possible : 0;
    if (cohesion < SPARSE_COHESION_THRESHOLD) {
      sparse.push({ community, members: members.length, cohesion: Number(cohesion.toFixed(3)) });
    }
  }

  const bridges = [];
  for (const node of nodes) {
    const touched = new Set();
    for (const neighbor of neighbors.get(node.id)) {
      touched.add(communities[neighbor] ?? 0);
    }
    if (touched.size >= BRIDGE_MIN_COMMUNITIES) {
      bridges.push({ path: node.label ?? node.id, id: node.id, communities: touched.size });
    }
  }

  const surprising = [];
  for (const edge of edges) {
    const ca = communities[edge.source];
    const cb = communities[edge.target];
    if (ca !== cb) {
      surprising.push({ source: edge.source, target: edge.target, weight: edge.weight });
    }
  }
  surprising.sort((a, b) => b.weight - a.weight);
  surprising.length = Math.min(surprising.length, 20);

  return { isolated, sparse, bridges, surprising };
}
