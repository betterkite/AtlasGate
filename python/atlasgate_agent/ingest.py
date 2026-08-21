"""LLM Wiki compiler prompt preparation (Python side).

The Python worker stays offline: it reads the wiki context from SQLite and
builds the grounded system/user messages for the two compile steps. The Node
side calls the gateway LLM with these messages and owns validation/staging.

Contract with src/services/wiki-compiler.js:
- prepare_ingest_analysis(db_path, request) -> {context, messages}
- prepare_ingest_generation(db_path, request) -> {messages, page_plan}
- request keys: kb_id, source_id, analysis (generation), max_pages (generation)

Both system prompts carry a distinctive STAGE marker so test upstreams can
script step-specific replies.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from typing import Any

from .engine import AgentCoreError, tokenize

SYSTEM_PAGE_PATHS = frozenset(("index.md", "log.md", "purpose.md", "schema.md", "overview.md"))
CONFIDENCE_LEVELS = ("EXTRACTED", "INFERRED", "AMBIGUOUS", "UNVERIFIED")
TAXONOMY_DIRS = ("entities/", "concepts/", "sources/", "comparisons/", "synthesis/", "queries/")
MAX_SOURCE_CHARS = 20_000
MAX_RELATED_PAGES = 5
MAX_RELATED_CHARS = 1_400
MAX_EXISTING_PAGE_CHARS = 2_000

ANALYSIS_INSTRUCTIONS = """You are the ANALYSIS stage of an LLM wiki compiler. A new source is being ingested into an existing wiki. Read the source and the wiki context, then return STRICT JSON only (no prose, no markdown fences) with exactly this shape:

{
  "key_entities": [{"name": "...", "type": "person|organization|product|tool|concept", "summary": "...", "confidence": "EXTRACTED|INFERRED|AMBIGUOUS|UNVERIFIED"}],
  "key_concepts": [{"name": "...", "summary": "...", "confidence": "..."}],
  "arguments": ["..."],
  "connections": [{"target": "entities/foo.md", "relation": "related", "note": "..."}],
  "contradictions": [{"existing_page": "concepts/foo.md", "claim": "...", "new_evidence": "..."}],
  "page_plan": [{"action": "create|update", "path": "sources/<slug>.md", "type": "source", "title": "...", "rationale": "..."}],
  "review_items": [{"kind": "create_page|deep_research|verify|skip", "payload": {}, "suggested_action": "..."}],
  "research_queries": ["..."],
  "privacy_flags": []
}

Rules:
- confidence must be one of EXTRACTED/INFERRED/AMBIGUOUS/UNVERIFIED; facts stated in the source are EXTRACTED, your synthesis is INFERRED.
- Every source MUST get a "sources/<slug>.md" summary page in page_plan (action create).
- Use action=update for paths that already exist in the wiki (listed in context).
- Only propose paths under the wiki taxonomy: sources/, entities/, concepts/, comparisons/, synthesis/, queries/.
- If the source contains phone numbers, emails, API keys or private keys, list them in privacy_flags and do NOT include them in entity/concept summaries.
- Keep research_queries to at most 3."""

GENERATION_INSTRUCTIONS = """You are the GENERATION stage of an LLM wiki compiler. Given the analysis JSON and wiki conventions, write the actual wiki pages. Return STRICT JSON only (no prose, no markdown fences) with exactly this shape:

{
  "pages": [{"path": "sources/foo.md", "content": "<full markdown>", "confidence": "EXTRACTED|INFERRED|AMBIGUOUS|UNVERIFIED"}]
}

Rules:
- "content" is the COMPLETE markdown page. It MUST begin with YAML frontmatter:
  ---
  type: source|entity|concept|comparison|synthesis|query
  title: "..."
  sources: ["raw/<source-path>"]
  confidence: EXTRACTED|INFERRED|AMBIGUOUS|UNVERIFIED
  tags: [a, b]
  ---
- sources[] must reference the raw source path given in context (or existing sources[] when updating a page).
- The three system pages index.md / log.md / overview.md are navigation pages: use sources: [] for them.
- Use [[wikilinks]] to related existing pages listed in context.
- Follow the wiki conventions (schema.md) below.
- Create at most the page budget given in the user message; prefer updating existing pages over creating near-duplicates.
- ALWAYS include the three compiler-maintained system pages in "pages":
    index.md — append every new/updated page with a one-line summary link;
    log.md — append "## [YYYY-MM-DD] ingest | <title>" for this ingest;
    overview.md — refresh the global summary to reflect the new content.
- Never include secrets, phone numbers or emails in page content."""


def prepare_ingest_analysis(db_path: str, request: dict[str, Any]) -> dict[str, Any]:
    kb_id = str(request.get("kb_id") or "")
    source_id = str(request.get("source_id") or "")
    if not kb_id or not source_id:
        raise AgentCoreError("invalid_ingest_request", "kb_id and source_id are required")

    connection = sqlite3.connect(db_path, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        kb = connection.execute(
            "SELECT id,master_version,purpose_md,schema_md FROM knowledge_bases WHERE id=?", (kb_id,)
        ).fetchone()
        if kb is None:
            raise AgentCoreError("kb_not_found", "Knowledge base not found")
        source = connection.execute(
            "SELECT * FROM wiki_sources WHERE id=? AND kb_id=?", (source_id, kb_id)
        ).fetchone()
        if source is None:
            raise AgentCoreError("source_not_found", "Source not found")

        version = int(kb["master_version"])
        purpose_md = (kb["purpose_md"] or "").strip() or _page(connection, kb_id, version, "purpose.md")
        schema_md = (kb["schema_md"] or "").strip() or _page(connection, kb_id, version, "schema.md")
        index_md = _page(connection, kb_id, version, "index.md")
        related = _related_pages(connection, kb_id, version, source["content"], MAX_RELATED_PAGES)

        source_text = str(source["content"])[:MAX_SOURCE_CHARS]
        related_text = "\n\n".join(
            f"## {page['path']}\n{page['content'][:MAX_RELATED_CHARS]}" for page in related
        )
        user = "\n\n".join(
            [
                "WIKI PURPOSE:\n" + purpose_md[:1_500],
                "WIKI CONVENTIONS (schema.md):\n" + schema_md[:2_000],
                "INDEX (catalog):\n" + index_md[:1_500],
                "RELATED EXISTING PAGES:\n" + (related_text or "(none)"),
                f"NEW SOURCE (raw/{source['path']}):\n{source_text}",
            ]
        )
        context = {
            "kb_id": kb_id,
            "version": version,
            "source_id": source_id,
            "source_path": str(source["path"]),
            "related_pages": [page["path"] for page in related],
        }
        return {
            "context": context,
            "messages": [
                {"role": "system", "content": ANALYSIS_INSTRUCTIONS + "\n\nSTAGE: analysis"},
                {"role": "user", "content": user},
            ],
        }
    finally:
        connection.close()


def prepare_ingest_generation(db_path: str, request: dict[str, Any]) -> dict[str, Any]:
    kb_id = str(request.get("kb_id") or "")
    source_id = str(request.get("source_id") or "")
    analysis = request.get("analysis")
    if not kb_id or not source_id or not isinstance(analysis, dict):
        raise AgentCoreError("invalid_ingest_request", "kb_id, source_id and analysis are required")
    budget = max(1, min(50, int(request.get("max_pages") or 20)))

    connection = sqlite3.connect(db_path, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        kb = connection.execute(
            "SELECT id,master_version,schema_md FROM knowledge_bases WHERE id=?", (kb_id,)
        ).fetchone()
        if kb is None:
            raise AgentCoreError("kb_not_found", "Knowledge base not found")
        source = connection.execute(
            "SELECT path FROM wiki_sources WHERE id=? AND kb_id=?", (source_id, kb_id)
        ).fetchone()
        if source is None:
            raise AgentCoreError("source_not_found", "Source not found")

        version = int(kb["master_version"])
        schema_md = (kb["schema_md"] or "").strip() or _page(connection, kb_id, version, "schema.md")
        existing = _existing_pages_for_plan(connection, kb_id, version, analysis, MAX_EXISTING_PAGE_CHARS)

        plan_text = json.dumps(analysis, ensure_ascii=False)
        existing_text = "\n\n".join(f"## {path}\n{content}" for path, content in existing.items()) or "(no updates needed)"
        user = "\n\n".join(
            [
                "WIKI CONVENTIONS (schema.md):\n" + schema_md[:2_000],
                f"RAW SOURCE PATH: raw/{source['path']}",
                "ANALYSIS JSON:\n" + plan_text,
                "EXISTING PAGES TO UPDATE (current content):\n" + existing_text,
                f"PAGE BUDGET: {budget}",
            ]
        )
        return {
            "messages": [
                {"role": "system", "content": GENERATION_INSTRUCTIONS + "\n\nSTAGE: generation"},
                {"role": "user", "content": user},
            ],
            "page_plan": analysis.get("page_plan", []),
        }
    finally:
        connection.close()


def _page(connection: sqlite3.Connection, kb_id: str, version: int, path: str) -> str:
    row = connection.execute(
        "SELECT content FROM knowledge_documents WHERE kb_id=? AND version=? AND path=?", (kb_id, version, path)
    ).fetchone()
    return str(row["content"]) if row else ""


def _related_pages(
    connection: sqlite3.Connection, kb_id: str, version: int, source_content: str, limit: int
) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT path,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path", (kb_id, version)
    ).fetchall()
    source_tokens = set(tokenize(str(source_content)))
    scored = []
    for row in rows:
        path = str(row["path"])
        if path in SYSTEM_PAGE_PATHS:
            continue
        tokens = set(tokenize(str(row["content"])))
        overlap = len(source_tokens & tokens)
        if overlap > 0:
            scored.append({"path": path, "content": str(row["content"]), "score": overlap})
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]


def _existing_pages_for_plan(
    connection: sqlite3.Connection, kb_id: str, version: int, analysis: dict[str, Any], cap: int
) -> dict[str, str]:
    paths = set()
    for item in analysis.get("page_plan") or []:
        path = str(item.get("path") or "")
        if item.get("action") == "update" and path:
            paths.add(path)
    result = {}
    for path in paths:
        content = _page(connection, kb_id, version, path)
        if content:
            result[path] = content[:cap]
    return result


def _slug(value: str) -> str:
    text = str(value or "").lower()
    return re.sub(r"[^a-z0-9\u3400-\u9fff]+", "-", text).strip("-") or "page"
