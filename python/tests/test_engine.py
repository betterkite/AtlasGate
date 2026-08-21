from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atlasgate_agent.engine import _rerank_by_graph_degree, _rrf_fuse, feature_vector, prepare_knowledge_run, tokenize


class AgentEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        handle, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        connection = sqlite3.connect(self.db_path)
        connection.executescript(
            """
            CREATE TABLE knowledge_bases (id TEXT PRIMARY KEY, master_version INTEGER NOT NULL);
            CREATE TABLE knowledge_documents (
              id TEXT, kb_id TEXT, version INTEGER, path TEXT, title TEXT,
              page_type TEXT, frontmatter_json TEXT, content TEXT
            );
            CREATE TABLE knowledge_chunks (
              id TEXT, kb_id TEXT, version INTEGER, document_path TEXT,
              content TEXT, tokens_json TEXT, vector_json TEXT
            );
            CREATE TABLE memories (
              id TEXT, session_id TEXT, agent_id TEXT, content TEXT,
              source_run_id TEXT, created_at TEXT
            );
            CREATE TABLE skills (
              id TEXT, name TEXT, version TEXT, instructions TEXT,
              value_score REAL, enabled INTEGER
            );
            CREATE TABLE agent_skills (agent_id TEXT, skill_id TEXT);
            CREATE TABLE knowledge_graph_edges (
              id TEXT, kb_id TEXT, version INTEGER, source_key TEXT, target_key TEXT,
              relation TEXT, weight REAL, metadata_json TEXT
            );
            """
        )
        content = "Memory is only read when the request explicitly enables it."
        connection.execute("INSERT INTO knowledge_bases VALUES ('kb_test',1)")
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_mem", "kb_test", 1, "memory.md", "Memory", "note", "{}", content),
        )
        connection.execute(
            "INSERT INTO knowledge_chunks VALUES (?,?,?,?,?,?,?)",
            (
                "chunk_1",
                "kb_test",
                1,
                "memory.md",
                content,
                json.dumps(tokenize(content)),
                json.dumps(feature_vector(content)),
            ),
        )
        connection.execute(
            "INSERT INTO skills VALUES (?,?,?,?,?,?)",
            ("skill_1", "grounded", "1.0.0", "Cite evidence.", 1.0, 1),
        )
        connection.execute("INSERT INTO agent_skills VALUES ('knowledge-agent','skill_1')")
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        os.unlink(self.db_path)

    def test_prepare_knowledge_run_returns_sources_and_prompt(self) -> None:
        result = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "When is memory read?", "use_memory": False},
        )
        self.assertEqual(result["sources"][0]["path"], "memory.md")
        self.assertEqual(result["skills"][0]["name"], "grounded")
        self.assertFalse(result["memory"]["enabled"])
        self.assertIn("EVIDENCE", result["messages"][0]["content"])
        self.assertIn("Python Agent Core", result["fallback_answer"])

    def test_chinese_tokenization_is_deterministic(self) -> None:
        self.assertEqual(tokenize("知识版本"), ["知识", "识版", "版本"])
        self.assertEqual(feature_vector("same"), feature_vector("same"))

    def test_zero_score_chunks_are_not_returned_as_evidence(self) -> None:
        result = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "1+1等于几", "use_memory": False},
        )
        self.assertEqual(result["sources"], [])
        self.assertIn("没有找到足够相关的证据", result["fallback_answer"])

    def test_page_retrieval_reads_whole_pages_and_excludes_raw_archives(self) -> None:
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_compiled", "kb_test", 1, "concepts/routing.md", "Routing", "concept",
             '{"type": "concept", "title": "Routing"}',
             "# Routing\n\nAtlasGate 通过确定性 provider:model 路由或 auto 路由调用上游模型。"),
        )
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_raw", "kb_test", 1, "sources/第021章_内门的人.md", "第021章_内门的人", "source",
             '{"type": "source", "atlasgate-degraded": true}',
             "向顶天在灯下看那半块石头，断口在火光里泛着暗光。第021章围绕向顶天与石壁纹路展开。"),
        )
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_degraded", "kb_test", 1, "sources/第020章.md", "第020章", "source",
             '{"type": "source", "atlasgate-degraded": true}',
             "向顶天在青云宗的黑暗面中看到那道纹路，石壁上的走法让他想起堂主召见那回。第020章剧情围绕向顶天展开。"),
        )
        connection.commit()
        connection.close()

        # Default: only the compiled page (with frontmatter) is retrieved.
        result = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "AtlasGate 如何路由调用上游模型", "use_memory": False},
        )
        self.assertIn("concepts/routing.md", [source["path"] for source in result["sources"]])
        self.assertNotIn("sources/第021章_内门的人.md", [source["path"] for source in result["sources"]])
        self.assertNotIn("sources/第020章.md", [source["path"] for source in result["sources"]])

        # include_raw surfaces the raw archive and degraded pages.
        result_raw = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "向顶天石壁纹路", "use_memory": False, "include_raw": True},
        )
        paths = [source["path"] for source in result_raw["sources"]]
        self.assertIn("sources/第021章_内门的人.md", paths)
        self.assertIn("sources/第020章.md", paths)

        # chunk mode keeps the legacy chunk retrieval available.
        result_chunk = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "When is memory read?", "use_memory": False, "retrieval_mode": "chunk"},
        )
        self.assertEqual(result_chunk["sources"][0]["path"], "memory.md")


    def test_rrf_fuse_merges_and_dedupes_rankings(self) -> None:
        lexical = [
            {"path": "a.md", "score": 3, "content": "A"},
            {"path": "b.md", "score": 2, "content": "B"},
            {"path": "c.md", "score": 1, "content": "C"},
        ]
        vector = [
            {"path": "b.md", "vector_score": 0.9, "content": "B"},
            {"path": "d.md", "vector_score": 0.8, "content": "D"},
        ]
        fused = _rrf_fuse(lexical, vector, top_k=3)
        paths = [hit["path"] for hit in fused]
        # b ranks in both lists -> highest; a (lexical #1) beats d (vector #2).
        self.assertEqual(paths, ["b.md", "a.md", "d.md"])
        self.assertEqual(len(paths), len(set(paths)), "fused hits must be deduped by path")

    def test_prepare_knowledge_run_fuses_dense_and_lexical_hits(self) -> None:
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_lex", "kb_test", 1, "concepts/routing.md", "Routing", "concept",
             '{"type": "concept", "title": "Routing"}',
             "# Routing\n\nAtlasGate 通过确定性 provider:model 路由或 auto 路由调用上游模型。"),
        )
        # Dense-only page: its vocabulary shares nothing with the question, so
        # it can only enter via precomputed_sources (vector hits).
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_dense", "kb_test", 1, "concepts/deepseek.md", "DeepSeek", "concept",
             '{"type": "concept", "title": "DeepSeek"}',
             "# DeepSeek\n\n半导体封装工艺与晶圆测试的详细说明。"),
        )
        connection.commit()
        connection.close()
        precomputed = [{
            "path": "concepts/deepseek.md",
            "content": "半导体封装工艺与晶圆测试的详细说明。",
            "score": 0.85, "vector_score": 0.85, "version": 1,
        }]
        result = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "AtlasGate 如何路由调用上游模型",
             "use_memory": False, "precomputed_sources": precomputed},
        )
        paths = [source["path"] for source in result["sources"]]
        self.assertIn("concepts/routing.md", paths, "lexical hit must survive fusion")
        self.assertIn("concepts/deepseek.md", paths, "dense hit must enter via precomputed_sources")
        self.assertLessEqual(len(paths), 5)


    def test_graph_degree_pseudo_rerank_breaks_rrf_ties(self) -> None:
        fused = [
            {"path": "a.md", "content": "A", "rrf_score": 0.02},
            {"path": "b.md", "content": "B", "rrf_score": 0.02},
            {"path": "c.md", "content": "C", "rrf_score": 0.01},
        ]
        degree = {"a.md": 1, "b.md": 5, "c.md": 1}  # b is most central
        ranked = _rerank_by_graph_degree(fused, 3, degree=degree)
        self.assertEqual([h["path"] for h in ranked], ["b.md", "a.md", "c.md"])
        # Without degree data the fused order is preserved.
        same = _rerank_by_graph_degree(fused, 3)
        self.assertEqual([h["path"] for h in same], ["a.md", "b.md", "c.md"])


    def test_multihop_expands_linked_pages_as_evidence(self) -> None:
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_a", "kb_test", 1, "concepts/a.md", "A", "concept",
             '{"type": "concept", "title": "A"}',
             "# A\n\n路由与上游模型。参见 [[concepts/b]] 与 [[entities/absent]]。"),
        )
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)",
            ("doc_b", "kb_test", 1, "concepts/b.md", "B", "concept",
             '{"type": "concept", "title": "B"}',
             "# B\n\n半导体封装工艺与晶圆测试。"),
        )
        connection.commit()
        connection.close()
        result = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "AtlasGate 如何路由调用上游模型", "use_memory": False},
        )
        paths = [source["path"] for source in result["sources"]]
        self.assertIn("concepts/a.md", paths)
        self.assertIn("concepts/b.md", paths, "linked page must be expanded as evidence")
        linked = next(source for source in result["sources"] if source["path"] == "concepts/b.md")
        self.assertEqual(linked["expansion"], "linked")
        # multihop=false disables expansion.
        result_off = prepare_knowledge_run(
            self.db_path,
            {"kb_id": "kb_test", "question": "AtlasGate 如何路由调用上游模型", "use_memory": False, "multihop": False},
        )
        self.assertNotIn("concepts/b.md", [s["path"] for s in result_off["sources"]])

    def test_system_prompt_requires_explicit_insufficient_evidence(self) -> None:
        result = prepare_knowledge_run(
            self.db_path, {"kb_id": "kb_test", "question": "anything", "use_memory": False}
        )
        self.assertIn("does not support the question", result["messages"][0]["content"])


if __name__ == "__main__":
    unittest.main()
