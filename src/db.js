import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseFrontmatter } from "./core/frontmatter.js";
import { featureVector, id, now, sha256, tokenize } from "./core/utils.js";
import { splitDocument, systemPageTemplates, pageTypeFromPath } from "./services/knowledge.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 10,
  weight REAL NOT NULL DEFAULT 1, models_json TEXT NOT NULL DEFAULT '[]',
  supports_vision INTEGER NOT NULL DEFAULT 0, quality REAL NOT NULL DEFAULT 0.7,
  input_cost REAL NOT NULL DEFAULT 0, output_cost REAL NOT NULL DEFAULT 0,
  latency_hint_ms INTEGER NOT NULL DEFAULT 1000, reliability REAL NOT NULL DEFAULT 0.95,
  health_status TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL, quota_tokens INTEGER NOT NULL DEFAULT 1000000,
  used_tokens INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, expires_at TEXT
);

CREATE TABLE IF NOT EXISTS system_metadata (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, requested_model TEXT NOT NULL,
  selected_provider TEXT, selected_model TEXT, profile TEXT NOT NULL,
  candidates_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, api_key_id TEXT,
  provider_id TEXT, model TEXT, route TEXT NOT NULL, status INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0, risk_level TEXT NOT NULL DEFAULT 'clean',
  prompt_preview TEXT NOT NULL DEFAULT '', error TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', weight REAL NOT NULL DEFAULT 1,
  quota_tokens INTEGER NOT NULL DEFAULT 0, used_tokens INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, error_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_pool ON provider_credentials(provider_id,enabled,cooldown_until);

CREATE TABLE IF NOT EXISTS model_mappings (
  id TEXT PRIMARY KEY, alias TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 1,
  capabilities_json TEXT NOT NULL DEFAULT '["text"]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(alias,provider_id,upstream_model)
);

CREATE TABLE IF NOT EXISTS provider_attempts (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  provider_id TEXT NOT NULL, credential_id TEXT, model TEXT NOT NULL,
  status INTEGER NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_request ON provider_attempts(request_id,attempt);

CREATE TABLE IF NOT EXISTS provider_balance_snapshots (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  amount REAL, currency TEXT, available INTEGER, status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}', error TEXT, checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_balance_provider ON provider_balance_snapshots(provider_id,checked_at);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly_budget_cents INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, monthly_budget_cents INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY(team_id,user_id)
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  master_version INTEGER NOT NULL DEFAULT 1, merge_batch_size INTEGER NOT NULL DEFAULT 3,
  merge_interval_minutes INTEGER NOT NULL DEFAULT 60, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, parent_version INTEGER, summary TEXT NOT NULL,
  change_count INTEGER NOT NULL DEFAULT 0, conflict_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, UNIQUE(kb_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
  content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kb_id, version, path)
);

CREATE TABLE IF NOT EXISTS knowledge_changes (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL, path TEXT NOT NULL, operation TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', author TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  merged_version INTEGER, conflict INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_collaborators (
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at TEXT NOT NULL,
  PRIMARY KEY(kb_id,user_id)
);

CREATE TABLE IF NOT EXISTS knowledge_change_revisions (
  id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES knowledge_changes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, path TEXT NOT NULL, operation TEXT NOT NULL, content TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(change_id,revision)
);

CREATE TABLE IF NOT EXISTS knowledge_conflicts (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, path TEXT NOT NULL, earlier_change_id TEXT,
  winning_change_id TEXT NOT NULL, reason TEXT NOT NULL, resolution TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_tombstones (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  path TEXT NOT NULL, deleted_version INTEGER NOT NULL, change_id TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_imports (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL, change_id TEXT, error TEXT, author TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_graph_nodes (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, node_key TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
  document_path TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(kb_id,version,node_key)
);
CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, source_key TEXT NOT NULL, target_key TEXT NOT NULL,
  relation TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, document_path TEXT NOT NULL, chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL, heading_path TEXT NOT NULL DEFAULT '', char_count INTEGER NOT NULL DEFAULT 0,
  tokens_json TEXT NOT NULL, vector_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_kb_version ON knowledge_chunks(kb_id, version);

CREATE TABLE IF NOT EXISTS semantic_index_jobs (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, backend TEXT NOT NULL, embedding_model TEXT NOT NULL,
  collection_name TEXT NOT NULL, status TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0,
  error TEXT, started_at TEXT NOT NULL, completed_at TEXT, UNIQUE(kb_id,version,backend,embedding_model)
);

-- Page-level dense vectors (RAG phase 1, Q4/Q5): one vector per wiki page per
-- version, stored locally (SQLite + cosine) so retrieval works fully offline.
-- Qdrant remains an optional backend (retrieval_mode=qdrant).
CREATE TABLE IF NOT EXISTS semantic_vectors (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, path TEXT NOT NULL, dims INTEGER NOT NULL,
  vector_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kb_id,version,path)
);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_kb_version ON semantic_vectors(kb_id, version);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  content TEXT NOT NULL, source_run_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
  instructions TEXT NOT NULL, version TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'local',
  value_score REAL NOT NULL DEFAULT 0.5, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  attached_at TEXT NOT NULL, PRIMARY KEY(agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT,
  question TEXT NOT NULL, answer TEXT NOT NULL, sources_json TEXT NOT NULL,
  memory_used INTEGER NOT NULL DEFAULT 0, skill_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version TEXT NOT NULL, instructions TEXT NOT NULL, author TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(skill_id,version)
);

CREATE TABLE IF NOT EXISTS skill_events (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  agent_id TEXT, event TEXT NOT NULL, score REAL, run_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_imports (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
  imported_version TEXT, status TEXT NOT NULL, error TEXT, author TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

-- LLM Wiki model (Phase 0): raw sources, ingest queue/cache, review/lint/research, wiki log.
CREATE TABLE IF NOT EXISTS wiki_sources (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  path TEXT NOT NULL, filename TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'text/markdown',
  content TEXT NOT NULL, content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT, created_at TEXT NOT NULL, ingested_at TEXT,
  UNIQUE(kb_id, content_hash)
);

CREATE TABLE IF NOT EXISTS ingest_queue (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES wiki_sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'document',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS ingest_cache (
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL, source_id TEXT NOT NULL,
  wiki_version INTEGER, status TEXT NOT NULL DEFAULT 'ingested',
  created_at TEXT NOT NULL, PRIMARY KEY(kb_id, source_hash)
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES wiki_sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
  suggested_action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  action TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS lint_reports (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, kind TEXT NOT NULL,
  path_a TEXT, path_b TEXT, detail TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS research_jobs (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  topic TEXT NOT NULL, queries_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  result_page TEXT, error TEXT,
  created_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS wiki_log (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version INTEGER, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_log_kb ON wiki_log(kb_id, created_at);
`;

export function openDatabase(config) {
  if (config.dbPath !== ":memory:") fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  // One-time LLM Wiki model upgrade: back up the pre-upgrade file, then apply
  // additive schema/backfill below. The marker check happens before SCHEMA so
  // existing databases are preserved verbatim until the upgrade is ready.
  const needsWikiUpgrade = !hasSystemMarker(db, "wiki_model_v1");
  if (needsWikiUpgrade && config.dbPath !== ":memory:") {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    backupDatabaseFile(config.dbPath);
  }
  db.exec(SCHEMA);
  migrateSchema(db);
  seed(db, config);
  if (needsWikiUpgrade) upgradeWikiModel(db);
  upgradeDegradedPages(db);
  return db;
}

function migrateSchema(db) {
  const columns = {
    api_keys: [
      ["team_id", "TEXT"], ["user_id", "TEXT"], ["scopes_json", "TEXT NOT NULL DEFAULT '[\"gateway:invoke\"]'"],
      ["allowed_models_json", "TEXT NOT NULL DEFAULT '[]'"], ["requests_per_minute", "INTEGER NOT NULL DEFAULT 60"],
      ["tokens_per_minute", "INTEGER NOT NULL DEFAULT 100000"], ["monthly_budget_cents", "INTEGER NOT NULL DEFAULT 0"],
      ["spent_cents", "INTEGER NOT NULL DEFAULT 0"], ["expires_at", "TEXT"],
    ],
    knowledge_changes: [
      ["revision", "INTEGER NOT NULL DEFAULT 1"], ["updated_at", "TEXT"], ["submitted_by", "TEXT"],
      ["batch_id", "TEXT"],
    ],
    lint_reports: [
      ["suggested_path", "TEXT"],
    ],
    memories: [
      ["kind", "TEXT NOT NULL DEFAULT 'episodic'"], ["scope", "TEXT NOT NULL DEFAULT 'session'"],
      ["importance", "REAL NOT NULL DEFAULT 0.5"], ["access_count", "INTEGER NOT NULL DEFAULT 0"],
      ["last_accessed_at", "TEXT"], ["expires_at", "TEXT"], ["superseded_by", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ],
    skills: [
      ["status", "TEXT NOT NULL DEFAULT 'active'"], ["usage_count", "INTEGER NOT NULL DEFAULT 0"],
      ["success_count", "INTEGER NOT NULL DEFAULT 0"], ["updated_at", "TEXT"], ["source", "TEXT NOT NULL DEFAULT 'manual'"],
    ],
    providers: [
      ["balance_endpoint", "TEXT NOT NULL DEFAULT ''"], ["balance_amount", "REAL"],
      ["balance_currency", "TEXT"], ["balance_status", "TEXT NOT NULL DEFAULT 'unconfigured'"],
      ["balance_checked_at", "TEXT"], ["balance_error", "TEXT"],
      ["balance_details_json", "TEXT NOT NULL DEFAULT '{}'"],
    ],
    knowledge_chunks: [
      ["heading_path", "TEXT NOT NULL DEFAULT ''"],
      ["char_count", "INTEGER NOT NULL DEFAULT 0"],
    ],
    knowledge_documents: [
      ["page_type", "TEXT NOT NULL DEFAULT 'wiki'"],
      ["title", "TEXT"],
      ["frontmatter_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["confidence", "TEXT NOT NULL DEFAULT 'INFERRED'"],
      ["sources_json", "TEXT NOT NULL DEFAULT '[]'"],
    ],
    knowledge_bases: [
      ["schema_md", "TEXT NOT NULL DEFAULT ''"],
      ["purpose_md", "TEXT NOT NULL DEFAULT ''"],
      ["ingest_mode", "TEXT NOT NULL DEFAULT 'review'"],
      ["compile_model", "TEXT NOT NULL DEFAULT ''"],
    ],
  };
  for (const [table, definitions] of Object.entries(columns)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of definitions) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function seed(db, config) {
  const createdAt = now();
  if (db.prepare("SELECT COUNT(*) AS count FROM providers").get().count === 0) {
    db.prepare(`INSERT INTO providers
      (id,name,kind,base_url,api_key,enabled,priority,weight,models_json,supports_vision,quality,input_cost,output_cost,latency_hint_ms,reliability,health_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "prv_local_demo", "Local Demo Model", "mock", "", "", 1, 10, 1,
      JSON.stringify(["atlas-mini", "atlas-vision"]), 1, 0.72, 0, 0, 120, 0.99, "healthy", createdAt, createdAt,
    );
  }
  if (config.devMode && !db.prepare("SELECT value FROM system_metadata WHERE key='dev_key_seeded'").get()) {
    if (db.prepare("SELECT COUNT(*) AS count FROM api_keys").get().count === 0) {
      db.prepare(`INSERT INTO api_keys
        (id,name,key_hash,key_prefix,quota_tokens,used_tokens,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
        "key_local_dev", "Local development", sha256(config.devKey), config.devKey.slice(0, 8),
        1_000_000, 0, 1, createdAt,
      );
    }
    db.prepare("INSERT INTO system_metadata (key,value,updated_at) VALUES ('dev_key_seeded','1',?)").run(createdAt);
  }
  const insertMapping = db.prepare(`INSERT OR IGNORE INTO model_mappings
    (id,alias,provider_id,upstream_model,priority,enabled,capabilities_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const provider of db.prepare("SELECT id,models_json,supports_vision FROM providers").all()) {
    for (const model of JSON.parse(provider.models_json || "[]")) {
      insertMapping.run(id("map"), model, provider.id, model, 10, 1,
        JSON.stringify(provider.supports_vision ? ["text", "vision"] : ["text"]), createdAt, createdAt);
    }
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM skills").get().count === 0) {
    const insert = db.prepare(`INSERT INTO skills
      (id,name,description,instructions,version,scope,value_score,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    insert.run("skl_grounded", "grounded-research", "Answer only from retrieved evidence and cite sources.",
      "Prefer direct evidence. State uncertainty. Cite every material claim.", "1.0.0", "builtin", 0.91, 1, createdAt);
    insert.run("skl_data", "data-analysis", "Validate data before producing analytical conclusions.",
      "Identify sources, validate shape and anomalies, then analyze and present reproducible results.", "1.0.0", "builtin", 0.84, 1, createdAt);
    db.prepare("INSERT INTO agent_skills (agent_id,skill_id,attached_at) VALUES (?,?,?)")
      .run("knowledge-agent", "skl_grounded", createdAt);
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get().count === 0) {
    const kbId = "kb_atlas_handbook";
    db.prepare(`INSERT INTO knowledge_bases
      (id,name,description,master_version,merge_batch_size,merge_interval_minutes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(kbId, "AtlasGate Handbook", "Built-in knowledge for the first agent run.", 1, 3, 60, createdAt, createdAt);
    db.prepare(`INSERT INTO knowledge_versions
      (id,kb_id,version,parent_version,summary,change_count,conflict_count,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run("ver_atlas_1", kbId, 1, null, "Initial handbook", 1, 0, createdAt);
    const content = `# AtlasGate\n\nAtlasGate is a governed LLM gateway and versioned knowledge agent platform.\n\n## Routing\nRequests use deterministic provider:model routes or the auto model. Auto routing scores quality, cost, latency and reliability, while capability checks ensure image requests reach a vision model.\n\n## Knowledge lifecycle\nAgents read the stable master version. Editors and maintenance agents submit isolated changes against a base version. A batch merge applies changes in creation order, records conflicts, and lets the latest accepted change win before publishing a new master.\n\n## Memory\nConversation memory is opt-in per request. The agent never reads or writes long-term memory unless the caller explicitly enables it.`;
    db.prepare(`INSERT INTO knowledge_documents
      (id,kb_id,version,path,content,content_hash,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run("doc_atlas_intro", kbId, 1, "handbook/overview.md", content, sha256(content), createdAt);
    const chunks = splitDocument(content);
    const insertChunk = db.prepare(`INSERT INTO knowledge_chunks
      (id,kb_id,version,document_path,chunk_index,content,heading_path,char_count,tokens_json,vector_json) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    chunks.forEach((chunk) => insertChunk.run(id("chk"), kbId, 1, "handbook/overview.md", chunk.chunk_index, chunk.content,
      chunk.heading_path, chunk.char_count, JSON.stringify(tokenize(chunk.content)), JSON.stringify(featureVector(chunk.content))));
    // The built-in handbook behaves like a fresh wiki knowledge base: it owns
    // the five system pages as version-1 documents, so the legacy seeding pass
    // (ensureSystemPagesForAll) finds nothing to stage for it.
    const insertSystem = db.prepare(`INSERT INTO knowledge_documents
      (id,kb_id,version,path,content,content_hash,updated_at,page_type,title,frontmatter_json,confidence,sources_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const page of systemPageTemplates()) {
      insertSystem.run(id("doc"), kbId, 1, page.path, page.content, sha256(page.content), createdAt,
        page.pageType, page.title, JSON.stringify({ type: page.pageType, title: page.title, confidence: "INFERRED", tags: [] }),
        "INFERRED", "[]");
    }
  }
  repairKnowledgeChunks(db);
}

function repairLegacySeedChunks(db) {
  const rows = db.prepare("SELECT id,content FROM knowledge_chunks WHERE tokens_json='[]' OR char_count=0").all();
  const update = db.prepare("UPDATE knowledge_chunks SET tokens_json=?,char_count=? WHERE id=?");
  rows.forEach((row) => update.run(JSON.stringify(tokenize(row.content)), String(row.content).length, row.id));
}

function repairKnowledgeChunks(db) {
  repairLegacySeedChunks(db);
  const marker = db.prepare("SELECT value FROM system_metadata WHERE key='knowledge_chunk_schema_v2'").get();
  if (marker) return;
  const documents = db.prepare("SELECT kb_id,version,path,content FROM knowledge_documents ORDER BY kb_id,version,path").all();
  const deleteChunks = db.prepare("DELETE FROM knowledge_chunks WHERE kb_id=? AND version=?");
  const insertChunk = db.prepare(`INSERT INTO knowledge_chunks
    (id,kb_id,version,document_path,chunk_index,content,heading_path,char_count,tokens_json,vector_json) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const versions = new Set();
  for (const document of documents) {
    const key = `${document.kb_id}:${document.version}`;
    if (!versions.has(key)) {
      deleteChunks.run(document.kb_id, document.version);
      versions.add(key);
    }
    for (const chunk of splitDocument(document.content)) {
      insertChunk.run(id("chk"), document.kb_id, document.version, document.path, chunk.chunk_index, chunk.content,
        chunk.heading_path, chunk.char_count, JSON.stringify(tokenize(chunk.content)), JSON.stringify(featureVector(chunk.content)));
    }
  }
  if (documents.length) db.prepare("UPDATE semantic_index_jobs SET status='stale',error='Chunk schema upgraded; reindex required' WHERE status='ready'").run();
  db.prepare("INSERT INTO system_metadata (key,value,updated_at) VALUES ('knowledge_chunk_schema_v2','1',?)").run(now());
}

function hasSystemMarker(db, key) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_metadata'").get();
  if (!table) return false;
  return Boolean(db.prepare("SELECT value FROM system_metadata WHERE key=?").get(key));
}

function backupDatabaseFile(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return;
    if (fs.statSync(dbPath).size === 0) return;
    const backupDir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(dbPath, path.join(backupDir, `atlasgate-${stamp}.db`));
  } catch (error) {
    console.error("Wiki model upgrade backup failed", error);
  }
}

// One-time additive migration for the LLM Wiki data model: infer page_type/title
// and copy existing frontmatter into knowledge_documents metadata columns.
// Idempotent: guarded by the wiki_model_v1 marker set in openDatabase().
function upgradeWikiModel(db) {
  const documents = db.prepare("SELECT id,path,content,page_type FROM knowledge_documents").all();
  const update = db.prepare("UPDATE knowledge_documents SET page_type=?,title=?,frontmatter_json=? WHERE id=?");
  for (const document of documents) {
    const parsed = parseFrontmatter(document.content);
    const type = pageTypeFromPath(document.path) ?? document.page_type ?? "wiki";
    const title = typeof parsed.metadata.title === "string" && parsed.metadata.title.trim()
      ? parsed.metadata.title.trim()
      : firstHeading(document.content);
    update.run(type, title, JSON.stringify(parsed.metadata), document.id);
  }
  db.prepare("INSERT INTO system_metadata (key,value,updated_at) VALUES ('wiki_model_v1','1',?)").run(now());
}

// Mark legacy degraded raw pages (sources/* authored by the compiler before the
// atlasgate-degraded marker existed) so default query excludes raw archives.
function upgradeDegradedPages(db) {
  const marker = db.prepare("SELECT value FROM system_metadata WHERE key='wiki_degraded_migration_v1'").get();
  if (marker) return;
  const rows = db.prepare("SELECT id,path,content FROM knowledge_documents WHERE path LIKE 'sources/%' AND frontmatter_json='{}'").all();
  const update = db.prepare("UPDATE knowledge_documents SET frontmatter_json=? WHERE id=?");
  let marked = 0;
  for (const row of rows) {
    if (/^---\r?\n[\s\S]*?\r?\n---/.test(String(row.content ?? ""))) continue; // compiled source summary keeps its frontmatter
    update.run(JSON.stringify({ type: "source", title: row.path.split("/").pop().replace(/\.md$/i, ""), confidence: "EXTRACTED", "atlasgate-degraded": true }), row.id);
    marked += 1;
  }
  db.prepare("INSERT INTO system_metadata (key,value,updated_at) VALUES ('wiki_degraded_migration_v1','1',?)").run(now());
  if (marked > 0) console.log(`Wiki model: marked ${marked} legacy degraded page(s) as raw archives`);
}

function firstHeading(content) {
  const match = /^#\s+(.+)$/m.exec(String(content ?? ""));
  return match ? match[1].trim() : null;
}
