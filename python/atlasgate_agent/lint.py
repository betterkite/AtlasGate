"""LLM-level wiki health check prompt preparation (Python side).

Structural checks (orphan pages, broken links, index consistency) are pure SQL
in src/services/lint.js and run after every publish. This module prepares the
manual LLM-level lint: contradictions, stale claims, missing pages, data gaps.
The Node side calls the gateway LLM and owns validation/staging of reports.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from .engine import AgentCoreError

MAX_PAGES = 40
MAX_PAGE_CHARS = 900

LINT_INSTRUCTIONS = """You are the LINT stage of an LLM wiki health check. Read the wiki catalog and pages, then return STRICT JSON only (no prose, no markdown fences) with exactly this shape:

{
  "issues": [
    {"kind": "contradiction|stale_claim|orphan_page|missing_page|missing_link|data_gap",
     "path_a": "...", "path_b": "...", "detail": "...", "severity": "info|warn|error",
     "suggested_path": "entities/foo.md"}
  ]
}

Rules:
- contradiction: two pages state conflicting facts (path_a, path_b).
- stale_claim: a claim superseded by newer material.
- missing_page: index.md or a page references a topic with no page (suggested_path).
- data_gap: a gap that a web search could fill.
- Only report issues you can ground in the provided pages; do not invent content.
- At most 15 issues."""  # noqa: E501


def prepare_lint(db_path: str, request: dict[str, Any]) -> dict[str, Any]:
    kb_id = str(request.get("kb_id") or "")
    if not kb_id:
        raise AgentCoreError("invalid_lint_request", "kb_id is required")

    connection = sqlite3.connect(db_path, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        kb = connection.execute(
            "SELECT id,master_version,purpose_md FROM knowledge_bases WHERE id=?", (kb_id,)
        ).fetchone()
        if kb is None:
            raise AgentCoreError("kb_not_found", "Knowledge base not found")

        version = int(kb["master_version"])
        pages = connection.execute(
            "SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path", (kb_id, version)
        ).fetchall()
        purpose = (kb["purpose_md"] or "").strip()
        catalog = []
        for page in pages:
            path = str(page["path"])
            catalog.append(f"## {path}\n{str(page['content'])[:MAX_PAGE_CHARS]}")
        catalog_text = "\n\n".join(catalog[:MAX_PAGES])
        if len(catalog) > MAX_PAGES:
            catalog_text += f"\n\n…({len(catalog) - MAX_PAGES} more pages omitted)"

        user = "\n\n".join(
            [
                "WIKI PURPOSE:\n" + purpose[:1_200],
                "WIKI CATALOG:\n" + (catalog_text or "(empty wiki)"),
            ]
        )
        return {
            "context": {"kb_id": kb_id, "version": version, "pages": len(pages)},
            "messages": [
                {"role": "system", "content": LINT_INSTRUCTIONS + "\n\nSTAGE: lint"},
                {"role": "user", "content": user},
            ],
        }
    finally:
        connection.close()
