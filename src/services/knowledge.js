import { HttpError } from "../core/http.js";
import { parseFrontmatter, serializeFrontmatter } from "../core/frontmatter.js";
import { louvain } from "../core/louvain.js";
import { computeRelatedEdges } from "../core/relevance.js";
import {
  cosine, featureVector, id, now, sha256, tokenize,
} from "../core/utils.js";
import { computeGraphInsights } from "./insights.js";

function kbView(row, pending = 0, documents = 0) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    master_version: row.master_version,
    merge_batch_size: row.merge_batch_size,
    merge_interval_minutes: row.merge_interval_minutes,
    ingest_mode: row.ingest_mode,
    compile_model: row.compile_model,
    pending_changes: pending,
    document_count: documents,
    updated_at: row.updated_at,
  };
}

export class KnowledgeService {
  constructor(db, documentParser = null, config = null) {
    this.db = db;
    this.documentParser = documentParser;
    this.config = config;
    // Fire-and-forget observers notified after every publish (merge). Used by
    // the structural lint pass; hooks must swallow their own errors.
    this.publishHooks = [];
  }

  listKnowledgeBases() {
    return this.db.prepare(`SELECT kb.*,
      (SELECT COUNT(*) FROM knowledge_changes c WHERE c.kb_id=kb.id AND c.status='pending') AS pending,
      (SELECT COUNT(*) FROM knowledge_documents d WHERE d.kb_id=kb.id AND d.version=kb.master_version) AS documents
      FROM knowledge_bases kb ORDER BY kb.updated_at DESC`).all()
      .map((row) => kbView(row, row.pending, row.documents));
  }

  getKnowledgeBase(kbId) {
    const row = this.db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(kbId);
    if (!row) throw new HttpError(404, "Knowledge base not found", "kb_not_found");
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes WHERE kb_id=? AND status='pending'").get(kbId).count;
    const documents = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE kb_id=? AND version=?").get(kbId, row.master_version).count;
    return kbView(row, pending, documents);
  }

  createKnowledgeBase(input) {
    if (!input.name) throw new HttpError(400, "Knowledge base name is required", "invalid_kb");
    const kbId = id("kb");
    const timestamp = now();
    const templates = systemPageTemplates();
    const ingestMode = input.ingest_mode ?? this.config?.wiki?.defaultIngestMode ?? "review";
    if (!["review", "auto"].includes(ingestMode)) throw new HttpError(400, "ingest_mode must be review or auto", "invalid_kb");
    this.db.prepare(`INSERT INTO knowledge_bases
      (id,name,description,master_version,merge_batch_size,merge_interval_minutes,schema_md,purpose_md,ingest_mode,compile_model,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      kbId, input.name, input.description ?? "", 1, Number(input.merge_batch_size ?? 3),
      Number(input.merge_interval_minutes ?? 60),
      input.schema_md ?? templates.find((page) => page.pageType === "schema")?.content ?? "",
      input.purpose_md ?? templates.find((page) => page.pageType === "purpose")?.content ?? "",
      ingestMode, String(input.compile_model ?? ""), timestamp, timestamp,
    );
    this.db.prepare(`INSERT INTO knowledge_versions
      (id,kb_id,version,parent_version,summary,change_count,conflict_count,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id("ver"), kbId, 1, null, "Initial wiki with system pages", 0, 0, timestamp);
    if (input.owner_id) this.db.prepare("INSERT INTO knowledge_collaborators (kb_id,user_id,role,created_at) VALUES (?,?,?,?)").run(kbId, input.owner_id, "owner", timestamp);
    this.installSystemPages(kbId, 1);
    return this.getKnowledgeBase(kbId);
  }

  updateKnowledgeBase(kbId, input) {
    const kb = this.getKnowledgeBase(kbId);
    const name = input.name === undefined ? kb.name : String(input.name).trim();
    if (!name) throw new HttpError(400, "Knowledge base name is required", "invalid_kb");
    const mergeBatchSize = Number(input.merge_batch_size ?? kb.merge_batch_size);
    const mergeIntervalMinutes = Number(input.merge_interval_minutes ?? kb.merge_interval_minutes);
    if (!Number.isInteger(mergeBatchSize) || mergeBatchSize < 1 || mergeBatchSize > 1000) {
      throw new HttpError(400, "merge_batch_size must be between 1 and 1000", "invalid_kb");
    }
    if (!Number.isInteger(mergeIntervalMinutes) || mergeIntervalMinutes < 1 || mergeIntervalMinutes > 10080) {
      throw new HttpError(400, "merge_interval_minutes must be between 1 and 10080", "invalid_kb");
    }
    const ingestMode = input.ingest_mode === undefined ? kb.ingest_mode : String(input.ingest_mode);
    if (!["review", "auto"].includes(ingestMode)) throw new HttpError(400, "ingest_mode must be review or auto", "invalid_kb");
    const compileModel = input.compile_model === undefined ? kb.compile_model : String(input.compile_model).trim();
    this.db.prepare(`UPDATE knowledge_bases SET
      name=?,description=?,merge_batch_size=?,merge_interval_minutes=?,ingest_mode=?,compile_model=?,updated_at=? WHERE id=?`).run(
      name,
      input.description === undefined ? kb.description : String(input.description),
      mergeBatchSize,
      mergeIntervalMinutes,
      ingestMode,
      compileModel,
      now(),
      kbId,
    );
    return this.getKnowledgeBase(kbId);
  }

  deleteKnowledgeBase(kbId) {
    const kb = this.getKnowledgeBase(kbId);
    this.db.prepare("DELETE FROM knowledge_bases WHERE id=?").run(kbId);
    return { id: kbId, name: kb.name, deleted: true };
  }

  listDocuments(kbId, version = null) {
    const kb = this.getKnowledgeBase(kbId);
    const selectedVersion = version === null ? kb.master_version : Number(version);
    this.requireVersion(kbId, selectedVersion);
    return this.db.prepare(`SELECT id,path,page_type,title,confidence,content_hash,updated_at,length(content) AS size
      FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path`).all(kbId, selectedVersion)
      .map((document) => ({ ...document, version: selectedVersion }));
  }

  listPages(kbId, options = {}) {
    const kb = this.getKnowledgeBase(kbId);
    const version = options.version === undefined ? kb.master_version : Number(options.version);
    this.requireVersion(kbId, version);
    const clauses = ["kb_id=? AND version=?"];
    const values = [kbId, version];
    if (options.page_type) {
      clauses.push("page_type=?");
      values.push(String(options.page_type));
    }
    return this.db.prepare(`SELECT id,path,page_type,title,confidence,sources_json,frontmatter_json,content_hash,updated_at,length(content) AS size
      FROM knowledge_documents WHERE ${clauses.join(" AND ")} ORDER BY path`).all(...values)
      .map((row) => ({
        ...row,
        version,
        sources: JSON.parse(row.sources_json),
        frontmatter: JSON.parse(row.frontmatter_json),
      }));
  }

  getDocument(kbId, documentPath, version = null) {
    if (!documentPath) throw new HttpError(400, "Document path is required", "invalid_document");
    const kb = this.getKnowledgeBase(kbId);
    const selectedVersion = version === null ? kb.master_version : Number(version);
    this.requireVersion(kbId, selectedVersion);
    const document = this.db.prepare(`SELECT id,path,content,content_hash,page_type,title,confidence,sources_json,updated_at,length(content) AS size
      FROM knowledge_documents WHERE kb_id=? AND version=? AND path=?`).get(kbId, selectedVersion, documentPath);
    if (!document) throw new HttpError(404, "Document not found in selected version", "document_not_found");
    return { ...document, version: selectedVersion, sources: JSON.parse(document.sources_json) };
  }

  getVersion(kbId, version) {
    this.getKnowledgeBase(kbId);
    const row = this.requireVersion(kbId, Number(version));
    return { ...row, documents: this.listDocuments(kbId, Number(version)) };
  }

  requireVersion(kbId, version) {
    const row = this.db.prepare("SELECT * FROM knowledge_versions WHERE kb_id=? AND version=?").get(kbId, version);
    if (!row) throw new HttpError(404, "Knowledge version not found", "version_not_found");
    return row;
  }

  listCollaborators(kbId) {
    this.getKnowledgeBase(kbId);
    return this.db.prepare("SELECT * FROM knowledge_collaborators WHERE kb_id=? ORDER BY role,user_id").all(kbId);
  }

  setCollaborator(kbId, userId, role = "editor") {
    this.getKnowledgeBase(kbId);
    if (!userId || !["viewer", "editor", "maintainer", "owner"].includes(role)) throw new HttpError(400, "user_id and a valid role are required", "invalid_collaborator");
    this.db.prepare(`INSERT INTO knowledge_collaborators (kb_id,user_id,role,created_at) VALUES (?,?,?,?)
      ON CONFLICT(kb_id,user_id) DO UPDATE SET role=excluded.role`).run(kbId, userId, role, now());
    return this.db.prepare("SELECT * FROM knowledge_collaborators WHERE kb_id=? AND user_id=?").get(kbId, userId);
  }

  listConflicts(kbId) {
    this.getKnowledgeBase(kbId);
    return this.db.prepare("SELECT * FROM knowledge_conflicts WHERE kb_id=? ORDER BY created_at DESC,rowid DESC").all(kbId);
  }

  listImports(kbId) {
    this.getKnowledgeBase(kbId);
    return this.db.prepare("SELECT * FROM knowledge_imports WHERE kb_id=? ORDER BY created_at DESC,rowid DESC").all(kbId);
  }

  listChanges(kbId) {
    this.getKnowledgeBase(kbId);
    return this.db.prepare("SELECT * FROM knowledge_changes WHERE kb_id=? ORDER BY created_at DESC,rowid DESC").all(kbId)
      .map((row) => ({ ...row, conflict: Boolean(row.conflict) }));
  }

  listVersions(kbId) {
    this.getKnowledgeBase(kbId);
    return this.db.prepare("SELECT * FROM knowledge_versions WHERE kb_id=? ORDER BY version DESC").all(kbId);
  }

  getSchema(kbId) {
    const row = this.db.prepare("SELECT schema_md FROM knowledge_bases WHERE id=?").get(kbId);
    if (!row) throw new HttpError(404, "Knowledge base not found", "kb_not_found");
    return { kb_id: kbId, path: this.systemPath("schema"), content: row.schema_md ?? "" };
  }

  updateSchema(kbId, input) {
    const kb = this.getKnowledgeBase(kbId);
    const content = String(input.content ?? "");
    if (!content.trim()) throw new HttpError(400, "content is required", "invalid_schema");
    const author = String(input.author ?? "local-user");
    this.db.prepare("UPDATE knowledge_bases SET schema_md=?,updated_at=? WHERE id=?").run(content, now(), kbId);
    const submitted = this.submitChange(kbId, { path: this.systemPath("schema"), content, author, submitted_by: author, base_version: kb.master_version });
    this.logWiki(kbId, kb.master_version, "system", `Schema updated (change ${submitted.change.id})`);
    return { kb_id: kbId, path: this.systemPath("schema"), content, change: submitted.change };
  }

  getPurpose(kbId) {
    const row = this.db.prepare("SELECT purpose_md FROM knowledge_bases WHERE id=?").get(kbId);
    if (!row) throw new HttpError(404, "Knowledge base not found", "kb_not_found");
    return { kb_id: kbId, path: this.systemPath("purpose"), content: row.purpose_md ?? "" };
  }

  updatePurpose(kbId, input) {
    const kb = this.getKnowledgeBase(kbId);
    const content = String(input.content ?? "");
    if (!content.trim()) throw new HttpError(400, "content is required", "invalid_purpose");
    const author = String(input.author ?? "local-user");
    this.db.prepare("UPDATE knowledge_bases SET purpose_md=?,updated_at=? WHERE id=?").run(content, now(), kbId);
    const submitted = this.submitChange(kbId, { path: this.systemPath("purpose"), content, author, submitted_by: author, base_version: kb.master_version });
    this.logWiki(kbId, kb.master_version, "system", `Purpose updated (change ${submitted.change.id})`);
    return { kb_id: kbId, path: this.systemPath("purpose"), content, change: submitted.change };
  }

  systemPath(name) {
    return this.config?.wiki?.systemPaths?.[name] ?? SYSTEM_PAGE_PATHS[name];
  }

  // New knowledge bases get the five system pages as version-1 documents.
  installSystemPages(kbId, version) {
    const timestamp = now();
    const insert = this.db.prepare(`INSERT INTO knowledge_documents
      (id,kb_id,version,path,content,content_hash,updated_at,page_type,title,frontmatter_json,confidence,sources_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const page of systemPageTemplates()) {
      insert.run(id("doc"), kbId, version, page.path, page.content, sha256(page.content), timestamp,
        page.pageType, page.title, JSON.stringify({ type: page.pageType, title: page.title, confidence: "INFERRED", tags: [] }),
        "INFERRED", "[]");
    }
    this.rebuildIndex(kbId, version);
    this.logWiki(kbId, version, "system", `Installed system pages for master v${version}`);
  }

  // One-time legacy seeding: stage missing system pages as pending Changes so
  // the owner reviews and merges them through the normal governance path.
  ensureSystemPagesForAll() {
    const marker = this.db.prepare("SELECT value FROM system_metadata WHERE key='wiki_system_pages_v1'").get();
    if (marker) return { created: 0, skipped: true };
    const knowledgeBases = this.db.prepare("SELECT id FROM knowledge_bases").all();
    let created = 0;
    for (const kb of knowledgeBases) created += this.ensureSystemPages(kb.id);
    this.db.prepare("INSERT INTO system_metadata (key,value,updated_at) VALUES ('wiki_system_pages_v1','1',?)").run(now());
    return { created, skipped: false };
  }

  ensureSystemPages(kbId) {
    const kb = this.getKnowledgeBase(kbId);
    const existing = new Set(this.db.prepare("SELECT path FROM knowledge_documents WHERE kb_id=? AND version=?")
      .all(kbId, kb.master_version).map((row) => row.path));
    let created = 0;
    for (const page of systemPageTemplates()) {
      if (existing.has(page.path)) continue;
      this.stageSystemChange(kbId, page);
      created += 1;
    }
    return created;
  }

  stageSystemChange(kbId, page) {
    const kb = this.getKnowledgeBase(kbId);
    const changeId = id("chg");
    const timestamp = now();
    this.db.prepare(`INSERT INTO knowledge_changes
      (id,kb_id,base_version,path,operation,content,author,status,created_at,revision,updated_at,submitted_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      changeId, kbId, kb.master_version, page.path, "upsert", page.content, "wiki-setup",
      "pending", timestamp, 1, timestamp, "wiki-setup",
    );
    this.db.prepare(`INSERT INTO knowledge_change_revisions
      (id,change_id,revision,path,operation,content,author,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      id("rev"), changeId, 1, page.path, "upsert", page.content, "wiki-setup", timestamp,
    );
    this.logWiki(kbId, kb.master_version, "system", `Staged system page ${page.path} (change ${changeId})`);
    return changeId;
  }

  logWiki(kbId, version, kind, detail) {
    this.db.prepare("INSERT INTO wiki_log (id,kb_id,version,kind,detail,created_at) VALUES (?,?,?,?,?,?)")
      .run(id("wlg"), kbId, version ?? null, kind, detail, now());
  }

  submitChange(kbId, input) {
    const kb = this.getKnowledgeBase(kbId);
    this.assertCanEdit(kbId, input.submitted_by ?? input.author);
    const operation = input.operation ?? "upsert";
    if (!input.path || !["upsert", "delete"].includes(operation)) {
      throw new HttpError(400, "path and a valid operation are required", "invalid_change");
    }
    if (operation === "upsert" && !String(input.content ?? "").trim()) {
      throw new HttpError(400, "content is required for an upsert", "invalid_change");
    }
    const changeId = id("chg");
    const timestamp = now();
    this.db.prepare(`INSERT INTO knowledge_changes
      (id,kb_id,base_version,path,operation,content,author,status,created_at,revision,updated_at,submitted_by,batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      changeId, kbId, Number(input.base_version ?? kb.master_version), input.path, operation,
      input.content ?? "", input.author ?? "local-user", "pending", timestamp, 1, timestamp,
      input.submitted_by ?? input.author ?? "local-user", input.batch_id ?? null,
    );
    this.db.prepare(`INSERT INTO knowledge_change_revisions
      (id,change_id,revision,path,operation,content,author,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      id("rev"), changeId, 1, input.path, operation, input.content ?? "", input.author ?? "local-user", timestamp,
    );
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes WHERE kb_id=? AND status='pending'").get(kbId).count;
    // Q4: batch auto-merge only applies to auto-mode knowledge bases. Review
    // mode stages changes for human review — auto-merging here would shred a
    // large compiler batch into many tiny versions mid-submission.
    const auto_merged = kb.ingest_mode === "auto" && pending >= kb.merge_batch_size
      ? this.merge(kbId, `Automatic batch merge (${pending} changes)`)
      : null;
    return { change: this.db.prepare("SELECT * FROM knowledge_changes WHERE id=?").get(changeId), auto_merged };
  }

  updateChange(kbId, changeId, input) {
    this.getKnowledgeBase(kbId);
    const change = this.db.prepare("SELECT * FROM knowledge_changes WHERE id=? AND kb_id=?").get(changeId, kbId);
    if (!change) throw new HttpError(404, "Change not found", "change_not_found");
    if (change.status !== "pending") throw new HttpError(409, "Only pending changes can be modified", "change_immutable");
    this.assertCanEdit(kbId, input.submitted_by ?? input.author ?? change.author);
    if (input.expected_revision !== undefined && Number(input.expected_revision) !== change.revision) {
      throw new HttpError(409, "The change was modified by another editor", "revision_conflict", { expected_revision: Number(input.expected_revision), current_revision: change.revision, current: change });
    }
    const operation = input.operation ?? change.operation;
    const documentPath = input.path === undefined ? change.path : String(input.path).trim();
    const content = input.content === undefined ? change.content : String(input.content);
    const author = input.author === undefined ? change.author : String(input.author).trim();
    if (!documentPath || !author || !["upsert", "delete"].includes(operation)) {
      throw new HttpError(400, "path, author and a valid operation are required", "invalid_change");
    }
    if (operation === "upsert" && !content.trim()) {
      throw new HttpError(400, "content is required for an upsert", "invalid_change");
    }
    const revision = change.revision + 1;
    const timestamp = now();
    this.db.prepare(`UPDATE knowledge_changes SET path=?,operation=?,content=?,author=?,revision=?,updated_at=?
      WHERE id=? AND kb_id=?`).run(documentPath, operation, operation === "delete" ? "" : content, author, revision, timestamp, changeId, kbId);
    this.db.prepare(`INSERT INTO knowledge_change_revisions
      (id,change_id,revision,path,operation,content,author,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      id("rev"), changeId, revision, documentPath, operation, operation === "delete" ? "" : content, author, timestamp,
    );
    return this.db.prepare("SELECT * FROM knowledge_changes WHERE id=?").get(changeId);
  }

  deleteChange(kbId, changeId) {
    this.getKnowledgeBase(kbId);
    const change = this.db.prepare("SELECT * FROM knowledge_changes WHERE id=? AND kb_id=?").get(changeId, kbId);
    if (!change) throw new HttpError(404, "Change not found", "change_not_found");
    if (change.status !== "pending") throw new HttpError(409, "Merged changes are immutable", "change_immutable");
    this.db.prepare("DELETE FROM knowledge_changes WHERE id=? AND kb_id=?").run(changeId, kbId);
    return { id: changeId, deleted: true };
  }

  listChangeRevisions(kbId, changeId) {
    this.getKnowledgeBase(kbId);
    const change = this.db.prepare("SELECT id FROM knowledge_changes WHERE id=? AND kb_id=?").get(changeId, kbId);
    if (!change) throw new HttpError(404, "Change not found", "change_not_found");
    return this.db.prepare("SELECT * FROM knowledge_change_revisions WHERE change_id=? ORDER BY revision DESC").all(changeId);
  }

  async importDocument(kbId, input) {
    const kb = this.getKnowledgeBase(kbId);
    this.assertCanEdit(kbId, input.author);
    if (!this.documentParser) throw new HttpError(503, "Document parser is unavailable", "parser_unavailable");
    const importId = id("imp");
    const filename = String(input.filename ?? "").trim();
    const author = String(input.author ?? "local-user");
    const timestamp = now();
    this.db.prepare(`INSERT INTO knowledge_imports
      (id,kb_id,filename,media_type,size_bytes,status,author,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      importId, kbId, filename || "unnamed", input.media_type ?? "application/octet-stream", 0, "parsing", author, timestamp,
    );
    try {
      const parsed = await this.documentParser.parse(input);
      const documentPath = String(input.path ?? filename).replaceAll("\\", "/");
      const submitted = this.submitChange(kbId, { path: documentPath, content: parsed.content, author, submitted_by: input.submitted_by ?? author, base_version: input.base_version ?? kb.master_version });
      this.db.prepare("UPDATE knowledge_imports SET media_type=?,size_bytes=?,status='staged',change_id=? WHERE id=?")
        .run(parsed.media_type, parsed.size_bytes, submitted.change.id, importId);
      let published = submitted.auto_merged;
      if (input.publish === true && !published) published = this.merge(kbId, `Import ${filename}`);
      if (published) this.db.prepare("UPDATE knowledge_imports SET status='published' WHERE id=?").run(importId);
      return { import: this.db.prepare("SELECT * FROM knowledge_imports WHERE id=?").get(importId), change: submitted.change, published, pages: parsed.pages ?? null };
    } catch (error) {
      this.db.prepare("UPDATE knowledge_imports SET status='failed',error=? WHERE id=?").run(error.message, importId);
      throw error;
    }
  }

  merge(kbId, summary = "Manual batch merge") {
    const kb = this.getKnowledgeBase(kbId);
    // rowid preserves submit order when multiple changes share the same millisecond timestamp.
    const changes = this.db.prepare("SELECT * FROM knowledge_changes WHERE kb_id=? AND status='pending' ORDER BY created_at,rowid").all(kbId);
    if (changes.length === 0) throw new HttpError(409, "There are no pending changes", "nothing_to_merge");
    const nextVersion = kb.master_version + 1;
    const seenPaths = new Set();
    const latestChangeByPath = new Map();
    let conflicts = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO knowledge_documents
        (id,kb_id,version,path,content,content_hash,updated_at,page_type,title,frontmatter_json,confidence,sources_json)
        SELECT 'doc_' || lower(hex(randomblob(10))),kb_id,?,path,content,content_hash,updated_at,page_type,title,frontmatter_json,confidence,sources_json
        FROM knowledge_documents WHERE kb_id=? AND version=?`).run(nextVersion, kbId, kb.master_version);

      const remove = this.db.prepare("DELETE FROM knowledge_documents WHERE kb_id=? AND version=? AND path=?");
      const upsert = this.db.prepare(`INSERT INTO knowledge_documents
        (id,kb_id,version,path,content,content_hash,updated_at,page_type,title,frontmatter_json,confidence,sources_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(kb_id,version,path) DO UPDATE SET
        content=excluded.content,content_hash=excluded.content_hash,updated_at=excluded.updated_at,
        page_type=excluded.page_type,title=excluded.title,frontmatter_json=excluded.frontmatter_json,
        confidence=excluded.confidence,sources_json=excluded.sources_json`);
      const mark = this.db.prepare("UPDATE knowledge_changes SET status='merged',merged_version=?,conflict=? WHERE id=?");
      const addConflict = this.db.prepare(`INSERT INTO knowledge_conflicts
        (id,kb_id,version,path,earlier_change_id,winning_change_id,reason,resolution,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      const addTombstone = this.db.prepare(`INSERT INTO knowledge_tombstones
        (id,kb_id,path,deleted_version,change_id,author,created_at) VALUES (?,?,?,?,?,?,?)`);

      for (const change of changes) {
        const conflict = change.base_version !== kb.master_version || seenPaths.has(change.path);
        if (conflict) conflicts += 1;
        if (conflict) addConflict.run(
          id("cnf"), kbId, nextVersion, change.path, latestChangeByPath.get(change.path) ?? null, change.id,
          seenPaths.has(change.path) ? "concurrent_path_update" : "stale_base_version", "latest_submitted_wins", now(),
        );
        seenPaths.add(change.path);
        latestChangeByPath.set(change.path, change.id);
        if (change.operation === "delete") {
          remove.run(kbId, nextVersion, change.path);
          addTombstone.run(id("del"), kbId, change.path, nextVersion, change.id, change.author, now());
        } else {
          // Derive wiki page metadata from the merged content's frontmatter so
          // compiler-generated pages keep page_type/confidence/sources[].
          const parsed = parseFrontmatter(change.content);
          const metadata = parsed.metadata;
          const type = pageTypeFromPath(change.path)
            ?? (typeof metadata.type === "string" && WIKI_PAGE_TYPES.includes(metadata.type) ? metadata.type : null)
            ?? "wiki";
          const title = typeof metadata.title === "string" && metadata.title.trim()
            ? metadata.title.trim()
            : firstHeadingOf(change.content) ?? change.path;
          const confidence = WIKI_CONFIDENCE_LEVELS.includes(metadata.confidence) ? metadata.confidence : "INFERRED";
          const sources = Array.isArray(metadata.sources) ? metadata.sources.map(String) : [];
          upsert.run(id("doc"), kbId, nextVersion, change.path, change.content, sha256(change.content), now(),
            type, title, JSON.stringify(metadata), confidence, JSON.stringify(sources));
        }
        mark.run(nextVersion, conflict ? 1 : 0, change.id);
      }

      this.db.prepare(`INSERT INTO knowledge_versions
        (id,kb_id,version,parent_version,summary,change_count,conflict_count,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id("ver"), kbId, nextVersion, kb.master_version, summary, changes.length, conflicts, now());
      this.db.prepare("UPDATE knowledge_bases SET master_version=?,updated_at=? WHERE id=?").run(nextVersion, now(), kbId);
      this.rebuildIndex(kbId, nextVersion);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const hook of this.publishHooks) {
      try { hook(kbId, nextVersion); } catch (error) { console.error("Knowledge publish hook failed", error); }
    }
    return { kb_id: kbId, version: nextVersion, parent_version: kb.master_version, change_count: changes.length, conflict_count: conflicts };
  }

  rebuildIndex(kbId, version) {
    this.db.prepare("DELETE FROM knowledge_chunks WHERE kb_id=? AND version=?").run(kbId, version);
    const documents = this.db.prepare("SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path").all(kbId, version);
    const insert = this.db.prepare(`INSERT INTO knowledge_chunks
      (id,kb_id,version,document_path,chunk_index,content,heading_path,char_count,tokens_json,vector_json) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const document of documents) {
      splitDocument(document.content).forEach((chunk) => {
        insert.run(id("chk"), kbId, version, document.path, chunk.chunk_index, chunk.content, chunk.heading_path, chunk.char_count,
          JSON.stringify(tokenize(chunk.content)), JSON.stringify(featureVector(chunk.content)));
      });
    }
    this.rebuildGraph(kbId, version, documents);
  }

  rebuildGraph(kbId, version, documents = null) {
    this.db.prepare("DELETE FROM knowledge_graph_nodes WHERE kb_id=? AND version=?").run(kbId, version);
    this.db.prepare("DELETE FROM knowledge_graph_edges WHERE kb_id=? AND version=?").run(kbId, version);
    const sourceDocuments = documents ?? this.db.prepare("SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path").all(kbId, version);
    const addNode = this.db.prepare(`INSERT OR IGNORE INTO knowledge_graph_nodes
      (id,kb_id,version,node_key,label,kind,document_path,metadata_json) VALUES (?,?,?,?,?,?,?,?)`);
    const addEdge = this.db.prepare(`INSERT INTO knowledge_graph_edges
      (id,kb_id,version,source_key,target_key,relation,weight,metadata_json) VALUES (?,?,?,?,?,?,?,?)`);
    const knownPaths = new Set(sourceDocuments.map((document) => document.path));
    const linkPairs = [];
    for (const document of sourceDocuments) {
      const documentKey = `document:${document.path}`;
      addNode.run(id("node"), kbId, version, documentKey, document.path, "document", document.path, "{}");
      for (const heading of extractHeadings(document.content)) {
        const headingKey = `heading:${document.path}#${heading.slug}`;
        addNode.run(id("node"), kbId, version, headingKey, heading.label, "heading", document.path, JSON.stringify({ level: heading.level }));
        addEdge.run(id("edge"), kbId, version, documentKey, headingKey, "contains", 1, "{}");
      }
      for (const tag of extractTags(document.content)) {
        const tagKey = `tag:${tag.toLowerCase()}`;
        addNode.run(id("node"), kbId, version, tagKey, tag, "tag", null, "{}");
        addEdge.run(id("edge"), kbId, version, documentKey, tagKey, "tagged_with", 1, "{}");
      }
      for (const target of extractLinks(document.content)) {
        const normalized = resolveDocumentLink(document.path, target, knownPaths);
        const targetKey = normalized ? `document:${normalized}` : `reference:${target}`;
        addNode.run(id("node"), kbId, version, targetKey, normalized ?? target, normalized ? "document" : "reference", normalized, "{}");
        addEdge.run(id("edge"), kbId, version, documentKey, targetKey, "links_to", 1, JSON.stringify({ original: target }));
        if (normalized && normalized !== document.path) linkPairs.push([document.path, normalized]);
      }
    }
    this.insertRelatedEdges(kbId, version, linkPairs);
  }

  /** Insert 4-signal related edges (G12). Returns the number inserted. */
  insertRelatedEdges(kbId, version, linkPairs = null) {
    const docRows = this.db.prepare("SELECT path,page_type,sources_json,content FROM knowledge_documents WHERE kb_id=? AND version=?").all(kbId, version);
    if (!docRows.length) return 0;
    const pairs = linkPairs ?? this.documentLinkPairs(kbId, version, new Set(docRows.map((row) => row.path)));
    const related = computeRelatedEdges(docRows.map((row) => ({ path: row.path, page_type: row.page_type, sources: JSON.parse(row.sources_json), content: row.content })), pairs);
    const addRelated = this.db.prepare(`INSERT OR IGNORE INTO knowledge_graph_edges
      (id,kb_id,version,source_key,target_key,relation,weight,metadata_json) VALUES (?,?,?,?,?,?,?,?)`);
    for (const edge of related) {
      addRelated.run(id("edge"), kbId, version, edge.source, edge.target, "related", edge.weight,
        JSON.stringify({ signals: edge.signals }));
    }
    return related.length;
  }

  /** Lazy legacy upgrade: recompute related edges for versions built before Phase 3. */
  ensureRelatedEdges(kbId, version) {
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM knowledge_graph_edges WHERE kb_id=? AND version=? AND relation='related'").get(kbId, version).c;
    if (count > 0) return;
    this.insertRelatedEdges(kbId, version);
  }

  documentLinkPairs(kbId, version, knownPaths) {
    const documents = this.db.prepare("SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=?").all(kbId, version);
    const pairs = [];
    for (const document of documents) {
      for (const target of extractLinks(document.content)) {
        const normalized = resolveDocumentLink(document.path, target, knownPaths);
        if (normalized && normalized !== document.path) pairs.push([document.path, normalized]);
      }
    }
    return pairs;
  }

  graph(kbId, version = null) {
    const kb = this.getKnowledgeBase(kbId);
    const selectedVersion = version === null ? kb.master_version : Number(version);
    this.requireVersion(kbId, selectedVersion);
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE kb_id=? AND version=?").get(kbId, selectedVersion).count;
    if (existing === 0) this.rebuildGraph(kbId, selectedVersion);
    this.ensureRelatedEdges(kbId, selectedVersion);
    const nodes = this.db.prepare("SELECT node_key AS id,label,kind,document_path,metadata_json FROM knowledge_graph_nodes WHERE kb_id=? AND version=? ORDER BY kind,label").all(kbId, selectedVersion).map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) }));
    const edges = this.db.prepare("SELECT source_key AS source,target_key AS target,relation,weight,metadata_json FROM knowledge_graph_edges WHERE kb_id=? AND version=? ORDER BY relation,source_key").all(kbId, selectedVersion).map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) }));

    // Communities + insights over the document-level related graph (G13).
    const docNodes = nodes.filter((node) => node.kind === "document");
    const relatedEdges = edges.filter((edge) => edge.relation === "related")
      .map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight }));
    let communities = {};
    let communitySummary = [];
    let insights = { isolated: [], sparse: [], bridges: [], surprising: [] };
    if (docNodes.length > 1 && relatedEdges.length) {
      const detection = louvain(docNodes.map((node) => ({ id: node.id })), relatedEdges);
      communities = detection.communities;
      communitySummary = summarizeCommunities(docNodes, relatedEdges, communities);
      insights = computeGraphInsights(docNodes, relatedEdges, communities);
    }
    const nodesWithCommunity = nodes.map((node) => node.kind === "document"
      ? { ...node, community: communities[node.id] ?? 0 }
      : node);
    // ADR-015 (B): attach usage heat (query_hits) so the console can tint
    // nodes by how often agent answers cited them.
    const hits = new Map(this.db.prepare("SELECT path, hits FROM wiki_query_hits WHERE kb_id=?").all(kbId)
      .map((row) => [row.path, row.hits]));
    const nodesWithHits = nodesWithCommunity.map((node) => node.kind === "document"
      ? { ...node, query_hits: hits.get(node.document_path) ?? 0 }
      : node);
    return {
      kb_id: kbId,
      version: selectedVersion,
      nodes: nodesWithHits,
      edges,
      communities: communitySummary,
      insights,
    };
  }

  /** ADR-015 (B): record that agent answers cited these pages. Counter runs
   *  on a 30-day window: a page idle for >30 days resets to 1. */
  recordQueryHits(kbId, paths) {
    const unique = [...new Set((Array.isArray(paths) ? paths : []).map(String).filter(Boolean))];
    if (!unique.length) return 0;
    const upsert = this.db.prepare(`INSERT INTO wiki_query_hits (kb_id,path,hits,last_hit_at) VALUES (?,?,1,?)
      ON CONFLICT(kb_id,path) DO UPDATE SET
        hits = CASE WHEN julianday(excluded.last_hit_at) - julianday(last_hit_at) > 30 THEN 1 ELSE hits + 1 END,
        last_hit_at = excluded.last_hit_at`);
    const timestamp = now();
    for (const path of unique) upsert.run(kbId, path, timestamp);
    return unique.length;
  }

  search(kbId, query, options = {}) {
    const kb = this.getKnowledgeBase(kbId);
    const topK = Math.min(20, Math.max(1, Number(options.top_k ?? 5)));
    const keywordWeight = Number(options.keyword_weight ?? 0.45);
    const vectorWeight = Number(options.vector_weight ?? 0.55);
    // Q11: system pages (index/log/purpose/schema/overview) are excluded from
    // retrieval by default; the LLM navigates them directly through index.md.
    const systemClause = options.include_system
      ? ""
      : ` AND document_path NOT IN (${Object.values(SYSTEM_PAGE_PATHS).map((pagePath) => `'${String(pagePath).replace(/'/g, "''")}'`).join(",")})`;
    // Raw/degraded archives (atlasgate-degraded) are excluded from default
    // retrieval; pass include_raw to surface them (they await recompilation).
    const degradedPaths = options.include_raw
      ? []
      : this.db.prepare("SELECT path FROM knowledge_documents WHERE kb_id=? AND version=? AND frontmatter_json LIKE '%atlasgate-degraded%'").all(kbId, kb.master_version).map((row) => row.path);
    const degradedClause = degradedPaths.length
      ? ` AND document_path NOT IN (${degradedPaths.map((pagePath) => `'${String(pagePath).replace(/'/g, "''")}'`).join(",")})`
      : "";
    let chunks = this.db.prepare(`SELECT * FROM knowledge_chunks WHERE kb_id=? AND version=?${systemClause}${degradedClause}`).all(kbId, kb.master_version);
    if (options.path_glob) {
      const matcher = globMatcher(String(options.path_glob));
      chunks = chunks.filter((chunk) => matcher.test(chunk.document_path));
    }
    if (chunks.length === 0) return [];
    const queryTokens = tokenize(query);
    const queryVector = featureVector(query);
    const documentFrequency = new Map();
    for (const chunk of chunks) {
      for (const token of new Set(JSON.parse(chunk.tokens_json))) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
    const scored = chunks.map((chunk) => {
      const tokens = JSON.parse(chunk.tokens_json);
      const frequencies = new Map();
      tokens.forEach((token) => frequencies.set(token, (frequencies.get(token) ?? 0) + 1));
      let bm25 = 0;
      for (const token of queryTokens) {
        const tf = frequencies.get(token) ?? 0;
        const df = documentFrequency.get(token) ?? 0;
        if (tf > 0) bm25 += Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5)) * ((tf * 2.2) / (tf + 1.2));
      }
      const keywordScore = 1 - Math.exp(-bm25 / 4);
      const vectorScore = Math.max(0, cosine(queryVector, JSON.parse(chunk.vector_json)));
      // The local feature vector is a deterministic offline fallback, not a
      // semantic embedding. Reject low-similarity hash collisions without a
      // lexical match so unrelated questions do not become evidence.
      const score = keywordScore === 0 && vectorScore < 0.2
        ? 0
        : keywordWeight * keywordScore + vectorWeight * vectorScore;
      return {
        chunk_id: chunk.id,
        path: chunk.document_path,
        chunk_index: chunk.chunk_index,
        heading_path: chunk.heading_path,
        char_count: chunk.char_count,
        content: chunk.content,
        score: Number(score.toFixed(5)),
        keyword_score: Number(keywordScore.toFixed(5)),
        vector_score: Number(vectorScore.toFixed(5)),
        version: kb.master_version,
      };
    });
    const minScore = Math.max(0, Math.min(1, Number(options.min_score ?? 0)));
    return scored.filter((item) => item.score >= minScore).sort((a, b) => b.score - a.score).slice(0, topK);
  }

  mergeDueBases() {
    // Q4: the scheduled merger only applies to auto-mode knowledge bases;
    // review-mode bases stage changes for human review and must never be
    // auto-merged (the timer would otherwise shred a large batch into many
    // tiny versions the moment pending >= merge_batch_size).
    const due = this.db.prepare(`SELECT kb.id,kb.merge_batch_size,kb.merge_interval_minutes,
      COUNT(c.id) AS pending,MIN(c.created_at) AS oldest
      FROM knowledge_bases kb JOIN knowledge_changes c ON c.kb_id=kb.id AND c.status='pending'
      WHERE kb.ingest_mode='auto'
      GROUP BY kb.id`).all();
    const results = [];
    for (const item of due) {
      const ageMinutes = item.oldest ? (Date.now() - new Date(item.oldest).getTime()) / 60_000 : 0;
      if (item.pending >= item.merge_batch_size || ageMinutes >= item.merge_interval_minutes) {
        results.push(this.merge(item.id, `Scheduled merge (${item.pending} changes, ${Math.floor(ageMinutes)} minutes old)`));
      }
    }
    return results;
  }

  maintenance(kbId, input = {}) {
    const kb = this.getKnowledgeBase(kbId);
    const expiredMemories = this.db.prepare(`UPDATE memories SET status='forgotten'
      WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?`).run(now()).changes;
    const duplicateChunks = this.db.prepare(`SELECT content_hash,COUNT(*) AS count FROM knowledge_documents
      WHERE kb_id=? AND version=? GROUP BY content_hash HAVING COUNT(*)>1`).all(kbId, kb.master_version);
    let merged = null;
    if (input.merge_due !== false && kb.ingest_mode === "auto") {
      const pending = this.db.prepare("SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM knowledge_changes WHERE kb_id=? AND status='pending'").get(kbId);
      const age = pending.oldest ? (Date.now() - new Date(pending.oldest).getTime()) / 60_000 : 0;
      if (pending.count && (pending.count >= kb.merge_batch_size || age >= kb.merge_interval_minutes)) merged = this.merge(kbId, "Agent maintenance merge");
    }
    return { kb_id: kbId, expired_memories_forgotten: expiredMemories, duplicate_document_groups: duplicateChunks.length, merged };
  }

  assertCanEdit(kbId, userId) {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_collaborators WHERE kb_id=?").get(kbId).count;
    if (count === 0 || !userId || userId === "local-user") return;
    const collaborator = this.db.prepare("SELECT role FROM knowledge_collaborators WHERE kb_id=? AND user_id=?").get(kbId, userId);
    if (!collaborator || collaborator.role === "viewer") throw new HttpError(403, "User cannot edit this knowledge base", "knowledge_forbidden");
  }
}

export function splitDocument(content, maxChars = 900, overlap = 120) {
  const limit = Math.max(80, Number(maxChars) || 900);
  const requestedOverlap = Math.max(0, Number(overlap) || 0);
  const effectiveOverlap = Math.min(requestedOverlap, Math.floor(limit / 3));
  const sections = parseWikiSections(content);
  const chunks = [];
  let current = null;

  const append = (text, headingPath) => {
    const value = String(text ?? "").trim();
    if (!value) return;
    if (value.length <= limit) {
      if (current && current.heading_path === headingPath && current.content.length + 2 + value.length <= limit) {
        current.content += `\n\n${value}`;
      } else {
        if (current) chunks.push(current);
        current = { content: value, heading_path: headingPath };
      }
      return;
    }
    if (current) {
      chunks.push(current);
      current = null;
    }
    // A single paragraph/section can be larger than the limit. Hard-split it
    // with bounded overlap so no chunk exceeds the configured maximum.
    let start = 0;
    while (start < value.length) {
      const part = value.slice(start, start + limit).trim();
      if (part) chunks.push({ content: part, heading_path: headingPath });
      if (start + limit >= value.length) break;
      start += Math.max(1, limit - effectiveOverlap);
    }
  };

  for (const section of sections) append(section.content, section.heading_path);
  if (current) chunks.push(current);
  return (chunks.length ? chunks : [{ content: String(content ?? ""), heading_path: "" }]).map((chunk, index) => ({
    ...chunk,
    chunk_index: index,
    char_count: chunk.content.length,
  }));
}

function parseWikiSections(content) {
  const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  const stack = [];
  let linesBuffer = [];
  let headingPath = "";
  let hasBodyLine = false;
  const flush = () => {
    const value = linesBuffer.join("\n").trim();
    if (value) sections.push({ content: value, heading_path: headingPath });
    linesBuffer = [];
    hasBodyLine = false;
  };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (hasBodyLine) flush();
      const level = heading[1].length;
      stack.length = level - 1;
      stack[level - 1] = heading[2].trim();
      headingPath = stack.filter(Boolean).join(" / ");
      linesBuffer.push(line.trim());
    } else if (!line.trim()) {
      if (hasBodyLine) flush();
    } else {
      linesBuffer.push(line);
      hasBodyLine = true;
    }
  }
  flush();
  return sections;
}

function extractHeadings(content) {
  return [...String(content).matchAll(/^(#{1,4})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    label: match[2].trim(),
    slug: match[2].trim().toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "-").replace(/^-|-$/g, ""),
  }));
}

function extractTags(content) {
  const tags = new Set();
  for (const match of String(content).matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,})/gu)) tags.add(match[1]);
  const frontmatter = String(content).match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatter) {
    const line = frontmatter[1].match(/^tags:\s*\[([^\]]+)\]/m);
    for (const tag of line?.[1]?.split(",") ?? []) if (tag.trim()) tags.add(tag.trim().replace(/^['"]|['"]$/g, ""));
  }
  return [...tags];
}

function extractLinks(content) {
  const links = new Set();
  for (const match of String(content).matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) links.add(match[1].trim());
  for (const match of String(content).matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (!/^(?:https?:|mailto:|#)/i.test(match[1])) links.add(match[1].split("#")[0]);
  }
  return [...links];
}

function resolveDocumentLink(sourcePath, target, knownPaths) {
  const normalizedTarget = target.replaceAll("\\", "/");
  const sourceParts = sourcePath.split("/");
  sourceParts.pop();
  for (const part of normalizedTarget.split("/")) {
    if (part === "..") sourceParts.pop();
    else if (part !== "." && part) sourceParts.push(part);
  }
  const resolved = sourceParts.join("/");
  const candidates = [resolved, `${resolved}.md`, normalizedTarget, `${normalizedTarget}.md`];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function globMatcher(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "::DOUBLE::").replaceAll("*", "[^/]*").replaceAll("::DOUBLE::", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i");
}

export const SYSTEM_PAGE_PATHS = {
  purpose: "purpose.md",
  schema: "schema.md",
  index: "index.md",
  log: "log.md",
  overview: "overview.md",
};

export const WIKI_PAGE_TYPES = [
  "entity", "concept", "source", "comparison", "synthesis", "query",
  "overview", "index", "log", "purpose", "schema", "note", "wiki",
];

export const WIKI_CONFIDENCE_LEVELS = ["EXTRACTED", "INFERRED", "AMBIGUOUS", "UNVERIFIED"];

// Taxonomy directories the LLM compiler is allowed to write pages into.
export const WIKI_TAXONOMY_DIRS = ["entities/", "concepts/", "sources/", "comparisons/", "synthesis/", "queries/"];

/** Infer the wiki page type from a document path, or null when ambiguous. */
export function pageTypeFromPath(documentPath) {
  const p = String(documentPath ?? "").replaceAll("\\", "/");
  if (p.startsWith("entities/")) return "entity";
  if (p.startsWith("concepts/")) return "concept";
  if (p.startsWith("sources/")) return "source";
  if (p.startsWith("comparisons/")) return "comparison";
  if (p.startsWith("synthesis/")) return "synthesis";
  if (p.startsWith("queries/")) return "query";
  if (p === "index.md") return "index";
  if (p === "log.md") return "log";
  if (p === "purpose.md") return "purpose";
  if (p === "schema.md") return "schema";
  if (p === "overview.md") return "overview";
  return null;
}

export function firstHeadingOf(content) {
  const match = /^#\s+(.+)$/m.exec(String(content ?? ""));
  return match ? match[1].trim() : null;
}

function summarizeCommunities(docNodes, relatedEdges, communities) {
  const members = new Map();
  for (const node of docNodes) {
    const c = communities[node.id] ?? 0;
    if (!members.has(c)) members.set(c, []);
    members.get(c).push(node.id);
  }
  const edgeCounts = new Map();
  for (const edge of relatedEdges) {
    const ca = communities[edge.source];
    const cb = communities[edge.target];
    if (ca !== undefined && ca === cb) edgeCounts.set(ca, (edgeCounts.get(ca) ?? 0) + 1);
  }
  const summary = [];
  for (const [community, memberList] of members) {
    const size = memberList.length;
    const possible = (size * (size - 1)) / 2;
    const cohesion = possible ? (edgeCounts.get(community) ?? 0) / possible : 0;
    summary.push({ id: community, members: size, cohesion: Number(cohesion.toFixed(3)) });
  }
  summary.sort((a, b) => b.members - a.members);
  return summary;
}

// Starter templates for the five system pages. The LLM Wiki compiler (Phase 1)
// takes over maintaining index.md / log.md / overview.md; purpose.md and
// schema.md stay human + LLM co-evolved.
export function systemPageTemplates() {
  return [
    {
      path: "purpose.md",
      pageType: "purpose",
      title: "知识库目标",
      content: `---
type: purpose
title: 知识库目标
confidence: INFERRED
tags: []
---

# 目的（purpose）

这个知识库服务于什么目标？在这里记录：关键问题、研究范围、演进中的论点。

- 关键问题：
- 研究范围：
- 当前论点：

> 由你与 LLM 共同维护。LLM 在每次摄入（ingest）与查询（query）时都会读取本页作为方向上下文。
`,
    },
    {
      path: "schema.md",
      pageType: "schema",
      title: "Wiki 公约",
      content: `---
type: schema
title: Wiki 公约
confidence: INFERRED
tags: []
---

# Wiki 公约（schema）

LLM 维护本知识库时必须遵守的页面结构与工作流约定。

## 页面类型与目录

| 目录 | 类型 | 用途 |
| --- | --- | --- |
| entities/ | entity | 人物、组织、产品、工具等实体页 |
| concepts/ | concept | 理论、方法、技术等概念页 |
| sources/ | source | 每个原始素材的摘要页 |
| comparisons/ | comparison | 对比分析 |
| synthesis/ | synthesis | 跨素材综合分析 |
| queries/ | query | 保存的优质问答结果 |

## 规范

- 每个页面必须带 frontmatter：type、title、sources[]、confidence（EXTRACTED/INFERRED/AMBIGUOUS/UNVERIFIED）、tags。
- 使用双向链接语法（两个方括号包住页面名）关联相关页面；素材摘要必须通过 sources[] 溯源回原始素材。
- index.md 在每次摄入后更新；log.md 以 "## [YYYY-MM-DD] ingest | 标题" 格式追加。
- 摄入新素材时：先分析（提取实体/概念/矛盾/页面计划），再生成页面变更。
`,
    },
    {
      path: "index.md",
      pageType: "index",
      title: "知识库索引",
      content: `---
type: index
title: 知识库索引
confidence: INFERRED
tags: []
---

# 索引（index）

内容目录：每个页面一行链接 + 摘要。由 Wiki 编译管线在每次摄入后更新。
`,
    },
    {
      path: "log.md",
      pageType: "log",
      title: "操作日志",
      content: `---
type: log
title: 操作日志
confidence: INFERRED
tags: []
---

# 日志（log）

时间线记录。格式：## [YYYY-MM-DD] ingest | 标题（按该前缀可被 unix 工具解析）。
`,
    },
    {
      path: "overview.md",
      pageType: "overview",
      title: "知识库总览",
      content: `---
type: overview
title: 知识库总览
confidence: INFERRED
tags: []
---

# 总览（overview）

全局综述：当前知识库覆盖的主题、核心论点与材料概览。每次摄入后自动再生成。
`,
    },
  ];
}
