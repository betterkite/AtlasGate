from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).with_name("vendor")))


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    request = json.load(sys.stdin)
    try:
        from pypdf import PdfReader
    except ImportError:
        json.dump({"ok": False, "error": {"code": "pdf_dependency_missing", "message": "PDF import requires: pip install -r python/requirements.txt"}}, sys.stdout, ensure_ascii=False)
        return 0
    try:
        data = base64.b64decode(request.get("data_base64") or "", validate=True)
        reader = PdfReader(io.BytesIO(data))
        pages = []
        for index, page in enumerate(reader.pages):
            text = (page.extract_text() or "").strip()
            if text:
                pages.append(f"## Page {index + 1}\n\n{text}")
        content = "\n\n".join(pages).strip()
        if not content:
            raise ValueError("PDF contains no extractable text; scanned PDFs require OCR")
        json.dump({"ok": True, "content": content, "pages": len(reader.pages)}, sys.stdout, ensure_ascii=False)
        return 0
    except Exception as error:
        json.dump({"ok": False, "error": {"code": "pdf_parse_failed", "message": str(error)}}, sys.stdout, ensure_ascii=False)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
