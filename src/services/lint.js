import { HttpError } from "../core/http.js";
import { id, now } from "../core/utils.js";
import { SYSTEM_PAGE_PATHS } from "./knowledge.js";

const LINT_KINDS = new Set([
  "contradiction", "stale_claim", "orphan_page", "missing_page", "missing_link", "data_gap",
]);
const LINT_SEVERITIES = new Set(["info", "warn", "error"]);

/**
 * Wiki lint (Phase 2). Structural checks are pure SQL and run automatically
 * after every publish via knowledge.publishHooks (Q17-B); the LLM-level health
 * check is manual and requires a real model provider.
 */
export class LintService {
  constructor(db, config, knowledge, pythonAgent = null, gateway = null) {
    this.db = db;
    this.config = config;
    this.knowledge = knowledge;
    this.pythonAgent = pythonAgent;
    this.gateway = gateway;
  }

  // ------------------------------------------------------------------
  // Structural lint (SQL only, zero token cost)
  // ------------------------------------------------------------------

  structuralLint(kbId, version = null) {
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const selected = version ?? kb.master_version;
    this.knowledge.requireVersion(kbId, selected);
    const created = [];
    created.push(...this.isolatedPages(kbId, selected));
    created.push(...this.brokenLinks(kbId, selected));
    created.push(...this.indexConsistency(kbId, selected));
    return created.filter(Boolean);
  }

  isolatedPages(kbId, version) {
    const documents = this.db.prepare("SELECT path FROM knowledge_documents WHERE kb_id=? AND version=?").all(kbId, version);
    const inbound = new Set(this.db.prepare("SELECT DISTINCT target_key FROM knowledge_graph_edges WHERE kb_id=? AND version=?").all(kbId, version).map((row) => row.target_key));
    const systemPaths = new Set(Object.values(SYSTEM_PAGE_PATHS));
    const created = [];
    for (const document of documents) {
      if (systemPaths.has(document.path)) continue; // system pages are navigation, not orphans
      if (inbound.has(`document:${document.path}`)) continue;
      created.push(this.addReport(kbId, version, "orphan_page", document.path, null, "No inbound links from other wiki pages", "info"));
    }
    return created;
  }

  brokenLinks(kbId, version) {
    const references = this.db.prepare("SELECT label,document_path FROM knowledge_graph_nodes WHERE kb_id=? AND version=? AND kind='reference'").all(kbId, version);
    const systemPaths = new Set(Object.values(SYSTEM_PAGE_PATHS));
    const created = [];
    for (const reference of references) {
      if (reference.document_path && systemPaths.has(reference.document_path)) continue; // system page navigation is not linted as broken
      created.push(this.addReport(kbId, version, "missing_link", reference.document_path ?? null, reference.label,
        `Broken [[${reference.label}]] reference`, "warn"));
    }
    return created;
  }

  indexConsistency(kbId, version) {
    const indexDoc = this.db.prepare("SELECT content FROM knowledge_documents WHERE kb_id=? AND version=? AND path='index.md'").get(kbId, version);
    const known = new Set(this.db.prepare("SELECT path FROM knowledge_documents WHERE kb_id=? AND version=?").all(kbId, version).map((row) => row.path));
    if (!indexDoc) return [];
    const created = [];
    for (const target of extractWikiLinks(indexDoc.content)) {
      if (known.has(target) || known.has(`${target}.md`)) continue;
      created.push(this.addReport(kbId, version, "missing_page", "index.md", target,
        `index.md references [[${target}]] but no such page exists`, "warn"));
    }
    return created;
  }

  // ------------------------------------------------------------------
  // LLM-level lint (manual, requires a real model)
  // ------------------------------------------------------------------

  async runLint(kbId, mode = "structural") {
    const kb = this.knowledge.getKnowledgeBase(kbId);
    if (mode === "structural") return this.structuralLint(kb.id);
    if (mode !== "llm") throw new HttpError(400, "mode must be structural or llm", "invalid_lint_mode");
    if (!this.pythonAgent || !this.gateway) throw new HttpError(503, "LLM lint is not configured", "lint_unavailable");
    const compileModel = kb.compile_model || "auto";
    const plan = this.gateway.plan({ model: compileModel, messages: [{ role: "user", content: "lint" }] });
    if (plan.selected.kind === "mock") throw new HttpError(503, "LLM-level lint requires a real model provider", "lint_llm_unavailable");

    const prepared = await this.pythonAgent.prepare({ op: "ingest_lint", kb_id: kb.id });
    const text = await this.completeText(prepared.messages, kb, compileModel);
    const payload = extractJson(text);
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.issues)) {
      throw new HttpError(502, "Lint model returned invalid JSON", "lint_invalid_json");
    }
    const created = [];
    for (const issue of payload.issues.slice(0, 20)) {
      const kind = LINT_KINDS.has(issue.kind) ? issue.kind : "data_gap";
      const severity = LINT_SEVERITIES.has(issue.severity) ? issue.severity : "info";
      created.push(this.addReport(kb.id, kb.master_version, kind,
        issue.path_a ?? null, issue.path_b ?? null, String(issue.detail ?? ""), severity,
        { suggested_path: issue.suggested_path ?? null }));
    }
    return created.filter(Boolean);
  }

  async completeText(messages, kb, compileModel) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      try {
        const completion = await this.gateway.complete(
          { model: compileModel, temperature: 0.1, max_tokens: 4000, messages },
          { route: "/api/agents/knowledge/lint" },
        );
        const content = completion.response.choices?.[0]?.message?.content ?? "";
        if (String(content).trim()) return content;
        lastError = new HttpError(502, "Lint model returned an empty completion (HTTP 200, 0 tokens)", "lint_empty_completion");
      } catch (error) {
        if (error?.status === 429 || error?.status >= 500 || error?.code === "upstream_timeout") {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new HttpError(502, "Lint model returned an empty completion (HTTP 200, 0 tokens)", "lint_empty_completion");
  }

  // ------------------------------------------------------------------
  // Reports
  // ------------------------------------------------------------------

  addReport(kbId, version, kind, pathA, pathB, detail, severity, extra = {}) {
    const existing = this.db.prepare(`SELECT id FROM lint_reports
      WHERE kb_id=? AND kind=? AND path_a IS ? AND path_b IS ? AND status='open'`).get(kbId, kind, pathA ?? null, pathB ?? null);
    if (existing) return null;
    const reportId = id("lnt");
    this.db.prepare(`INSERT INTO lint_reports
      (id,kb_id,version,kind,path_a,path_b,detail,severity,status,suggested_path,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      reportId, kbId, version, kind, pathA ?? null, pathB ?? null, String(detail ?? "").slice(0, 2000),
      severity, "open", extra.suggested_path ?? null, now(),
    );
    return this.db.prepare("SELECT * FROM lint_reports WHERE id=?").get(reportId);
  }

  listReports(kbId, status = "open") {
    this.knowledge.getKnowledgeBase(kbId);
    const rows = status
      ? this.db.prepare("SELECT * FROM lint_reports WHERE kb_id=? AND status=? ORDER BY created_at DESC,rowid DESC LIMIT 200").all(kbId, status)
      : this.db.prepare("SELECT * FROM lint_reports WHERE kb_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200").all(kbId);
    return rows;
  }

  updateReport(kbId, reportId, input) {
    this.knowledge.getKnowledgeBase(kbId);
    const report = this.db.prepare("SELECT * FROM lint_reports WHERE id=? AND kb_id=?").get(reportId, kbId);
    if (!report) throw new HttpError(404, "Lint report not found", "lint_report_not_found");
    const status = input.status ?? report.status;
    if (!["open", "acked", "fixed", "dismissed"].includes(status)) throw new HttpError(400, "status must be open, acked, fixed or dismissed", "invalid_lint_status");
    const resolution = input.resolution === undefined ? report.resolution : String(input.resolution);
    this.db.prepare("UPDATE lint_reports SET status=?,resolution=?,resolved_at=? WHERE id=?")
      .run(status, resolution, status === "open" ? null : now(), reportId);
    this.knowledge.logWiki(kbId, report.version, "lint", `Lint report ${reportId} (${report.kind}) -> ${status}`);
    return this.db.prepare("SELECT * FROM lint_reports WHERE id=?").get(reportId);
  }

  /** One-click fix: stage a stub page Change for a missing_page report. */
  createPageFromLint(kbId, reportId, input) {
    this.knowledge.getKnowledgeBase(kbId);
    const report = this.db.prepare("SELECT * FROM lint_reports WHERE id=? AND kb_id=?").get(reportId, kbId);
    if (!report) throw new HttpError(404, "Lint report not found", "lint_report_not_found");
    if (report.kind !== "missing_page" || !report.suggested_path) {
      throw new HttpError(400, "Only missing_page reports with a suggested_path can create a page", "lint_not_creatable");
    }
    if (!["open", "acked"].includes(report.status)) {
      throw new HttpError(409, "Lint report is already resolved", "lint_already_resolved");
    }
    const title = report.suggested_path.split("/").pop().replace(/\.md$/i, "");
    const content = [
      "---",
      "type: note",
      `title: ${title}`,
      "sources: []",
      "confidence: INFERRED",
      "tags: []",
      "---",
      "",
      `# ${title}`,
      "",
      "> 由 Lint 一键创建的待补页面（missing_page 报告）。",
      "",
    ].join("\n");
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const submitted = this.knowledge.submitChange(kbId, {
      path: report.suggested_path, content, operation: "upsert",
      author: input.author ?? "wiki-compiler", submitted_by: input.author ?? "wiki-compiler",
      base_version: kb.master_version,
    });
    this.updateReport(kbId, reportId, { status: "fixed", resolution: `Staged stub page ${report.suggested_path} (change ${submitted.change.id})` });
    return { change: submitted.change, report: this.db.prepare("SELECT * FROM lint_reports WHERE id=?").get(reportId) };
  }
}

function extractJson(text) {
  const cleaned = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  throw new HttpError(502, "Lint model returned invalid JSON", "lint_invalid_json");
}

function extractWikiLinks(content) {
  const links = new Set();
  for (const match of String(content ?? "").matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) links.add(match[1].trim());
  return [...links];
}
