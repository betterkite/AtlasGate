/**
 * Force-directed knowledge graph renderer (Canvas, zero dependencies).
 * Enterprise-grade interactions aligned with sdyckjq-lab/llm-wiki-skill:
 * - ForceAtlas2-style layout: repulsion by (deg+1), attraction by edge weight,
 *   gravity toward center, swing damping, bounded ticks.
 * - Node size by √(link count); document nodes colored by community.
 * - Related edges colored/thickened by relevance weight; structural thin gray.
 * - Drag individual nodes (positions persist in the layout cache); drag empty
 *   space to pan; wheel zooms around the cursor; fit-to-screen.
 * - Hover: neighbor highlight + live preview card (label/path/type/community).
 * - Click: select a node -> pinned details card with "open page" action.
 * - Graph search: highlight matches, Enter selects the first match.
 * - Minimap in the corner with a viewport rectangle; label declutter by zoom.
 */

const COMMUNITY_PALETTE = ["#087f6d", "#3f6f93", "#c28b16", "#8a5a9e", "#c25b4e", "#4e7ac2", "#6d8a3f", "#9b5c74", "#2f8f9b", "#b06f3f"];
const KIND_COLORS = { document: "#087f6d", heading: "#3f6f93", tag: "#c28b16", reference: "#9b5c74" };
const MAX_NODES = 300;
const TICKS = 240;
const LAYOUT_CACHE = new Map();
const CACHE_LIMIT = 8;

export function drawForceGraph(canvas, graph, options = {}) {
  if (!canvas || !graph?.nodes?.length) return;
  const box = canvas.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return; // hidden panel — defer until visible
  const layout = layoutFor(graph, options);
  if (!layout.nodes.length) return;
  if (!canvas.__forceGraph) {
    canvas.__forceGraph = new ForceGraphView(canvas, graph, layout, options);
    canvas.__forceGraph.fit();
  } else {
    canvas.__forceGraph.update(graph, layout, options);
  }
  canvas.__forceGraph.draw();
}

function layoutFor(graph, options) {
  const nodes = selectNodes(graph, options);
  if (!nodes.length) return { nodes: [], edges: [], adjacency: new Map() };
  const key = `${graph.kb_id ?? "kb"}:${graph.version ?? "v"}:${options.showHeadings ? "h" : "n"}:${nodes.map((n) => n.id).sort().join("|")}`;
  if (LAYOUT_CACHE.has(key)) return LAYOUT_CACHE.get(key);
  const edges = (graph.edges ?? []).filter((edge) =>
    nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target));
  const layout = runForceAtlas(nodes, edges);
  const entry = { nodes: layout.nodes, edges, adjacency: layout.adjacency };
  LAYOUT_CACHE.set(key, entry);
  if (LAYOUT_CACHE.size > CACHE_LIMIT) LAYOUT_CACHE.delete(LAYOUT_CACHE.keys().next().value);
  return entry;
}

function selectNodes(graph, options) {
  let nodes = graph.nodes;
  if (!options.showHeadings) nodes = nodes.filter((node) => node.kind !== "heading");
  if (nodes.length <= MAX_NODES) return nodes;
  const degree = new Map();
  for (const edge of graph.edges ?? []) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return nodes.slice().sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, MAX_NODES);
}

export function runForceAtlas(nodes, edges) {
  const positions = new Map();
  const displacement = new Map();
  const adjacency = new Map(nodes.map((node) => [node.id, new Map()]));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    const weight = Number(edge.weight) || 1;
    adjacency.get(edge.source).set(edge.target, weight);
    adjacency.get(edge.target).set(edge.source, weight);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  // Deterministic circle seed with per-node jitter.
  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length) + hashPhase(node.id);
    positions.set(node.id, { x: Math.cos(angle) * 0.42, y: Math.sin(angle) * 0.42 });
    displacement.set(node.id, { x: 0, y: 0 });
  });

  const k = 1.6;
  let speed = 1;
  let swing = 0;
  for (let tick = 0; tick < TICKS; tick += 1) {
    const forces = new Map();
    for (const node of nodes) forces.set(node.id, { x: 0, y: 0 });
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const pa = positions.get(a.id);
        const pb = positions.get(b.id);
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.001) { dx = (hashPhase(`${a.id}~${b.id}`) + 0.5) * 0.01; dy = (hashPhase(`${b.id}~${a.id}`) + 0.5) * 0.01; dist2 = dx * dx + dy * dy; }
        const dist = Math.sqrt(dist2);
        const repulsion = k * (degree.get(a.id) + 1) * (degree.get(b.id) + 1) / dist2;
        const fx = (dx / dist) * repulsion;
        const fy = (dy / dist) * repulsion;
        forces.get(a.id).x -= fx; forces.get(a.id).y -= fy;
        forces.get(b.id).x += fx; forces.get(b.id).y += fy;
      }
    }
    for (const edge of edges) {
      if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
      const pa = positions.get(edge.source);
      const pb = positions.get(edge.target);
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const pull = k * (Number(edge.weight) || 1) * 0.9;
      forces.get(edge.source).x += (dx / dist) * pull; forces.get(edge.source).y += (dy / dist) * pull;
      forces.get(edge.target).x -= (dx / dist) * pull; forces.get(edge.target).y -= (dy / dist) * pull;
    }
    for (const node of nodes) {
      const force = forces.get(node.id);
      const pos = positions.get(node.id);
      const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y) || 0.001;
      const gravity = 0.12 * ((degree.get(node.id) ?? 0) + 1) * dist;
      force.x -= (pos.x / dist) * gravity;
      force.y -= (pos.y / dist) * gravity;
    }
    let newSwing = 0;
    for (const node of nodes) {
      const force = forces.get(node.id);
      const pos = positions.get(node.id);
      const disp = displacement.get(node.id);
      disp.x = disp.x * 0.85 + force.x;
      disp.y = disp.y * 0.85 + force.y;
      const magnitude = Math.sqrt(disp.x * disp.x + disp.y * disp.y) || 0.001;
      newSwing += (degree.get(node.id) ?? 0) * magnitude;
      pos.x += (disp.x / magnitude) * Math.min(magnitude, speed) * 0.08;
      pos.y += (disp.y / magnitude) * Math.min(magnitude, speed) * 0.08;
    }
    swing = swing * 0.7 + newSwing * 0.3;
    speed = Math.min(1.5, 0.1 + speed * (swing > 0 ? Math.min(1.6, 1 / Math.sqrt(swing) * 0.5 + 0.8) : 0.9));
  }
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
  }
  const spanX = Math.max(0.001, maxX - minX);
  const spanY = Math.max(0.001, maxY - minY);
  const scale = Math.max(spanX, spanY) / 2;
  for (const node of nodes) {
    const pos = positions.get(node.id);
    pos.x = (pos.x - (minX + maxX) / 2) / scale;
    pos.y = (pos.y - (minY + maxY) / 2) / scale;
    node.x = pos.x;
    node.y = pos.y;
  }
  return { nodes, adjacency };
}

function hashPhase(value) {
  let total = 0;
  for (const character of String(value)) total = (total * 31 + character.charCodeAt(0)) % 1000;
  return (total / 1000 - 0.5) * 0.18;
}

function edgeWeightColor(weight) {
  return lerpColor("#9aaba5", "#1e7a52", Math.min(1, Math.max(0, (Number(weight) - 1) / 6)));
}

function lerpColor(from, to, t) {
  const a = hexRgb(from);
  const b = hexRgb(to);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

function hexRgb(hex) {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function nodeColor(node, communities) {
  if (node.kind === "document" && communities && communities.length) {
    return COMMUNITY_PALETTE[(node.community ?? 0) % COMMUNITY_PALETTE.length];
  }
  return KIND_COLORS[node.kind] ?? "#66716e";
}

class ForceGraphView {
  constructor(canvas, graph, layout, options) {
    this.canvas = canvas;
    this.graph = graph;
    this.layout = layout;
    this.options = options;
    this.hover = null;
    this.selected = null;
    this.dragging = null;
    this.searchQuery = "";
    this.transform = { scale: 1, x: 0, y: 0 };
    this.baseScale = 1;
    this.ratio = window.devicePixelRatio || 1;
    this.card = this.createCard();
    this.bind(canvas);
  }

  update(graph, layout, options) {
    this.graph = graph;
    this.layout = layout;
    this.options = options;
    if (this.selected && !layout.nodes.some((node) => node.id === this.selected.id)) this.selected = null;
  }

  createCard() {
    const parent = this.canvas.parentElement;
    if (!parent) return null;
    const card = document.createElement("div");
    card.className = "graph-node-card";
    card.hidden = true;
    parent.appendChild(card);
    return card;
  }

  bind(canvas) {
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoomAround(event.offsetX, event.offsetY, event.deltaY > 0 ? 0.9 : 1.1);
      this.draw();
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => {
      const node = this.pick(event.offsetX, event.offsetY);
      this.dragging = node
        ? { kind: "node", id: node.id, moved: false, startX: event.offsetX, startY: event.offsetY }
        : { kind: "pan", moved: false, startX: event.offsetX, startY: event.offsetY };
      try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    });
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      if (this.selected) this.showCard(this.selected, null, null, true);
      else this.hideCard();
      this.draw();
    });
  }

  onPointerMove(event) {
    const x = event.offsetX;
    const y = event.offsetY;
    if (this.dragging) {
      if (this.dragging.kind === "node") {
        const node = this.layout.nodes.find((item) => item.id === this.dragging.id);
        if (node) {
          const dx = x - this.dragging.startX;
          const dy = y - this.dragging.startY;
          if (dx * dx + dy * dy > 9) this.dragging.moved = true;
          node.x = (x - this.transform.x) / this.transform.scale;
          node.y = (y - this.transform.y) / this.transform.scale;
          this.hover = node;
          if (this.selected?.id === node.id) this.updateCard(node);
        }
        this.draw();
      } else if (this.dragging.kind === "pan") {
        const dx = x - this.dragging.startX;
        const dy = y - this.dragging.startY;
        if (dx * dx + dy * dy > 9) this.dragging.moved = true;
        this.transform.x += dx;
        this.transform.y += dy;
        this.dragging.startX = x;
        this.dragging.startY = y;
        this.draw();
      }
      return;
    }
    const node = this.pick(x, y);
    if (node?.id !== this.hover?.id) {
      this.hover = node;
      if (node) this.showCard(node, x, y);
      else if (!this.selected) this.hideCard();
      this.draw();
    }
  }

  onPointerUp(event) {
    if (!this.dragging) return;
    const clicked = !this.dragging.moved;
    const wasNode = this.dragging.kind === "node";
    this.dragging = null;
    if (clicked) {
      if (wasNode) {
        const node = this.layout.nodes.find((item) => item.id === this.hover?.id) ?? null;
        if (node) {
          this.selected = node;
          this.showCard(node, null, null, true);
        }
      } else {
        this.selected = null;
        if (!this.hover) this.hideCard();
      }
    }
    this.draw();
  }

  pick(offsetX, offsetY) {
    const wx = (offsetX - this.transform.x) / this.transform.scale;
    const wy = (offsetY - this.transform.y) / this.transform.scale;
    let best = null;
    let bestDist = 16 / this.transform.scale;
    for (const node of this.layout.nodes) {
      const dx = node.x - wx;
      const dy = node.y - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; best = node; }
    }
    return best;
  }

  zoomAround(x, y, factor) {
    const min = this.baseScale * 0.15;
    const max = this.baseScale * 8;
    const next = Math.min(max, Math.max(min, this.transform.scale * factor));
    const ratio = next / this.transform.scale;
    this.transform.x = x - (x - this.transform.x) * ratio;
    this.transform.y = y - (y - this.transform.y) * ratio;
    this.transform.scale = next;
  }

  fit() {
    const box = this.canvas.getBoundingClientRect();
    const pad = 46;
    const base = Math.max(0.2, Math.min((box.width - pad * 2) / 2, (box.height - pad * 2) / 2));
    this.baseScale = base;
    this.transform.scale = base;
    this.transform.x = box.width / 2;
    this.transform.y = box.height / 2;
    this.draw();
  }

  search(query) {
    this.searchQuery = String(query ?? "").trim().toLowerCase();
    this.draw();
    return this.matchNodes();
  }

  clearSearch() {
    this.searchQuery = "";
    this.draw();
  }

  matchNodes() {
    if (!this.searchQuery) return [];
    return this.layout.nodes.filter((node) =>
      String(node.label ?? "").toLowerCase().includes(this.searchQuery)
      || String(node.document_path ?? node.id ?? "").toLowerCase().includes(this.searchQuery));
  }

  selectFirstMatch() {
    const matches = this.matchNodes();
    if (!matches.length) return null;
    this.selected = matches[0];
    this.showCard(matches[0], null, null, true);
    this.draw();
    return matches[0];
  }

  // ------------------------------------------------------------------
  // Card (hover preview / selected details)
  // ------------------------------------------------------------------

  showCard(node, x, y, pinned = false) {
    if (!this.card) return;
    const degree = (this.layout.adjacency.get(node.id) ?? new Map()).size;
    const community = node.kind === "document" ? (node.community ?? 0) : null;
    const heat = node.kind === "document" && node.query_hits > 0 ? ` · 问答引用 ${node.query_hits} 次` : "";
    const kindLabel = { document: "页面", heading: "标题", tag: "标签", reference: "引用" }[node.kind] ?? node.kind;
    const open = pinned && node.kind === "document" && this.options.onOpenPage
      ? `<button class="button primary compact-button" data-graph-open>打开页面</button>`
      : "";
    this.card.innerHTML = `
      <div class="graph-card-title"><i class="dot" style="background:${nodeColor(node, this.graph?.communities)}"></i>${escapeHtml(node.label ?? node.id)}</div>
      <div class="graph-card-row">类型：${kindLabel}</div>
      ${node.document_path ? `<div class="graph-card-row mono">${escapeHtml(node.document_path)}</div>` : ""}
      <div class="graph-card-row">度：${degree}${community != null ? ` · 社区 #${community}` : ""}${heat}</div>
      ${open}`;
    this.card.hidden = false;
    if (x == null || pinned) {
      const box = this.canvas.getBoundingClientRect();
      this.card.style.left = "auto";
      this.card.style.right = "14px";
      this.card.style.top = "14px";
      void box;
    } else {
      const box = this.canvas.getBoundingClientRect();
      this.card.style.left = "";
      this.card.style.right = "auto";
      this.card.style.top = `${Math.max(6, Math.min(y + 16, box.height - this.card.offsetHeight - 10))}px`;
      this.card.style.left = `${Math.min(x + 14, box.width - this.card.offsetWidth - 10)}px`;
    }
    this.card.querySelector("[data-graph-open]")?.addEventListener("click", () => {
      this.options.onOpenPage?.(node);
    });
  }

  updateCard(node) {
    if (this.card && !this.card.hidden) this.showCard(node, null, null, Boolean(this.selected));
  }

  hideCard() {
    if (this.card) this.card.hidden = true;
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  draw() {
    const canvas = this.canvas;
    const box = canvas.getBoundingClientRect();
    const ratio = this.ratio;
    canvas.width = Math.max(1, Math.floor(box.width * ratio));
    canvas.height = Math.max(1, Math.floor(box.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, box.width, box.height);

    const { nodes, edges, adjacency } = this.layout;
    const scale = this.transform.scale;
    const ox = this.transform.x;
    const oy = this.transform.y;
    for (const node of nodes) {
      node._x = node.x * scale + ox;
      node._y = node.y * scale + oy;
    }
    const matches = this.searchQuery ? this.matchNodes() : null;
    const matchSet = matches ? new Set(matches.map((node) => node.id)) : null;
    const hoverNeighbors = this.hover ? adjacency.get(this.hover.id) ?? new Map() : null;
    const dim = Boolean(hoverNeighbors);

    for (const edge of edges) {
      const source = this.layoutNode(edge.source);
      const target = this.layoutNode(edge.target);
      if (!source || !target) continue;
      const related = edge.relation === "related";
      const highlighted = hoverNeighbors
        && (edge.source === this.hover.id || edge.target === this.hover.id
          || (hoverNeighbors.has(edge.source) && hoverNeighbors.has(edge.target)));
      if (related) {
        ctx.strokeStyle = edgeWeightColor(edge.weight);
        ctx.lineWidth = Math.min(3.4, 0.9 + Number(edge.weight) / 2.6);
        ctx.globalAlpha = dim ? (highlighted ? 0.9 : 0.08) : 0.75;
      } else {
        ctx.strokeStyle = "#8fa09a";
        ctx.lineWidth = 1;
        ctx.globalAlpha = dim ? (highlighted ? 0.75 : 0.06) : 0.75;
      }
      ctx.beginPath(); ctx.moveTo(source._x, source._y); ctx.lineTo(target._x, target._y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Top-degree documents keep labels when zoomed out.
    const labelBudget = scale < 1.1 ? 8 : Infinity;
    const labelled = new Set();
    for (const node of nodes) {
      const isMatch = matchSet?.has(node.id);
      const isFocus = this.hover?.id === node.id || this.selected?.id === node.id || isMatch;
      const degree = (adjacency.get(node.id) ?? new Map()).size;
      let drawLabel = false;
      if (node.kind === "document") {
        drawLabel = isFocus || (scale >= 1.1 && labelled.size < labelBudget);
        if (drawLabel) labelled.add(node.id);
      } else if ((node.kind === "tag" || node.kind === "reference") && (isFocus || scale >= 2.2)) {
        drawLabel = true;
      }
      const size = (node.kind === "document" ? 5 : 3) + Math.sqrt(degree) * 1.6;
      const highlighted = hoverNeighbors ? (node.id === this.hover.id || hoverNeighbors.has(node.id)) : true;
      ctx.globalAlpha = dim && !highlighted ? 0.12 : 1;
      ctx.fillStyle = nodeColor(node, this.graph?.communities);
      if (this.selected?.id === node.id) {
        ctx.strokeStyle = "#26312e";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(node._x, node._y, size + 4, 0, Math.PI * 2); ctx.stroke();
      }
      if (this.hover?.id === node.id) {
        ctx.shadowColor = nodeColor(node, this.graph?.communities);
        ctx.shadowBlur = 12;
      }
      ctx.beginPath(); ctx.arc(node._x, node._y, size, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (drawLabel) {
        ctx.globalAlpha = dim && !highlighted ? 0.12 : 1;
        ctx.fillStyle = isMatch ? "#c25b4e" : "#26312e";
        ctx.font = "10px system-ui";
        ctx.textAlign = "left";
        ctx.fillText(String(node.label).slice(0, 30), node._x + size + 5, node._y + 3);
        ctx.globalAlpha = 1;
      }
    }
    ctx.globalAlpha = 1;
    this.drawMinimap(ctx, box.width, box.height);
  }

  layoutNode(id) {
    return this.layout.nodes.find((node) => node.id === id);
  }

  drawMinimap(ctx, width, height) {
    const nodes = this.layout.nodes;
    if (nodes.length < 2) return;
    const miniW = 132;
    const miniH = 92;
    const pad = 10;
    const mx = width - miniW - pad;
    const my = height - miniH - pad;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "rgba(38,49,46,0.82)";
    roundedRect(ctx, mx, my, miniW, miniH, 6);
    ctx.fill();
    const s = miniW / 2.4;
    const cx = mx + miniW / 2;
    const cy = my + miniH / 2;
    for (const node of nodes) {
      ctx.fillStyle = nodeColor(node, this.graph?.communities);
      ctx.beginPath();
      ctx.arc(cx + node.x * s, cy + node.y * s, node.kind === "document" ? 2 : 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Viewport rectangle.
    const wl = (0 - this.transform.x) / this.transform.scale;
    const wt = (0 - this.transform.y) / this.transform.scale;
    const wr = (width - this.transform.x) / this.transform.scale;
    const wb = (height - this.transform.y) / this.transform.scale;
    const vx = cx + Math.max(-1, Math.min(1, wl)) * s;
    const vy = cy + Math.max(-1, Math.min(1, wt)) * s;
    const vw = Math.max(2, (Math.min(1, wr) - Math.max(-1, wl)) * s);
    const vh = Math.max(2, (Math.min(1, wb) - Math.max(-1, wt)) * s);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(vx, vy, vw, vh);
    ctx.globalAlpha = 1;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

// Cross-browser rounded rectangle path (ctx.roundRect is unavailable on some
// engines; drawing with it there would crash every frame).
function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
