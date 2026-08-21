from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from collections import Counter
from typing import Any

from .frontmatter import parse_frontmatter

# Top-level wiki system pages are excluded from retrieval by default (Q11):
# the LLM navigates them directly through index.md, and their frontmatter
# should not surface as question evidence.
SYSTEM_PAGE_PATHS = frozenset(("index.md", "log.md", "purpose.md", "schema.md", "overview.md"))


class AgentCoreError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def tokenize(text: str) -> list[str]:
    normalized = str(text or "").lower()
    words = re.findall(r"[a-z0-9_]{2,}", normalized)
    cjk: list[str] = []
    for run in re.findall(r"[\u3400-\u9fff]+", normalized):
        if len(run) == 1:
            cjk.append(run)
        cjk.extend(run[index : index + 2] for index in range(len(run) - 1))
    return [*words, *cjk]


def feature_vector(text: str, dimensions: int = 96) -> list[float]:
    vector = [0.0] * dimensions
    for token in tokenize(text):
        digest = hashlib.sha1(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:2], "big") % dimensions
        vector[index] += 1 if digest[2] % 2 == 0 else -1
    norm = math.sqrt(sum(value * value for value in vector))
    return vector if norm == 0 else [value / norm for value in vector]


def cosine(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    return sum(value * right[index] for index, value in enumerate(left))


def prepare_knowledge_run(db_path: str, request: dict[str, Any]) -> dict[str, Any]:
    kb_id = str(request.get("kb_id") or "")
    question = str(request.get("question") or "").strip()
    if not kb_id or not question:
        raise AgentCoreError("invalid_agent_request", "kb_id and question are required")

    connection = sqlite3.connect(db_path, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        kb = connection.execute(
            "SELECT id,master_version FROM knowledge_bases WHERE id=?", (kb_id,)
        ).fetchone()
        if kb is None:
            raise AgentCoreError("kb_not_found", "Knowledge base not found")

        precomputed_sources = request.get("precomputed_sources")
        retrieval_mode = str(request.get("retrieval_mode") or "page")
        if retrieval_mode == "chunk":
            sources = _search(
                connection,
                kb_id,
                int(kb["master_version"]),
                question,
                int(request.get("top_k") or 5),
                float(request.get("keyword_weight") or 0.45),
                float(request.get("vector_weight") or 0.55),
                float(request.get("min_score") or 0.05),
                request.get("include_system") is True,
            )
        else:
            # Index-driven page retrieval (D7): select full wiki pages by
            # vocabulary overlap with the question, reading pages whole instead
            # of chunk-level RAG. Raw/degraded pages are archives awaiting
            # compilation and are excluded by default (include_raw to surface).
            lexical = _retrieve_pages(
                connection,
                kb_id,
                int(kb["master_version"]),
                question,
                top_k=int(request.get("top_k") or 5),
                page_cap=int(request.get("page_cap") or 4000),
                include_system=request.get("include_system") is True,
                include_raw=request.get("include_raw") is True,
            )
            if precomputed_sources is not None:
                # RAG phase 1 (Q3): dense hits arrive from Node as
                # precomputed_sources (whole pages); fuse with lexical hits by
                # Reciprocal Rank Fusion so semantic matches (paraphrase) and
                # lexical matches (proper nouns) reinforce each other.
                vector = _validate_precomputed_sources(precomputed_sources, int(kb["master_version"]))
                fused = _rrf_fuse(lexical, vector, top_k=int(request.get("top_k") or 5))
            else:
                # No embedding service configured: pure lexical (degraded).
                fused = [dict(hit, rrf_score=0.0) for hit in lexical]
            # RAG phase 2 (Q8C): structural pseudo-rerank breaks RRF ties with
            # graph centrality (related-edge degree).
            sources = _rerank_by_graph_degree(
                fused,
                top_k=int(request.get("top_k") or 5),
                degree=_graph_degrees(connection, kb_id, int(kb["master_version"])),
            )
            # RAG phase 3 (Q10A): follow [[wikilinks]] from the retrieved pages
            # and append linked pages as expansion evidence — zero extra LLM
            # calls, the wiki link graph is the multi-hop jump board.
            if request.get("multihop") is not False:
                sources = _expand_linked_pages(
                    connection,
                    kb_id,
                    int(kb["master_version"]),
                    sources,
                    page_cap=int(request.get("page_cap") or 4000),
                    include_system=request.get("include_system") is True,
                    include_raw=request.get("include_raw") is True,
                    max_expand=int(request.get("multihop_expand") or 3),
                )
        memory_enabled = request.get("use_memory") is True
        memories = (
            _relevant_memories(connection, str(request.get("session_id") or ""), question)
            if memory_enabled
            else []
        )
        skills = [
            dict(row)
            for row in connection.execute(
                """SELECT s.id,s.name,s.version,s.instructions
                FROM skills s JOIN agent_skills a ON a.skill_id=s.id
                WHERE a.agent_id='knowledge-agent' AND s.enabled=1
                ORDER BY s.value_score DESC"""
            ).fetchall()
        ]
    finally:
        connection.close()

    context = "\n\n".join(
        f"[{index + 1}] {source['path']}\n{source['content']}"
        for index, source in enumerate(sources)
    )
    memory_context = "\n".join(memory["content"] for memory in memories)
    system_parts = [
        "You are AtlasGate Knowledge Agent. Answer only from EVIDENCE, cite claims as [1], [2], and state uncertainty. "
        "If the EVIDENCE does not support the question, say so explicitly instead of guessing (RAG phase 3, Q11).",
        *(skill["instructions"] for skill in skills),
    ]
    if memory_context:
        system_parts.append(f"OPT-IN MEMORY:\n{memory_context}")
    if context:
        system_parts.append(f"EVIDENCE:\n{context}")

    return {
        "sources": [_source_view(source) for source in sources],
        "skills": [
            {"id": skill["id"], "name": skill["name"], "version": skill["version"]}
            for skill in skills
        ],
        "memory": {"enabled": memory_enabled, "recalled": len(memories)},
        "messages": [
            {"role": "system", "content": "\n\n".join(system_parts)},
            {"role": "user", "content": question},
        ],
        "fallback_answer": _extractive_answer(question, sources),
    }


def _search(
    connection: sqlite3.Connection,
    kb_id: str,
    version: int,
    query: str,
    top_k: int,
    keyword_weight: float,
    vector_weight: float,
    min_score: float,
    include_system: bool = False,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT * FROM knowledge_chunks WHERE kb_id=? AND version=?", (kb_id, version)
    ).fetchall()
    if not rows:
        return []
    if not include_system:
        rows = [row for row in rows if row["document_path"] not in SYSTEM_PAGE_PATHS]
    chunks = [dict(row) for row in rows]
    if not chunks:
        return []
    query_tokens = tokenize(query)
    query_vector = feature_vector(query)
    document_frequency: Counter[str] = Counter()
    for chunk in chunks:
        document_frequency.update(set(json.loads(chunk["tokens_json"])))

    scored: list[dict[str, Any]] = []
    for chunk in chunks:
        frequencies = Counter(json.loads(chunk["tokens_json"]))
        bm25 = 0.0
        for token in query_tokens:
            term_frequency = frequencies[token]
            frequency = document_frequency[token]
            if term_frequency:
                bm25 += math.log(1 + (len(chunks) - frequency + 0.5) / (frequency + 0.5)) * (
                    (term_frequency * 2.2) / (term_frequency + 1.2)
                )
        keyword_score = 1 - math.exp(-bm25 / 4)
        vector_score = max(0.0, cosine(query_vector, json.loads(chunk["vector_json"])))
        # The local feature vector is a deterministic offline fallback, not a
        # semantic embedding. Reject low-similarity hash collisions without a
        # lexical match so unrelated questions do not become evidence.
        score = 0.0 if keyword_score == 0 and vector_score < 0.2 else keyword_weight * keyword_score + vector_weight * vector_score
        scored.append(
            {
                "chunk_id": chunk["id"],
                "path": chunk["document_path"],
                "chunk_index": int(chunk["chunk_index"]) if "chunk_index" in chunk.keys() else 0,
                "heading_path": chunk["heading_path"] if "heading_path" in chunk.keys() else "",
                "char_count": int(chunk["char_count"]) if "char_count" in chunk.keys() else len(chunk["content"]),
                "content": chunk["content"],
                "score": round(score, 5),
                "keyword_score": round(keyword_score, 5),
                "vector_score": round(vector_score, 5),
                "version": version,
            }
        )
    relevant = [item for item in scored if item["score"] >= max(0.0, min(1.0, min_score))]
    return sorted(relevant, key=lambda item: item["score"], reverse=True)[: max(1, min(20, top_k))]


def _retrieve_pages(
    connection: sqlite3.Connection,
    kb_id: str,
    version: int,
    question: str,
    top_k: int = 5,
    page_cap: int = 4000,
    include_system: bool = False,
    include_raw: bool = False,
) -> list[dict[str, Any]]:
    """Index-driven page retrieval (D7). The document catalog mirrors index.md
    (the ground-truth page list); pages are selected by vocabulary overlap with
    the question and read whole — no per-query chunk re-derivation.

    Raw/degraded pages are archives awaiting compilation, not compiled
    knowledge: pages without frontmatter, or marked ``atlasgate-degraded``, are
    excluded by default (pass ``include_raw=True`` to surface them).
    """
    rows = connection.execute(
        "SELECT path,title,page_type,frontmatter_json,content FROM knowledge_documents WHERE kb_id=? AND version=? ORDER BY path",
        (kb_id, version),
    ).fetchall()
    query_tokens = set(tokenize(question))
    scored: list[dict[str, Any]] = []
    for row in rows:
        path = str(row["path"])
        if not include_system and path in SYSTEM_PAGE_PATHS:
            continue
        metadata = _parse_json(row["frontmatter_json"])
        degraded = metadata.get("atlasgate-degraded") is True
        if degraded and not include_raw:
            continue
        body = parse_frontmatter(str(row["content"] or ""))["body"]
        summary = " ".join(filter(None, [str(row["title"] or ""), str(row["page_type"] or ""), body[:400]]))
        overlap = len(query_tokens & set(tokenize(summary)))
        if overlap == 0:
            continue
        scored.append(
            {
                "path": path,
                "title": str(row["title"] or ""),
                "page_type": str(row["page_type"] or ""),
                "content": body[:page_cap],
                "score": overlap,
                "version": version,
            }
        )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[: max(1, min(20, top_k))]


def _rrf_fuse(
    lexical: list[dict[str, Any]],
    vector: list[dict[str, Any]],
    top_k: int,
    k: int = 60,
) -> list[dict[str, Any]]:
    """Reciprocal Rank Fusion (RAG phase 1, Q3).

    Fuses lexical page hits (score = vocabulary overlap) with dense page hits
    (vector_score = cosine) by rank: score(p) = sum(1 / (k + rank)). k=60 is
    the conventional default; scores are rank-only so the two signals need no
    weight tuning. Duplicate paths (e.g. several chunks of one page from the
    Qdrant backend) collapse to the highest-ranked hit.
    """

    def ranked(hits: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
        ordered = sorted(hits, key=lambda h: float(h.get(key) or 0.0), reverse=True)
        seen: set[str] = set()
        result: list[dict[str, Any]] = []
        for hit in ordered:
            if hit["path"] in seen:
                continue
            seen.add(hit["path"])
            result.append(hit)
        return result

    scores: dict[str, float] = {}
    by_path: dict[str, dict[str, Any]] = {}
    for rank_index, hit in enumerate(ranked(lexical, "score")):
        scores[hit["path"]] = scores.get(hit["path"], 0.0) + 1.0 / (k + rank_index + 1)
        by_path.setdefault(hit["path"], hit)
    for rank_index, hit in enumerate(ranked(vector, "vector_score")):
        scores[hit["path"]] = scores.get(hit["path"], 0.0) + 1.0 / (k + rank_index + 1)
        by_path.setdefault(hit["path"], hit)
    ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return [
        dict(by_path[path], rrf_score=round(scores[path], 6))
        for path, _ in ordered[: max(1, min(20, top_k))]
    ]


def _graph_degrees(connection: sqlite3.Connection, kb_id: str, version: int) -> dict[str, int]:
    """Page centrality from the versioned related-edge graph (Q8C).

    degree(path) = number of 'related' edges touching the page. Zero new
    dependencies; used only to break RRF ties in the pseudo-rerank step.
    """
    degrees: dict[str, int] = {}
    rows = connection.execute(
        """SELECT source_key, target_key FROM knowledge_graph_edges
           WHERE kb_id=? AND version=? AND relation='related'""",
        (kb_id, version),
    ).fetchall()
    for row in rows:
        for key in (str(row["source_key"]), str(row["target_key"])):
            if key.startswith("document:"):
                path = key[len("document:"):]
                degrees[path] = degrees.get(path, 0) + 1
    return degrees


def _expand_linked_pages(
    connection: sqlite3.Connection,
    kb_id: str,
    version: int,
    sources: list[dict[str, Any]],
    page_cap: int = 4000,
    include_system: bool = False,
    include_raw: bool = False,
    max_expand: int = 3,
) -> list[dict[str, Any]]:
    """RAG phase 3 (Q10A): multi-hop via the wiki link graph.

    Follows [[wikilinks]] found in the retrieved pages and appends the linked
    pages (by basename resolution, like the console jump) as expansion evidence.
    Zero extra LLM calls. System pages and degraded raw archives are excluded
    unless explicitly requested; expansion pages are un-scored evidence.
    """
    if not sources:
        return sources
    known = {
        str(row["path"])
        for row in connection.execute(
            "SELECT path FROM knowledge_documents WHERE kb_id=? AND version=?", (kb_id, version)
        ).fetchall()
    }
    system_paths = set(SYSTEM_PAGE_PATHS)
    degraded: set[str] = set()
    if not include_raw:
        degraded = {
            str(row["path"])
            for row in connection.execute(
                "SELECT path FROM knowledge_documents WHERE kb_id=? AND version=? AND frontmatter_json LIKE '%atlasgate-degraded%'",
                (kb_id, version),
            ).fetchall()
        }
    current = {source["path"] for source in sources}
    link_count: dict[str, int] = {}
    for source in sources:
        body = parse_frontmatter(str(source.get("content") or ""))["body"]
        for match in re.findall(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]", body):
            target = str(match).strip()
            base = target.split("/")[-1].replace(".md", "")
            resolved = None
            for candidate in known:
                if candidate == target or candidate == target + ".md" or candidate.split("/")[-1].replace(".md", "") == base:
                    resolved = candidate
                    break
            if resolved and resolved not in current and resolved not in system_paths and resolved not in degraded:
                link_count[resolved] = link_count.get(resolved, 0) + 1
    if not link_count:
        return sources
    pages = {
        str(row["path"]): row
        for row in connection.execute(
            "SELECT path,title,page_type,content FROM knowledge_documents WHERE kb_id=? AND version=?",
            (kb_id, version),
        ).fetchall()
    }
    expanded: list[dict[str, Any]] = []
    for path, count in sorted(link_count.items(), key=lambda kv: kv[1], reverse=True)[: max(1, max_expand)]:
        row = pages.get(path)
        if row is None:
            continue
        body = parse_frontmatter(str(row["content"] or ""))["body"]
        expanded.append({
            "path": path,
            "title": str(row["title"] or ""),
            "page_type": str(row["page_type"] or ""),
            "content": body[:page_cap],
            "score": 0.0,
            "version": version,
            "expansion": "linked",
        })
    return [*sources, *expanded]


# RAG phase 2 (Q8C): structural pseudo-rerank — pages with higher graph
# degree (more "related" edges, i.e. more central in the wiki) get a small
# boost that only breaks RRF ties, never overrides the fused ranking.
def _rerank_by_graph_degree(
    hits: list[dict[str, Any]], top_k: int, degree: dict[str, int] | None = None
) -> list[dict[str, Any]]:
    if len(hits) < 2 or not degree:
        return hits
    max_deg = max(degree.values()) if degree else 0
    if max_deg <= 0:
        return hits
    alpha = 0.05  # small structural bonus; RRF ranking stays dominant
    scored = sorted(
        hits,
        key=lambda hit: (hit.get("rrf_score") or 0.0) + alpha * (degree.get(hit["path"], 0) / max_deg),
        reverse=True,
    )
    return scored[: max(1, min(20, top_k))]


def _parse_json(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if value else {}
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}

def _validate_precomputed_sources(value: Any, version: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise AgentCoreError("invalid_semantic_sources", "precomputed_sources must be a list")
    sources: list[dict[str, Any]] = []
    for source in value[:20]:
        if not isinstance(source, dict) or not source.get("path") or not source.get("content"):
            raise AgentCoreError("invalid_semantic_sources", "semantic source is missing path or content")
        if int(source.get("version", version)) != version:
            raise AgentCoreError("invalid_semantic_sources", "semantic source version does not match master")
        sources.append(
            {
                "chunk_id": str(source.get("chunk_id") or ""),
                "path": str(source["path"]),
                "chunk_index": int(source.get("chunk_index") or 0),
                "heading_path": str(source.get("heading_path") or ""),
                "char_count": int(source.get("char_count") or len(str(source["content"]))),
                "content": str(source["content"]),
                "score": float(source.get("score") or 0),
                "keyword_score": float(source.get("keyword_score") or 0),
                "vector_score": float(source.get("vector_score") or source.get("score") or 0),
                "version": version,
            }
        )
    return sources


def _relevant_memories(
    connection: sqlite3.Connection, session_id: str, question: str, limit: int = 3
) -> list[dict[str, Any]]:
    if not session_id:
        return []
    query_tokens = set(tokenize(question))
    memories = []
    for row in connection.execute(
        """SELECT * FROM memories WHERE session_id=? AND agent_id='knowledge-agent'
        AND status='active' AND superseded_by IS NULL
        AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ORDER BY created_at DESC LIMIT 30""",
        (session_id,),
    ).fetchall():
        memory = dict(row)
        memory["score"] = sum(1 for token in tokenize(memory["content"]) if token in query_tokens)
        if memory["score"] > 0:
            memories.append(memory)
    selected = sorted(memories, key=lambda item: item["score"], reverse=True)[:limit]
    for memory in selected:
        connection.execute(
            "UPDATE memories SET access_count=access_count+1,last_accessed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            (memory["id"],),
        )
    connection.commit()
    return selected


def _source_view(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": source["path"],
        "chunk_id": source.get("chunk_id", ""),
        "chunk_index": source.get("chunk_index", 0),
        "heading_path": source.get("heading_path", ""),
        "char_count": source.get("char_count", len(source["content"])),
        "score": source["score"],
        "keyword_score": source.get("keyword_score", source.get("score", 0)),
        "vector_score": source.get("vector_score", 0),
        "version": source["version"],
        "expansion": source.get("expansion", ""),
        "snippet": source["content"][:320],
    }


def _extractive_answer(question: str, sources: list[dict[str, Any]]) -> str:
    chinese = bool(re.search(r"[\u3400-\u9fff]", question))
    if not sources:
        if chinese:
            return "当前已发布的知识版本中没有找到足够相关的证据，因此没有生成无依据的答案。"
        return "I could not find sufficiently relevant evidence in the published knowledge version. No unsupported answer was generated."
    lines = []
    for index, source in enumerate(sources[:3]):
        compact = re.sub(r"\s+", " ", source["content"]).strip()
        suffix = "..." if len(compact) > 360 else ""
        lines.append(f"[{index + 1}] {compact[:360]}{suffix}")
    if chinese:
        return (
            f'根据已发布的知识版本，与“{question[:100]}”最相关的证据是：\n\n'
            + "\n\n".join(lines)
            + "\n\n该回答由 Python Agent Core 以本地证据抽取模式生成。"
        )
    return (
        f'Based on the published knowledge version, the most relevant evidence for "{question[:100]}" is:\n\n'
        + "\n\n".join(lines)
        + "\n\nThis response was prepared by the Python Agent Core in local extractive mode; configure an upstream provider for synthesized reasoning."
    )
