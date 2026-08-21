"""Minimal YAML-subset frontmatter parser/serializer (Python side).

Behavior contract must stay in sync with ``src/core/frontmatter.js``:

- A frontmatter block is a leading ``---`` line, content lines, and a closing
  ``---`` line. CRLF is normalized.
- Keys: ``[A-Za-z0-9_-]+``. Values: scalars, ``[a, b]`` inline arrays, and
  block lists (``- item`` lines after a bare ``key:``).
- Scalar coercion: quoted strings, booleans, integers and floats.
- Unknown/junk lines inside the block are skipped.
"""

from __future__ import annotations

import re
from typing import Any

_KEY_PATTERN = re.compile(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$")
_LIST_PATTERN = re.compile(r"^\s*-\s+(.+)$")
_FENCE_PATTERN = re.compile(r"^---\n([\s\S]*?)\n---(?:\n|$)")


def parse_frontmatter(content: str) -> dict[str, Any]:
    """Parse a markdown document.

    Returns ``{"metadata": {...}, "body": str, "hasFrontmatter": bool}``.
    """
    text = str(content or "")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    match = _FENCE_PATTERN.match(normalized)
    if not match:
        return {"metadata": {}, "body": text, "hasFrontmatter": False}
    body = normalized[match.end():]
    if body.startswith("\n"):
        body = body[1:]
    return {
        "metadata": _parse_block(match.group(1)),
        "body": body,
        "hasFrontmatter": True,
    }


def serialize_frontmatter(metadata: dict[str, Any]) -> str:
    """Serialize a metadata dict to a full frontmatter block (fences included)."""
    lines = ["---"]
    for key, value in (metadata or {}).items():
        lines.append(f"{key}: {_serialize_value(value)}")
    lines.append("---")
    return "\n".join(lines)


def _parse_block(block: str) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    current_key: str | None = None
    for line in block.split("\n"):
        list_match = _LIST_PATTERN.match(line) if current_key is not None else None
        if list_match:
            if not isinstance(metadata[current_key], list):
                metadata[current_key] = []
            metadata[current_key].append(_parse_scalar(list_match.group(1)))
            continue
        key_match = _KEY_PATTERN.match(line)
        if not key_match:
            continue
        current_key = key_match.group(1)
        raw = key_match.group(2).strip()
        metadata[current_key] = "" if raw == "" else _parse_scalar(raw)
    return metadata


def _parse_scalar(raw: str) -> Any:
    value = str(raw).strip()
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1]
        if not inner.strip():
            return []
        return [item for item in (_parse_scalar(part) for part in inner.split(",")) if item != ""]
    if len(value) >= 2 and (
        (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'"))
    ):
        return value[1:-1].replace('\\"', '"').replace("\\'", "'")
    if value == "true":
        return True
    if value == "false":
        return False
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?\d+\.\d+", value):
        return float(value)
    return value


def _serialize_value(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(_serialize_scalar(item) for item in value) + "]"
    return _serialize_scalar(value)


def _serialize_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if re.fullmatch(r"[A-Za-z0-9_\u3400-\u9fff .:()/+%-]+", text):
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
