/**
 * Page relevance model (G12, ADR-010). Computes weighted page-to-page edges:
 *   direct link      x3.0  pages linked via [[wikilinks]]
 *   source overlap   x4.0  pages sharing the same raw source (frontmatter sources[])
 *   Adamic-Adar      x1.5  pages sharing common link-neighbors (weighted by degree)
 *   type affinity    x1.0  bonus for same page_type pairs that are already related
 *   lexical overlap  x1.5  pages sharing substantial distinctive vocabulary
 *                          (no LLM needed — connects raw/related pages such as
 *                          consecutive chapters of one work)
 *
 * Output edges use document node keys (document:<path>) so they can be merged
 * into the versioned graph with relation "related".
 */

import { tokenize } from "./utils.js";

const DIRECT_LINK = 3.0;
const SOURCE_OVERLAP = 4.0;
const ADAMIC_ADAR = 1.5;
const TYPE_AFFINITY = 1.0;
const LEXICAL_OVERLAP = 1.5;
const MAX_DOCS_FOR_ADAMIC_ADAR = 800;
const MAX_DOCS_FOR_LEXICAL = 400;
const LEXICAL_MIN_SHARED = 8;
const LEXICAL_MIN_JACCARD = 0.12;
const LEXICAL_MAX_DF_RATIO = 0.5; // drop tokens present in > half the pages
const SYSTEM_PAGE_PATHS = new Set(["index.md", "log.md", "purpose.md", "schema.md", "overview.md"]);

/**
 * @param {Array<{path: string, page_type?: string, sources?: string[], content?: string}>} documents
 * @param {Array<[string, string]>} linkPairs document path pairs with a direct link
 * @returns {Array<{source: string, target: string, weight: number, signals: Record<string, number>}>}
 */
export function computeRelatedEdges(documents, linkPairs) {
  const docs = documents.map((document) => ({
    path: document.path,
    type: document.page_type ?? null,
    sources: new Set(Array.isArray(document.sources) ? document.sources.map(String) : []),
    content: document.content ?? "",
  }));
  const byPath = new Map(docs.map((document) => [document.path, document]));
  const scores = new Map(); // `${a}\u0000${b}` -> { weight, signals }
  const bump = (a, b, amount, signal) => {
    if (!byPath.has(a) || !byPath.has(b) || a === b) return;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    const entry = scores.get(key) ?? { weight: 0, signals: { direct_link: 0, source_overlap: 0, adamic_adar: 0, type_affinity: 0, lexical_overlap: 0 } };
    entry.weight += amount;
    entry.signals[signal] += amount;
    scores.set(key, entry);
  };

  // 1. Direct links.
  for (const [a, b] of linkPairs) bump(a, b, DIRECT_LINK, "direct_link");

  // 2. Source overlap.
  const bySource = new Map();
  for (const document of docs) {
    for (const source of document.sources) {
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source).push(document.path);
    }
  }
  for (const paths of bySource.values()) {
    if (paths.length < 2) continue;
    for (let i = 0; i < paths.length; i += 1) {
      for (let j = i + 1; j < paths.length; j += 1) bump(paths[i], paths[j], SOURCE_OVERLAP, "source_overlap");
    }
  }

  // 3. Adamic-Adar over the direct-link neighborhood.
  if (docs.length <= MAX_DOCS_FOR_ADAMIC_ADAR) {
    const neighbors = new Map(docs.map((document) => [document.path, new Set()]));
    for (const [a, b] of linkPairs) {
      neighbors.get(a)?.add(b);
      neighbors.get(b)?.add(a);
    }
    const alreadyRelated = (a, b) => {
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      return scores.get(key)?.signals.direct_link ? true : false;
    };
    const seen = new Set();
    for (const [center, neighborsOfCenter] of neighbors) {
      const list = [...neighborsOfCenter];
      if (list.length < 2) continue;
      const contribution = 1 / Math.log(list.length + 2);
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const [a, b] = list[i] < list[j] ? [list[i], list[j]] : [list[j], list[i]];
          if (a === b || alreadyRelated(a, b)) continue;
          const key = `${a}\u0000${b}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bump(a, b, ADAMIC_ADAR * contribution, "adamic_adar");
        }
      }
    }
  }

  // 4. Type-affinity bonus for pairs that are already related.
  const typeGroups = new Map();
  for (const document of docs) {
    if (!document.type) continue;
    if (!typeGroups.has(document.type)) typeGroups.set(document.type, []);
    typeGroups.get(document.type).push(document.path);
  }
  for (const paths of typeGroups.values()) {
    for (let i = 0; i < paths.length; i += 1) {
      for (let j = i + 1; j < paths.length; j += 1) {
        const key = paths[i] < paths[j] ? `${paths[i]}\u0000${paths[j]}` : `${paths[j]}\u0000${paths[i]}`;
        const entry = scores.get(key);
        if (entry) bump(paths[i], paths[j], TYPE_AFFINITY, "type_affinity");
      }
    }
  }

  // 5. Lexical overlap: pages sharing substantial *distinctive* vocabulary are
  // related even without [[wikilinks]] or sources[] frontmatter (raw/degraded
  // pages, consecutive chapters of one work). Frontmatter boilerplate is
  // stripped first so identical metadata does not connect every page. Tokens
  // present in more than half the pages are dropped so common words do not
  // connect everything.
  const contentDocs = docs.filter((document) => document.content && !SYSTEM_PAGE_PATHS.has(document.path));
  if (contentDocs.length >= 2 && contentDocs.length <= MAX_DOCS_FOR_LEXICAL) {
    const tokenSets = new Map(contentDocs.map((document) => [document.path, new Set(tokenize(stripFrontmatter(document.content)))]));
    const documentFrequency = new Map();
    for (const set of tokenSets.values()) {
      for (const term of set) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    const maxDf = contentDocs.length >= 6 ? Math.max(1, Math.floor(contentDocs.length * LEXICAL_MAX_DF_RATIO)) : Number.POSITIVE_INFINITY;
    const distinctive = (path) => {
      const result = new Set();
      for (const term of tokenSets.get(path)) if ((documentFrequency.get(term) ?? 0) <= maxDf) result.add(term);
      return result;
    };
    const paths = [...tokenSets.keys()];
    for (let i = 0; i < paths.length; i += 1) {
      const left = distinctive(paths[i]);
      for (let j = i + 1; j < paths.length; j += 1) {
        const right = distinctive(paths[j]);
        let shared = 0;
        for (const term of left) if (right.has(term)) shared += 1;
        if (shared < LEXICAL_MIN_SHARED) continue;
        const union = left.size + right.size - shared;
        if (union <= 0 || shared / union < LEXICAL_MIN_JACCARD) continue;
        bump(paths[i], paths[j], LEXICAL_OVERLAP, "lexical_overlap");
      }
    }
  }

  return [...scores.entries()].map(([key, entry]) => {
    const [a, b] = key.split("\u0000");
    return {
      source: `document:${a}`,
      target: `document:${b}`,
      weight: Number(entry.weight.toFixed(3)),
      signals: Object.fromEntries(Object.entries(entry.signals).map(([name, value]) => [name, Number(value.toFixed(3))])),
    };
  });
}

function stripFrontmatter(content) {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(String(content ?? ""));
  return match ? String(content).slice(match[0].length) : String(content ?? "");
}
