import { createZip } from "../core/zip.js";
import { now } from "../core/utils.js";

/**
 * Read-only wiki snapshot export (Q8): Master pages as an Obsidian-compatible
 * Markdown vault, shipped as a store-method ZIP. No bidirectional sync yet.
 */
export class WikiExportService {
  constructor(db, knowledge) {
    this.db = db;
    this.knowledge = knowledge;
  }

  buildExportFiles(kbId, version = null) {
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const selected = version ?? kb.master_version;
    this.knowledge.requireVersion(kbId, selected);
    const documents = this.db.prepare("SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path").all(kbId, selected);
    const files = [
      {
        path: ".obsidian/app.json",
        content: JSON.stringify({ showLineNumber: true, attachmentFolderPath: "raw/assets" }, null, 2),
      },
      {
        path: ".obsidian/appearance.json",
        content: JSON.stringify({ baseFontSize: 15 }, null, 2),
      },
      {
        path: "README.md",
        content: `# ${kb.name}\n\nAtlasGate Wiki 导出快照 · master v${selected} · ${new Date().toISOString()}\n\n在 Obsidian 中打开本目录即可浏览 wikilink 与图谱。\n`,
      },
    ];
    for (const document of documents) files.push({ path: document.path, content: document.content });
    return files;
  }

  exportZip(kbId, version = null) {
    const kb = this.knowledge.getKnowledgeBase(kbId);
    const selected = version ?? kb.master_version;
    const files = this.buildExportFiles(kbId, selected);
    const buffer = createZip(files);
    const safeName = String(kb.name).replace(/[^\w\u3400-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "wiki";
    return { buffer, filename: `${safeName}-v${selected}.zip`, files: files.length };
  }
}
