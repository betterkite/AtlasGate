import path from "node:path";
import { spawn } from "node:child_process";
import { HttpError } from "../core/http.js";

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

export class DocumentParser {
  constructor(config) {
    this.config = config;
    this.worker = path.join(config.root, "python", "document_worker.py");
  }

  async parse(input) {
    const filename = String(input.filename ?? "").trim();
    const extension = path.extname(filename).toLowerCase();
    const mediaType = input.media_type ?? (extension === ".pdf" ? "application/pdf" : extension === ".md" ? "text/markdown" : "text/plain");
    if (!filename || ![".md", ".txt", ".pdf"].includes(extension)) throw new HttpError(400, "Only .md, .txt and .pdf files are supported", "unsupported_document");
    if (input.text !== undefined && extension !== ".pdf") return { content: String(input.text), media_type: mediaType, size_bytes: Buffer.byteLength(String(input.text)) };
    if (!input.data_base64) throw new HttpError(400, "data_base64 or text is required", "invalid_import");
    let bytes;
    try { bytes = Buffer.from(input.data_base64, "base64"); } catch { throw new HttpError(400, "data_base64 is invalid", "invalid_import"); }
    if (bytes.length > 20 * 1024 * 1024) throw new HttpError(413, "Document exceeds the 20 MB import limit", "document_too_large");
    if (TEXT_TYPES.has(mediaType) || extension === ".md" || extension === ".txt") {
      try {
        return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), media_type: mediaType, size_bytes: bytes.length };
      } catch { throw new HttpError(400, "Text documents must be valid UTF-8", "invalid_text_encoding"); }
    }
    const parsed = await this.parsePdf(input.data_base64);
    return { content: parsed.content, media_type: "application/pdf", size_bytes: bytes.length, pages: parsed.pages };
  }

  parsePdf(dataBase64) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.pythonCommand, [this.worker], {
        cwd: this.config.root,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill(), this.config.pythonAgentTimeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timeout); reject(new HttpError(503, `PDF parser failed to start: ${error.message}`, "pdf_parser_unavailable")); });
      child.on("close", () => {
        clearTimeout(timeout);
        let payload;
        try { payload = JSON.parse(stdout); } catch { reject(new HttpError(502, `PDF parser returned invalid output${stderr ? `: ${stderr.trim()}` : ""}`, "pdf_parser_invalid_output")); return; }
        if (!payload.ok) { reject(new HttpError(payload.error?.code === "pdf_dependency_missing" ? 503 : 400, payload.error?.message ?? "PDF parsing failed", payload.error?.code ?? "pdf_parse_failed")); return; }
        resolve(payload);
      });
      child.stdin.end(JSON.stringify({ data_base64: dataBase64 }));
    });
  }
}
