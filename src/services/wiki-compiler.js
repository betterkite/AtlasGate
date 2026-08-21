import { HttpError } from "../core/http.js";
import { parseFrontmatter, serializeFrontmatter } from "../core/frontmatter.js";
import { id, now, sha256, tokenize } from "../core/utils.js";
import {
  SYSTEM_PAGE_PATHS, WIKI_CONFIDENCE_LEVELS, WIKI_PAGE_TYPES, WIKI_TAXONOMY_DIRS,
} from "./knowledge.js";

const REVIEW_KINDS = new Set(["create_page", "deep_research", "verify", "skip"]);
const SECRET_PATTERN = /-----BEGIN [^-]+PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}/;

/**
 * LLM Wiki compiler orchestration (Phase 1). Consumes the persistent ingest
 * queue and drives the two-step compile pipeline:
 *
 *   source -> ① analysis (LLM) -> ② generation (LLM) -> validate -> stage
 *   Changes (author=wiki-compiler, batch_id) -> review items / research jobs
 *   -> merge when ingest_mode=auto (else left pending for human review).
 *
 * With no non-mock model routed, ingest degrades to "archive source + raw
 * page" (Q6) so the offline demo chain keeps working.
 */
export class WikiCompiler {
  constructor(db, config, knowledge, pythonAgent, gateway, documentParser, onPublished = null) {
    this.db = db;
    this.config = config;
    this.knowledge = knowledge;
    this.pythonAgent = pythonAgent;
    this.gateway = gateway;
    this.documentParser = documentParser;
    this.onPublished = onPublished;
    this.queue = null; // assigned by createApp (avoids circular imports)
    this.processing = false;
    this.timer = null;
    this.started = false;
    this.stopped = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.queue.recoverRunning();
    this.timer = setInterval(() => this.kick(), this.config.wiki.ingestPollMs);
    this.timer.unref();
    this.kick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    if (this.stopped) return;
    setImmediate(() => {
      if (this.stopped) return;
      this.processQueue().catch((error) => {
        // A queued tick may land after the app closed its database in tests.
        if (error?.code === "ERR_INVALID_STATE") return;
        console.error("Wiki ingest queue processing failed", error);
      });
    });
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      for (;;) {
        const job = this.queue.claimNext();
        if (!job) break;
        await this.processJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  // ---------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------

  async enqueue(kbId, input) {
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const kind = ["document", "paste", "url"].includes(input.kind) ? input.kind : "paste";
    let filename = String(input.filename ?? "").trim();
    let content = "";

    if (kind === "url") {
      const url = String(input.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "url must be an http(s) URL", "invalid_url");
      content = await this.fetchUrl(url);
      if (!content.trim()) throw new HttpError(400, "url returned no readable content", "empty_ingest");
      filename = filename || url.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "webpage";
      if (!/\.(md|txt)$/i.test(filename)) filename = `${filename}.md`;
    } else if (input.text !== undefined) {
      content = String(input.text);
      filename = filename || "paste.md";
    } else if (input.data_base64) {
      const parsed = await this.documentParser.parse({ filename: filename || "paste.md", media_type: input.media_type, data_base64: input.data_base64 });
      content = parsed.content;
      filename = filename || "paste.md";
    } else {
      throw new HttpError(400, "text, url or data_base64 is required", "invalid_ingest");
    }
    if (!content.trim()) throw new HttpError(400, "ingest content is empty", "empty_ingest");

    const hash = sha256(content);
    if (input.force === true) {
      // Force re-ingest: drop the prior source (and its pending queue rows)
      // for this content so it can be compiled again from scratch.
      const prior = this.db.prepare("SELECT source_id FROM ingest_cache WHERE kb_id=? AND source_hash=?").get(kbId, hash)
        ?? this.db.prepare("SELECT id AS source_id FROM wiki_sources WHERE kb_id=? AND content_hash=?").get(kbId, hash);
      if (prior) {
        this.db.prepare("DELETE FROM ingest_cache WHERE kb_id=? AND source_hash=?").run(kbId, hash);
        this.db.prepare("DELETE FROM ingest_queue WHERE kb_id=? AND source_id=?").run(kbId, prior.source_id);
        this.db.prepare("DELETE FROM wiki_sources WHERE id=?").run(prior.source_id);
      }
    }
    const cached = this.db.prepare("SELECT source_id FROM ingest_cache WHERE kb_id=? AND source_hash=?").get(kbId, hash);
    if (cached) return { job: null, skipped: true, reason: "duplicate_content", source_id: cached.source_id };
    const existing = this.db.prepare("SELECT id FROM wiki_sources WHERE kb_id=? AND content_hash=?").get(kbId, hash);
    if (existing) return { job: null, skipped: true, reason: "duplicate_content", source_id: existing.id };

    const safePath = `raw/${basename(filename).replace(/[^\w.\-\u3400-\u9fff]+/g, "-") || "source.md"}`;
    const sourceId = id("src");
    const timestamp = now();
    this.db.prepare(`INSERT INTO wiki_sources
      (id,kb_id,path,filename,media_type,content,content_hash,size_bytes,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      sourceId, kbId, safePath, basename(filename), input.media_type ?? "text/markdown",
      content, hash, Buffer.byteLength(content), "queued", timestamp,
    );
    const job = this.queue.create(kbId, sourceId, kind, { url: input.url ?? null, author: input.author ?? "local-user" });
    this.kick();
    return { job, skipped: false };
  }

  async processJob(job) {
    const source = this.db.prepare("SELECT * FROM wiki_sources WHERE id=?").get(job.source_id);
    if (!source) {
      this.queue.complete(job.id);
      return;
    }
    try {
      const result = await this.ingestOne(source, job);
      this.db.prepare("UPDATE wiki_sources SET status='ingested',error=NULL,ingested_at=? WHERE id=?").run(now(), source.id);
      this.recordCache(source, result.published ?? null);
      this.queue.complete(job.id);
      if (result.published) await this.onPublished?.(source.kb_id, result.published);
    } catch (error) {
      this.db.prepare("UPDATE wiki_sources SET status='failed',error=? WHERE id=?").run(String(error?.message ?? error).slice(0, 2000), source.id);
      this.queue.fail(job.id, error);
    }
  }

  async ingestOne(source, job) {
    const kb = this.knowledge.getKnowledgeBase(source.kb_id);
    const compileModel = kb.compile_model || "auto";
    let plan;
    try {
      plan = this.gateway.plan({ model: compileModel, messages: [{ role: "user", content: "compile" }] });
    } catch (error) {
      if (error.code === "no_route") return this.degradeIngest(kb, source);
      throw error;
    }
    if (plan.selected.kind === "mock") return this.degradeIngest(kb, source);

    try {
      const analysisPrep = await this.pythonAgent.prepare({ op: "ingest_analysis", kb_id: kb.id, source_id: source.id });
      const analysisText = await this.completeText(analysisPrep.messages, kb, compileModel);
      const analysis = extractJson(analysisText);

      const generationPrep = await this.pythonAgent.prepare({
        op: "ingest_generation", kb_id: kb.id, source_id: source.id,
        analysis, max_pages: this.config.wiki.maxPagesPerSource,
      });
      const pagesText = await this.completeText(generationPrep.messages, kb, compileModel);
      const generation = extractJson(pagesText);
      const validated = this.validatePages(generation, kb);

      const batchId = id("bat");
      for (const page of validated.pages) {
        this.knowledge.submitChange(kb.id, {
          path: page.path, content: page.content, operation: "upsert",
          author: "wiki-compiler", submitted_by: "wiki-compiler",
          base_version: kb.master_version, batch_id: batchId,
        });
      }
      this.deriveReviewAndResearch(kb, source, analysis);
      const defectNote = validated.defects.length
        ? `; ${validated.defects.length} page(s) discarded (${validated.defects.map((d) => d.reason).join(", ")})`
        : "";
      this.knowledge.logWiki(kb.id, kb.master_version, "ingest",
        `Compiled ${validated.pages.length} page(s) from ${source.filename}${defectNote}`);

      let published = null;
      if (kb.ingest_mode === "auto") published = this.knowledge.merge(kb.id, `Wiki ingest: ${source.filename}`).version;
      return { mode: "llm", pages: validated.pages.length, defects: validated.defects.length, batch_id: batchId, published, job_id: job.id };
    } catch (error) {
      // The model kept failing (empty completion / invalid JSON / upstream):
      // never lose the source — archive it as a raw page and note the reason.
      const reason = `${error?.code ?? "compile_error"}: ${error?.message ?? error}`.slice(0, 300);
      this.knowledge.logWiki(kb.id, kb.master_version, "ingest",
        `LLM compile failed for ${source.filename} (${reason}); degraded to raw page`);
      return this.degradeIngest(kb, source, `LLM compile failed: ${reason}`);
    }
  }

  /** Q6 offline path: archive the source and stage a raw page (like legacy import). */
  async degradeIngest(kb, source, reason = "no LLM provider routed") {
    const slug = source.filename.replace(/\.(md|txt)$/i, "").replace(/[^\w.\-\u3400-\u9fff]+/g, "-").slice(0, 80) || "source";
    const batchId = id("bat");
    // Give the raw page structured frontmatter so it behaves like a real
    // source page: title/sources[]/confidence, searchable metadata.
    const content = [
      "---",
      "type: source",
      `title: ${slug}`,
      `sources: ["${String(source.path).replace(/"/g, "")}"]`,
      "confidence: EXTRACTED",
      "tags: []",
      "atlasgate-degraded: true",
      "---",
      "",
      source.content,
      "",
    ].join("\n");
    this.knowledge.submitChange(kb.id, {
      path: `sources/${slug}.md`, content, operation: "upsert",
      author: "wiki-compiler", submitted_by: "wiki-compiler",
      base_version: kb.master_version, batch_id: batchId,
    });
    this.knowledge.logWiki(kb.id, kb.master_version, "ingest",
      `Degraded ingest of ${source.filename}: ${reason}, raw page staged (configure a provider for two-step compilation)`);
    let published = null;
    if (kb.ingest_mode === "auto") published = this.knowledge.merge(kb.id, `Wiki ingest (degraded): ${source.filename}`).version;
    return { mode: "degraded", pages: 1, batch_id: batchId, published, job_id: null };
  }

  async completeText(messages, kb, compileModel) {
    // The upstream model intermittently returns HTTP 200 with 0 output tokens
    // (empty completion) for the same prompt. Retry in-process with a small
    // backoff — a retry usually succeeds (observed 0 -> 4938 tokens).
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      try {
        const completion = await this.gateway.complete(
          { model: compileModel, temperature: 0.1, max_tokens: 8000, messages },
          { route: "/api/agents/knowledge/ingest" },
        );
        const content = completion.response.choices?.[0]?.message?.content ?? "";
        if (String(content).trim()) return content;
        lastError = new HttpError(502, "Compiler model returned an empty completion (HTTP 200, 0 tokens)", "compiler_empty_completion");
      } catch (error) {
        if (error?.status === 429 || error?.status >= 500 || error?.code === "upstream_timeout") {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new HttpError(502, "Compiler model returned an empty completion (HTTP 200, 0 tokens)", "compiler_empty_completion");
  }

  recordCache(source, version) {
    this.db.prepare(`INSERT OR IGNORE INTO ingest_cache (kb_id,source_hash,source_id,wiki_version,status,created_at)
      VALUES (?,?,?,?,?,?)`).run(source.kb_id, source.content_hash, source.id, version, "ingested", now());
  }

  deriveReviewAndResearch(kb, source, analysis) {
    const insertReview = this.db.prepare(`INSERT INTO review_items
      (id,kb_id,source_id,kind,payload_json,suggested_action,status,created_at) VALUES (?,?,?,?,?,?,?,?)`);
    for (const item of analysis.review_items ?? []) {
      if (!REVIEW_KINDS.has(item.kind)) continue;
      insertReview.run(id("rvw"), kb.id, source.id, item.kind,
        JSON.stringify(item.payload ?? {}), String(item.suggested_action ?? ""), "open", now());
    }
    const insertResearch = this.db.prepare(`INSERT INTO research_jobs
      (id,kb_id,topic,queries_json,provider,status,created_at) VALUES (?,?,?,?,?,?,?)`);
    for (const query of (analysis.research_queries ?? []).slice(0, 3)) {
      insertResearch.run(id("rsr"), kb.id, String(query).slice(0, 300), JSON.stringify([String(query)]), "", "pending", now());
    }
  }

  // ---------------------------------------------------------------------
  // Validation (Node is the staging authority)
  // ---------------------------------------------------------------------

  validatePages(generation, kb) {
    if (!generation || typeof generation !== "object" || !Array.isArray(generation.pages)) {
      throw new HttpError(502, "Compiler generation must return {\"pages\": [...]}", "compiler_invalid_generation");
    }
    const budget = this.config.wiki.maxPagesPerSource;
    const systemPaths = new Set(Object.values(this.config.wiki.systemPaths ?? SYSTEM_PAGE_PATHS));
    // The compiler maintains index.md / log.md / overview.md (D7/Fix-2);
    // purpose.md and schema.md stay human + LLM co-edited.
    const compilerSystemPaths = new Set(["index.md", "log.md", "overview.md"]);
    const pages = [];
    const defects = [];
    for (const item of generation.pages.slice(0, budget)) {
      const path = String(item?.path ?? "").trim();
      const content = String(item?.content ?? "");
      const allowedSystem = compilerSystemPaths.has(path);
      if (!path || path.startsWith("/") || path.includes("..") || /[:\\]/.test(path)
        || (systemPaths.has(path) && !allowedSystem)
        || (!allowedSystem && !WIKI_TAXONOMY_DIRS.some((dir) => path.startsWith(dir)))) {
        defects.push({ path, reason: "path_violation" });
        continue;
      }
      if (SECRET_PATTERN.test(content)) {
        defects.push({ path, reason: "secret_detected" });
        continue;
      }
      const parsed = parseFrontmatter(content);
      const metadata = parsed.metadata;
      // System navigation pages (index/log/overview) carry no source mapping;
      // sources[] is optional there and defaults to [] on merge.
      const isCompilerSystemPage = compilerSystemPaths.has(path);
      const valid = parsed.hasFrontmatter
        && WIKI_PAGE_TYPES.includes(metadata.type)
        && WIKI_CONFIDENCE_LEVELS.includes(metadata.confidence)
        && (isCompilerSystemPage || Array.isArray(metadata.sources))
        && String(metadata.title ?? "").trim()
        && content.trim();
      if (!valid) {
        defects.push({ path, reason: "frontmatter_invalid", detail: "missing type/title/confidence or empty content" });
        continue;
      }
      pages.push({ path, content, type: metadata.type, confidence: metadata.confidence });
    }
    if (!pages.length) throw new HttpError(502, "Compiler produced no valid pages", "compiler_no_valid_pages");
    return { pages, defects };
  }

  // ---------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------

  listReviews(kbId, status = "open") {
    this.knowledge.getKnowledgeBase(kbId);
    const rows = status
      ? this.db.prepare("SELECT * FROM review_items WHERE kb_id=? AND status=? ORDER BY created_at DESC,rowid DESC").all(kbId, status)
      : this.db.prepare("SELECT * FROM review_items WHERE kb_id=? ORDER BY created_at DESC,rowid DESC").all(kbId);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }

  resolveReview(kbId, reviewId, input) {
    this.knowledge.getKnowledgeBase(kbId);
    const review = this.db.prepare("SELECT * FROM review_items WHERE id=? AND kb_id=?").get(reviewId, kbId);
    if (!review) throw new HttpError(404, "Review item not found", "review_not_found");
    const status = input.status ?? (input.resolved === false ? "dismissed" : "resolved");
    if (!["open", "resolved", "dismissed"].includes(status)) throw new HttpError(400, "status must be open, resolved or dismissed", "invalid_review_status");
    this.db.prepare("UPDATE review_items SET status=?,action=?,resolved_at=? WHERE id=?").run(status, String(input.action ?? ""), now(), reviewId);
    this.knowledge.logWiki(kbId, null, "review", `Review ${reviewId} marked ${status}`);
    return this.db.prepare("SELECT * FROM review_items WHERE id=?").get(reviewId);
  }

  bulkResolveReviews(kbId, input) {
    const ids = [...new Set(input.ids ?? [])].map(String).filter(Boolean);
    if (!ids.length) throw new HttpError(400, "ids are required", "invalid_review_bulk");
    const action = String(input.action ?? "");
    const placeholders = ids.map(() => "?").join(",");
    const existing = this.db.prepare(`SELECT id FROM review_items WHERE kb_id=? AND id IN (${placeholders})`).all(kbId, ...ids).map((row) => row.id);
    if (existing.length) {
      this.db.prepare(`UPDATE review_items SET status='resolved',action=?,resolved_at=? WHERE kb_id=? AND id IN (${placeholders})`)
        .run(action, now(), kbId, ...existing);
    }
    return { resolved: existing, notFound: ids.filter((item) => !existing.includes(item)), count: existing.length };
  }

  listSources(kbId) {
    this.knowledge.getKnowledgeBase(kbId);
    return this.db.prepare("SELECT id,path,filename,media_type,size_bytes,status,error,created_at,ingested_at FROM wiki_sources WHERE kb_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500").all(kbId);
  }

  /** Deep Research jobs are reserved (D6): derived at ingest, executed later. */
  listResearchJobs(kbId, status = null) {
    this.knowledge.getKnowledgeBase(kbId);
    const rows = status
      ? this.db.prepare("SELECT * FROM research_jobs WHERE kb_id=? AND status=? ORDER BY created_at DESC,rowid DESC LIMIT 100").all(kbId, status)
      : this.db.prepare("SELECT * FROM research_jobs WHERE kb_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100").all(kbId);
    return rows.map((row) => ({ ...row, queries: JSON.parse(row.queries_json) }));
  }

  /**
   * Persist a valuable query answer as a wiki page (queries/<slug>.md).
   * Deterministic assembly — no extra LLM call. ADR-015/Q4C: smart
   * classification links a strong concept/entity match (hybrid retrieval
   * top-1) via [[wikilink]] instead of leaving the query page isolated.
   */
  saveQueryAnswer(kbId, input) {
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const question = String(input.question ?? "").trim();
    const answer = String(input.answer ?? "").trim();
    if (!question || !answer) throw new HttpError(400, "question and answer are required", "invalid_query_save");
    const sources = Array.from(new Set((Array.isArray(input.sources) ? input.sources : [])
      .map((source) => typeof source === "string" ? source : source?.path)
      .filter(Boolean)));
    const slug = slugify(question).slice(0, 80) || `query-${Date.now()}`;
    const path = `queries/${slug}.md`;
    const timestamp = now();
    // Smart classification (Q4C): link a strong existing concept/entity match.
    let linkTarget = null;
    try {
      const hits = this.knowledge.search(kbId, question, { top_k: 1, min_score: 0 });
      const top = hits[0];
      if (top && (top.path.startsWith("concepts/") || top.path.startsWith("entities/")) && top.score >= 0.2) {
        linkTarget = top.path;
      }
    } catch { /* search is best-effort for classification */ }
    const metadata = {
      type: "query", title: (input.title ?? question).slice(0, 120),
      sources, confidence: "INFERRED", tags: [], created: timestamp,
    };
    if (linkTarget) metadata.linked_to = linkTarget;
    const content = [
      serializeFrontmatter(metadata),
      "",
      `# ${input.title ?? question}`,
      "",
      answer,
      linkTarget ? `\n相关页面：[[${linkTarget.replace(/\.md$/i, "")}]]` : "",
      "",
    ].join("\n");
    const batchId = id("bat");
    const submitted = this.knowledge.submitChange(kbId, {
      path, content, operation: "upsert",
      author: "wiki-compiler", submitted_by: "wiki-compiler",
      base_version: kb.master_version, batch_id: batchId,
    });
    this.knowledge.logWiki(kbId, kb.master_version, "query", `Saved query answer to ${path} (change ${submitted.change.id})${linkTarget ? `, linked to ${linkTarget}` : ""}`);
    let published = null;
    if (kb.ingest_mode === "auto") published = this.knowledge.merge(kbId, `Save query: ${question.slice(0, 80)}`).version;
    return { path, change: submitted.change, published, linked_to: linkTarget };
  }

  /** ADR-015/Q1/Q2: count similar past questions in agent_runs (30-day window,
   *  bigram Jaccard). Used by autoSediment to detect repeated questions. */
  similarQuestionCount(kbId, question, { sinceDays = 30, minJaccard = 0.3 } = {}) {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const rows = this.db.prepare("SELECT question FROM agent_runs WHERE created_at >= ? AND question IS NOT NULL").all(since);
    const queryTokens = new Set(tokenize(String(question ?? "")));
    if (!queryTokens.size) return 0;
    let count = 0;
    for (const row of rows) {
      const other = new Set(tokenize(String(row.question ?? "")));
      const shared = [...queryTokens].filter((tok) => other.has(tok)).length;
      const union = queryTokens.size + other.size - shared;
      if (union > 0 && shared / union >= minJaccard) count += 1;
    }
    return count;
  }

  /** ADR-015/Q2: rule-based quality gate — ≥2 cited sources, no
   *  insufficient-evidence marker, substantial answer body. */
  isHighQuality(sources, answer) {
    if (!Array.isArray(sources) || sources.length < 2) return false;
    if (/证据不足|没有找到足够相关|insufficient evidence|no relevant|not found|no unsupported/i.test(String(answer ?? ""))) return false;
    return String(answer ?? "").trim().length >= 80;
  }

  /** ADR-015/Q1/Q2/Q5: sediment a Q&A into the wiki. Triggered when the user
   *  explicitly requests it (save_to_wiki / sediment), OR automatically when
   *  the same question has been asked ≥3 times and the answer passes the
   *  quality rule. Follows the KB ingest_mode audit chain (review pending /
   *  auto merge). Returns null when nothing qualifies. */
  autoSediment(kbId, input) {
    if (this.config.querySedimentEnabled === false) return null;
    const question = String(input.question ?? "").trim();
    const answer = String(input.answer ?? "").trim();
    const sources = Array.isArray(input.sources) ? input.sources : [];
    if (!question || !answer) return null;
    const explicit = input.explicit === true;
    // Explicit requests always qualify (user intent); auto-sedimentation needs
    // evidence + repeated similar questions + the quality rule.
    const qualifies = explicit
      || (sources.length >= 2 && this.similarQuestionCount(kbId, question) >= 3 && this.isHighQuality(sources, answer));
    if (!qualifies) return null;
    return this.saveQueryAnswer(kbId, {
      question, answer, sources,
      title: input.title ?? question,
      reason: explicit ? "explicit" : "auto",
    });
  }

  // ---------------------------------------------------------------------
  // URL fetch (basic HTML -> text)
  // ---------------------------------------------------------------------

  async fetchUrl(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: { "user-agent": "AtlasGateWikiCompiler/0.5" },
        redirect: "follow",
        signal: AbortSignal.timeout(Math.min(this.config.requestTimeoutMs, 30_000)),
      });
    } catch (error) {
      throw new HttpError(502, `URL fetch failed: ${error.message}`, "url_fetch_failed");
    }
    if (!response.ok) throw new HttpError(502, `URL fetch returned ${response.status}`, "url_fetch_failed");
    const html = await response.text();
    return htmlToText(html);
  }
}

function extractJson(text) {
  let cleaned = String(text ?? "").replace(/^\uFEFF/, "").trim();
  // Strip one fenced block if the model wrapped the JSON in markdown.
  cleaned = cleaned.replace(/^```(?:json|JSON)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  // Tolerate prose before/after an embedded object (first { to last }).
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  const preview = cleaned.replace(/\s+/g, " ").slice(0, 220);
  throw new HttpError(502, `Compiler model returned invalid JSON (received: ${preview || "<empty>"})`, "compiler_invalid_json");
}

function basename(filename) {
  return String(filename ?? "").split(/[\\/]/).pop() || "source.md";
}

function slugify(value) {
  return String(value ?? "").toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function htmlToText(html) {
  const text = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, (_, title) => `# ${title}\n\n`)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, heading) => `${"#".repeat(Number(level))} ${stripTags(heading)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => `- ${stripTags(item)}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, para) => `${stripTags(para)}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function stripTags(value) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
