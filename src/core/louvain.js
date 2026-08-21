/**
 * Deterministic pure-JS Louvain community detection (ADR-010: no npm runtime
 * dependencies). Input is an undirected weighted graph; output maps each
 * original node id to a community id (0-based integers). Node iteration order
 * is preserved so the result is reproducible for the same graph.
 *
 * @param {Array<{id: string}>} nodes
 * @param {Array<{source: string, target: string, weight?: number}>} edges
 * @returns {{ communities: Record<string, number>, levels: number }}
 */
export function louvain(nodes, edges) {
  const adjacency = buildAdjacency(nodes, edges);
  const degrees = new Map(nodes.map((node) => [node.id, degreeOf(adjacency, node.id)]));
  const m = totalWeight(adjacency);
  if (nodes.length < 2 || m === 0) {
    const communities = {};
    nodes.forEach((node) => { communities[node.id] = 0; });
    return { communities, levels: 1 };
  }
  const ids = nodes.map((node) => node.id);
  const partition = louvainLevel(ids, adjacency, degrees, m, 0);
  const final = {};
  partition.forEach((community, nodeId) => { final[nodeId] = community; });
  return { communities: final, levels: Math.max(1, ...partition.values()) + 1 };
}

function buildAdjacency(nodes, edges) {
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.id, new Map());
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const weight = Number(edge.weight ?? 1) || 1;
    addEdge(adjacency, edge.source, edge.target, weight);
    addEdge(adjacency, edge.target, edge.source, weight);
  }
  return adjacency;
}

function addEdge(adjacency, a, b, weight) {
  if (!adjacency.has(a)) adjacency.set(a, new Map());
  const neighbors = adjacency.get(a);
  neighbors.set(b, (neighbors.get(b) ?? 0) + weight);
}

function totalWeight(adjacency) {
  let total = 0;
  for (const neighbors of adjacency.values()) for (const weight of neighbors.values()) total += weight;
  return total / 2; // each undirected edge counted twice
}

function degreeOf(adjacency, id) {
  let total = 0;
  for (const weight of (adjacency.get(id) ?? new Map()).values()) total += weight;
  return total;
}

/**
 * Recursive Louvain. The adjacency map carries only inter-community edge
 * weights at aggregated levels, while `degrees` keeps the true total degree
 * per (super-)node and `m` stays the original total edge weight — both are
 * required by the modularity delta. The child partition is mapped back onto
 * every original node through the aggregation hierarchy.
 *
 * @returns {Map<string, number>} node id -> community id
 */
function louvainLevel(ids, adjacency, degrees, m, depth) {
  const communityOf = new Map(ids.map((id, index) => [id, index]));
  const communityDegree = ids.map((id) => degrees.get(id) ?? 0);
  localMoving(ids, adjacency, communityOf, communityDegree, m);

  const groups = new Map();
  for (const id of ids) {
    const c = communityOf.get(id);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(id);
  }
  const groupList = [...groups.values()];
  if (groupList.length <= 1 || groupList.length === ids.length || depth > 32) {
    const result = new Map();
    ids.forEach((id) => result.set(id, communityOf.get(id)));
    return result;
  }

  const superNodes = groupList.map((group) => ({ id: group[0] }));
  const superIdByCommunity = new Map(groupList.map((group, index) => [communityOf.get(group[0]), superNodes[index].id]));
  const superAdjacency = buildAdjacency(superNodes, []);
  const superDegrees = new Map();
  for (const group of groupList) {
    const superId = superIdByCommunity.get(communityOf.get(group[0]));
    let total = 0;
    for (const node of group) total += degrees.get(node) ?? 0;
    superDegrees.set(superId, total);
    for (const node of group) {
      for (const [neighbor, weight] of adjacency.get(node) ?? []) {
        const neighborSuper = superIdByCommunity.get(communityOf.get(neighbor));
        if (neighborSuper !== superId) addEdge(superAdjacency, superId, neighborSuper, weight);
      }
    }
  }

  const child = louvainLevel(superNodes.map((node) => node.id), superAdjacency, superDegrees, m, depth + 1);
  const result = new Map();
  for (const group of groupList) {
    const superId = group[0];
    const community = child.get(superId) ?? 0;
    for (const node of group) result.set(node, community);
  }
  return result;
}

function localMoving(ids, adjacency, communityOf, communityDegree, m) {
  for (let pass = 0; pass < 64; pass += 1) {
    let moved = 0;
    for (const node of ids) {
      const current = communityOf.get(node);
      const k = communityDegree[current];
      const toCommunity = new Map();
      for (const [neighbor, weight] of adjacency.get(node) ?? []) {
        const c = communityOf.get(neighbor);
        toCommunity.set(c, (toCommunity.get(c) ?? 0) + weight);
      }
      // Net modularity delta for moving node i from its current community
      // (tot includes k) into candidate community c (tot excludes i):
      //   dQ = (kIn_c - kIn_cur)/m + k*(tot_cur - tot_c - k)/(2m^2)
      const kInCurrent = toCommunity.get(current) ?? 0;
      let best = current;
      let bestDelta = 0;
      for (const [c, kIn] of toCommunity) {
        if (c === current) continue;
        const delta = (kIn - kInCurrent) / m
          + (k * (communityDegree[current] - communityDegree[c] - k)) / (2 * m * m);
        if (delta > bestDelta + 1e-9) {
          bestDelta = delta;
          best = c;
        }
      }
      if (best !== current) {
        communityOf.set(node, best);
        communityDegree[current] -= k;
        communityDegree[best] += k;
        moved += 1;
      }
    }
    if (moved === 0) break;
  }
}
