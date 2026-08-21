from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atlasgate_agent.frontmatter import parse_frontmatter, serialize_frontmatter


class FrontmatterTests(unittest.TestCase):
    def test_parses_scalars_arrays_and_block_lists(self) -> None:
        doc = (
            "---\n"
            "type: entity\n"
            'title: "OpenAI: o3"\n'
            "confidence: EXTRACTED\n"
            "sources: [raw/articles/a.md, raw/pdfs/b.pdf]\n"
            "count: 3\n"
            "active: true\n"
            "tags:\n"
            "  - llm\n"
            "  - model\n"
            "---\n"
            "\n"
            "# Body\n"
            "content here\n"
        )
        result = parse_frontmatter(doc)
        self.assertTrue(result["hasFrontmatter"])
        self.assertEqual(result["metadata"]["type"], "entity")
        self.assertEqual(result["metadata"]["title"], "OpenAI: o3")
        self.assertEqual(result["metadata"]["confidence"], "EXTRACTED")
        self.assertEqual(result["metadata"]["sources"], ["raw/articles/a.md", "raw/pdfs/b.pdf"])
        self.assertEqual(result["metadata"]["count"], 3)
        self.assertTrue(result["metadata"]["active"])
        self.assertEqual(result["metadata"]["tags"], ["llm", "model"])
        self.assertTrue(result["body"].startswith("# Body"))

    def test_no_fence_returns_whole_document(self) -> None:
        result = parse_frontmatter("# Plain\n\nno frontmatter")
        self.assertFalse(result["hasFrontmatter"])
        self.assertEqual(result["metadata"], {})
        self.assertEqual(result["body"], "# Plain\n\nno frontmatter")

    def test_serialize_round_trip(self) -> None:
        metadata = {
            "type": "concept",
            "title": "混合检索: BM25 + Vector",
            "confidence": "INFERRED",
            "sources": ["raw/articles/mixed.md"],
            "tags": ["检索", "rag"],
            "active": True,
            "weight": 0.45,
        }
        block = serialize_frontmatter(metadata)
        result = parse_frontmatter(block)
        self.assertTrue(result["hasFrontmatter"])
        self.assertEqual(result["metadata"], metadata)

    def test_crlf_and_empty_values(self) -> None:
        result = parse_frontmatter("---\r\ntitle: 空值测试\r\nnote:\r\n---\r\n正文")
        self.assertTrue(result["hasFrontmatter"])
        self.assertEqual(result["metadata"]["title"], "空值测试")
        self.assertEqual(result["metadata"]["note"], "")


if __name__ == "__main__":
    unittest.main()
