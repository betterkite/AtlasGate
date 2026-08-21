import fs from "node:fs";
import path from "node:path";
import { now } from "../core/utils.js";

/**
 * One-way wiki mirror to disk (grilling Q6/Q7/Q8). Every published Master is
 * mirrored as Markdown under `<root>/knowledge/<kb-slug>/` so the wiki is
 * visible in a plain directory (openable in Obsidian / git). The SQLite
 * database stays the single source of truth; this directory is a generated
 * mirror. A per-knowledge-base manifest tracks previously synced relative
 * paths so deleted pages are removed from disk on the next sync.
 */
export class WikiSyncService {
  constructor(db, config, knowledge) {
    this.db = db;
    this.config = config;
    this.knowledge = knowledge;
    this.manifestName = ".atlasgate-manifest.json";
  }

  enabled() {
    return Boolean(this.config.wiki.syncDir);
  }

  vaultRoot() {
    return path.resolve(this.config.root, this.config.wiki.syncDir);
  }

  kbDir(kbId) {
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const slug = String(kb.name).toLowerCase()
      .replace(/[^\w\u3400-\u9fff-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || kb.id;
    return path.join(this.vaultRoot(), slug);
  }

  ensureVault() {
    if (!this.enabled()) return null;
    const root = this.vaultRoot();
    fs.mkdirSync(root, { recursive: true });
    const obsidian = path.join(root, ".obsidian");
    fs.mkdirSync(obsidian, { recursive: true });
    const appJson = path.join(obsidian, "app.json");
    if (!fs.existsSync(appJson)) {
      fs.writeFileSync(appJson, JSON.stringify({ showLineNumber: true, attachmentFolderPath: "assets" }, null, 2));
    }
    const vaultReadme = path.join(root, "README.md");
    if (!fs.existsSync(vaultReadme)) {
      fs.writeFileSync(vaultReadme, [
        "# AtlasGate Wiki Vault",
        "",
        "每个子目录对应一个 AtlasGate 知识库，内容由服务自动从数据库镜像。",
        "请勿直接编辑本目录：修改请走控制台（Wiki 知识库视图），改动会作为 Change 进入版本治理。",
        "",
      ].join("\n"));
    }
    return root;
  }

  /**
   * Mirror one knowledge base's master (or an explicit version) to disk.
   * @returns {{synced: boolean, reason?: string, root?: string, kb_dir?: string, version?: number, files?: number, removed?: number}}
   */
  syncKnowledgeBase(kbId, version = null) {
    if (!this.enabled()) return { synced: false, reason: "sync_disabled" };
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const selected = version ?? kb.master_version;
    this.knowledge.requireVersion(kbId, selected);
    const documents = this.db.prepare("SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path").all(kbId, selected);
    const dir = this.kbDir(kbId);
    this.ensureVault();
    fs.mkdirSync(dir, { recursive: true });

    const manifestPath = path.join(dir, this.manifestName);
    let previous = [];
    try { previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { previous = []; }
    const previousSet = new Set(Array.isArray(previous) ? previous : []);
    const current = new Set();

    let files = 0;
    let skipped = 0;
    for (const document of documents) {
      const relative = String(document.path ?? "").replaceAll("\\", "/");
      if (!isSafeRelativePath(relative)) { skipped += 1; continue; }
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, document.content);
      current.add(relative);
      files += 1;
    }
    // Remove files that are no longer part of this version.
    let removed = 0;
    for (const relative of previous) {
      if (current.has(relative)) continue;
      if (!isSafeRelativePath(relative)) continue;
      const stale = path.join(dir, relative);
      try { fs.rmSync(stale, { force: true }); removed += 1; } catch { /* best effort */ }
    }
    if (!current.has(this.manifestName)) {
      fs.writeFileSync(manifestPath, JSON.stringify([...current].sort(), null, 2));
    }
    return {
      synced: true,
      root: this.vaultRoot(),
      kb_dir: dir,
      version: selected,
      files,
      removed,
      skipped,
      synced_at: now(),
    };
  }

  syncAll() {
    if (!this.enabled()) return { synced: 0, reason: "sync_disabled" };
    const knowledgeBases = this.db.prepare("SELECT id FROM knowledge_bases").all();
    let files = 0;
    for (const kb of knowledgeBases) files += this.syncKnowledgeBase(kb.id).files ?? 0;
    return { synced: knowledgeBases.length, files };
  }
}

function isSafeRelativePath(relative) {
  if (!relative || relative.startsWith("/") || relative.startsWith(".") || relative.includes("..")) return false;
  if (/^[a-zA-Z]:/.test(relative)) return false;
  return true;
}
