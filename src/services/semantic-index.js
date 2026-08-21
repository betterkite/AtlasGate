import crypto from "node:crypto";
import { HttpError } from "../core/http.js";
import { id, now } from "../core/utils.js";
import { SYSTEM_PAGE_PATHS } from "./knowledge.js";

/**
 * Dense retrieval service (RAG phase 1, Q2/Q4/Q5).
 *
 * Two backends:
 *   - "local": page-level vectors in the semantic_vectors SQLite table
 *     (cosine similarity in-process) — fully offline, no external service.
 *   - "qdrant": chunk-level vectors in a Qdrant collection (legacy path,
 *     kept as an optional backend).
 *
 * Enabled modes:
 *   - retrieval_mode=hybrid: lexical (python) + dense (Node) fused by RRF.
 *     Requires an embedding service; without one it degrades to pure lexical.
 *   - retrieval_mode=qdrant: dense-only, requires Qdrant + embedding service.
 *   - retrieval_mode=local: pure lexical (legacy).
 *
 * The dense side always indexes wiki PAGES (not chunks) so the returned
 * sources are whole pages that the python side can fuse with lexical hits
 * and feed to the LLM as evidence.
 */
export class SemanticIndexService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  backend() {
    return this.config.retrievalMode === "qdrant" ? "qdrant" : "local";
  }

  enabled() {
    if (this.config.retrievalMode === "qdrant") return Boolean(this.config.qdrantUrl && this.config.embeddingBaseUrl);
    if (this.config.retrievalMode === "hybrid") return Boolean(this.config.embeddingBaseUrl);
    return false;
  }

  status() {
    const configured = Boolean(this.config.embeddingBaseUrl && this.config.embeddingModel);
    return {
      mode: this.config.retrievalMode,
      backend: this.backend(),
      enabled: this.enabled(),
      configured: this.enabled() ? configured : true,
      embedding_model: this.config.embeddingModel || null,
      dimensions: this.config.embeddingDimensions || null,
      embedding_url_configured: Boolean(this.config.embeddingBaseUrl),
      qdrant_url_configured: Boolean(this.config.qdrantUrl),
    };
  }

  validateConfig() {
    if (!this.enabled()) return;
    const missing = [];
    if (!this.config.embeddingBaseUrl) missing.push("ATLASGATE_EMBEDDING_BASE_URL");
    if (!this.config.embeddingModel) missing.push("ATLASGATE_EMBEDDING_MODEL");
    if (this.config.retrievalMode === "qdrant" && !this.config.qdrantUrl) missing.push("ATLASGATE_QDRANT_URL");
    if (missing.length) throw new HttpError(503, `Dense retrieval is missing: ${missing.join(", ")}`, "semantic_index_unconfigured");
  }

  listJobs(kbId) {
    return this.db.prepare("SELECT * FROM semantic_index_jobs WHERE kb_id=? ORDER BY version DESC,started_at DESC").all(kbId);
  }

  async indexVersion(kbId, version = null) {
    this.validateConfig();
    if (!this.enabled()) return { mode: "local", indexed: false };
    const kb = this.db.prepare("SELECT id,master_version FROM knowledge_bases WHERE id=?").get(kbId);
    if (!kb) throw new HttpError(404, "Knowledge base not found", "kb_not_found");
    const selectedVersion = version == null ? kb.master_version : Number(version);
    const backend = this.backend();
    // Phase 1: index whole PAGES (knowledge_documents), not chunks.
    const pages = this.db.prepare("SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path").all(kbId, selectedVersion);
    const collection = this.collectionName(kbId, selectedVersion);
    const startedAt = now();
    this.db.prepare(`INSERT INTO semantic_index_jobs
      (id,kb_id,version,backend,embedding_model,collection_name,status,chunk_count,started_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kb_id,version,backend,embedding_model) DO UPDATE SET
      collection_name=excluded.collection_name,status='running',chunk_count=0,error=NULL,started_at=excluded.started_at,completed_at=NULL`)
      .run(id("idx"), kbId, selectedVersion, backend, this.config.embeddingModel, collection, "running", 0, startedAt);
    try {
      if (!pages.length) {
        this.completeJob(kbId, selectedVersion, "ready", 0, null);
        return { kb_id: kbId, version: selectedVersion, collection, pages: 0, status: "ready", backend };
      }
      let dimensions = this.config.embeddingDimensions;
      const points = [];
      const upsertVector = this.db.prepare(`INSERT INTO semantic_vectors (id,kb_id,version,path,dims,vector_json,updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(kb_id,version,path) DO UPDATE SET dims=excluded.dims,vector_json=excluded.vector_json,updated_at=excluded.updated_at`);
      for (let offset = 0; offset < pages.length; offset += 64) {
        const batch = pages.slice(offset, offset + 64);
        const vectors = await this.embed(batch.map((page) => page.content));
        if (!dimensions) dimensions = vectors[0]?.length ?? 0;
        if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) throw new HttpError(502, "Embedding dimensions are inconsistent", "embedding_dimensions_invalid");
        batch.forEach((page, index) => {
          if (backend === "qdrant") {
            points.push({
              id: qdrantId(page.path),
              vector: vectors[index],
              payload: { path: page.path, kb_id: kbId, version: selectedVersion, content: page.content },
            });
          } else {
            upsertVector.run(id("vec"), kbId, selectedVersion, page.path, dimensions,
              JSON.stringify(vectors[index]), now());
          }
        });
      }
      if (backend === "qdrant") {
        await this.qdrant("PUT", `/collections/${encodeURIComponent(collection)}`, { vectors: { size: dimensions, distance: "Cosine" } }, [200, 409]);
        for (let offset = 0; offset < points.length; offset += 128) {
          await this.qdrant("PUT", `/collections/${encodeURIComponent(collection)}/points?wait=true`, { points: points.slice(offset, offset + 128) });
        }
      }
      this.completeJob(kbId, selectedVersion, "ready", pages.length, null);
      return { kb_id: kbId, version: selectedVersion, collection, pages: pages.length, dimensions, status: "ready", backend };
    } catch (error) {
      this.completeJob(kbId, selectedVersion, "failed", 0, error.message);
      throw error;
    }
  }

  /**
   * Page-level dense search. Returns whole-page sources (path + full content)
   * so python can fuse them with lexical hits (RRF) and use them as evidence.
   * System pages and degraded raw archives are excluded by default
   * (include_system / include_raw re-enable them, mirroring knowledge.search).
   */
  async search(kbId, query, options = {}) {
    this.validateConfig();
    if (!this.enabled()) throw new HttpError(400, "Semantic search is not enabled", "semantic_search_disabled");
    const kb = this.db.prepare("SELECT id,master_version FROM knowledge_bases WHERE id=?").get(kbId);
    if (!kb) throw new HttpError(404, "Knowledge base not found", "kb_not_found");
    const backend = this.backend();
    const job = this.db.prepare(`SELECT * FROM semantic_index_jobs WHERE kb_id=? AND version=? AND backend=? AND embedding_model=?`)
      .get(kbId, kb.master_version, backend, this.config.embeddingModel);
    if (!job || job.status !== "ready") await this.indexVersion(kbId, kb.master_version);
    const [vector] = await this.embed([String(query)]);
    const limit = Math.min(20, Math.max(1, Number(options.top_k ?? 5)));
    const minScore = Math.max(0, Math.min(1, Number(options.min_score ?? 0)));

    if (backend === "qdrant") {
      const result = await this.qdrant("POST", `/collections/${encodeURIComponent(this.collectionName(kbId, kb.master_version))}/points/search`, {
        vector, limit, with_payload: true, score_threshold: minScore,
      });
      return (result.result ?? []).map((item) => ({
        chunk_id: "",
        path: item.payload.path,
        chunk_index: 0,
        heading_path: "",
        char_count: String(item.payload.content ?? "").length,
        content: item.payload.content,
        snippet: String(item.payload.content ?? "").slice(0, 320),
        score: Number(Number(item.score).toFixed(5)),
        keyword_score: 0,
        vector_score: Number(Number(item.score).toFixed(5)),
        version: item.payload.version,
        retrieval_mode: "semantic_qdrant",
      }));
    }

    // Local backend: cosine over the page vectors.
    const rows = this.db.prepare("SELECT path,vector_json FROM semantic_vectors WHERE kb_id=? AND version=?").all(kbId, kb.master_version);
    if (!rows.length) return [];
    const systemPaths = new Set(Object.values(this.config.wiki?.systemPaths ?? SYSTEM_PAGE_PATHS));
    let degraded = new Set();
    if (!options.include_raw) {
      degraded = new Set(this.db.prepare(
        "SELECT path FROM knowledge_documents WHERE kb_id=? AND version=? AND frontmatter_json LIKE '%atlasgate-degraded%'",
      ).all(kbId, kb.master_version).map((row) => row.path));
    }
    const scored = rows
      .map((row) => {
        if (!options.include_system && systemPaths.has(row.path)) return null;
        if (degraded.has(row.path)) return null;
        const score = cosine(vector, JSON.parse(row.vector_json));
        return { path: row.path, score };
      })
      .filter((item) => item && item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (!scored.length) return [];
    const placeholders = scored.map(() => "?").join(",");
    const contents = new Map(this.db.prepare(
      `SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? AND path IN (${placeholders})`,
    ).all(kbId, kb.master_version, ...scored.map((item) => item.path)).map((row) => [row.path, row.content]));
    return scored.map((item) => {
      const content = contents.get(item.path) ?? "";
      return {
        chunk_id: "",
        path: item.path,
        chunk_index: 0,
        heading_path: "",
        char_count: content.length,
        content,
        snippet: content.slice(0, 320),
        score: Number(item.score.toFixed(5)),
        keyword_score: 0,
        vector_score: Number(item.score.toFixed(5)),
        version: kb.master_version,
        retrieval_mode: "hybrid",
      };
    });
  }

  async embed(input) {
    const base = this.config.embeddingBaseUrl.replace(/\/$/, "");
    const url = base.endsWith("/embeddings") ? base : `${base}/embeddings`;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.config.embeddingApiKey ? { authorization: `Bearer ${this.config.embeddingApiKey}` } : {}) },
        body: JSON.stringify({ model: this.config.embeddingModel, input, ...(this.config.embeddingDimensions ? { dimensions: this.config.embeddingDimensions } : {}) }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new HttpError(502, `Embedding provider unavailable: ${error.message}`, "embedding_unavailable");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(502, payload.error?.message ?? `Embedding provider returned ${response.status}`, "embedding_upstream_error");
    const vectors = (payload.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
    if (vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector))) throw new HttpError(502, "Embedding provider returned an invalid vector batch", "embedding_invalid_response");
    return vectors;
  }

  async qdrant(method, path, body, accepted = [200]) {
    let response;
    try {
      response = await fetch(`${this.config.qdrantUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(this.config.qdrantApiKey ? { "api-key": this.config.qdrantApiKey } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new HttpError(502, `Qdrant unavailable: ${error.message}`, "qdrant_unavailable");
    }
    const payload = await response.json().catch(() => ({}));
    if (!accepted.includes(response.status)) throw new HttpError(502, payload.status?.error ?? `Qdrant returned ${response.status}`, "qdrant_upstream_error");
    return payload;
  }

  completeJob(kbId, version, status, count, error) {
    this.db.prepare(`UPDATE semantic_index_jobs SET status=?,chunk_count=?,error=?,completed_at=?
      WHERE kb_id=? AND version=? AND backend=? AND embedding_model=?`)
      .run(status, count, error, now(), kbId, version, this.backend(), this.config.embeddingModel);
  }

  collectionName(kbId, version) {
    const safe = `${this.config.qdrantCollectionPrefix}_${kbId}_v${version}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    return safe.slice(0, 200);
  }
}

function qdrantId(value) {
  const hex = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
