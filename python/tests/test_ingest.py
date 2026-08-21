from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atlasgate_agent.engine import AgentCoreError
from atlasgate_agent.ingest import prepare_ingest_analysis, prepare_ingest_generation

SOURCE_ID = "src_demo"
KB_ID = "kb_wiki"


class IngestPromptTests(unittest.TestCase):
    def setUp(self) -> None:
        handle, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        connection = sqlite3.connect(self.db_path)
        connection.executescript(
            """
            CREATE TABLE knowledge_bases (
              id TEXT PRIMARY KEY, master_version INTEGER NOT NULL,
              purpose_md TEXT NOT NULL DEFAULT '', schema_md TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE knowledge_documents (
              id TEXT, kb_id TEXT, version INTEGER, path TEXT, content TEXT
            );
            CREATE TABLE wiki_sources (
              id TEXT PRIMARY KEY, kb_id TEXT, path TEXT, filename TEXT,
              media_type TEXT, content TEXT, content_hash TEXT,
              size_bytes INTEGER, status TEXT, created_at TEXT
            );
            """
        )
        connection.execute(
            "INSERT INTO knowledge_bases VALUES (?,1,'# 目的\\n研究 LLM 网关','# 公约\\nentities/ 是实体页')",
            (KB_ID,),
        )
        connection.execute(
            "INSERT INTO wiki_sources VALUES (?,?,?,?,?,?,?,?,?,?)",
            (SOURCE_ID, KB_ID, "demo.md", "demo.md", "text/markdown",
             "# Demo\n\nAtlasGate 是一个 LLM 网关，支持路由与审计。", "hash", 20, "queued", "2026-01-01T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?)",
            ("doc_idx", KB_ID, 1, "index.md", "# 索引\n\n- [[entities/atlasgate]]"),
        )
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?)",
            ("doc_ent", KB_ID, 1, "entities/atlasgate.md", "# AtlasGate\n\n既有实体页。"),
        )
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        os.unlink(self.db_path)

    def test_analysis_prompt_grounds_source_and_wiki_context(self) -> None:
        result = prepare_ingest_analysis(self.db_path, {"kb_id": KB_ID, "source_id": SOURCE_ID})
        system = result["messages"][0]["content"]
        user = result["messages"][1]["content"]
        self.assertIn("STAGE: analysis", system)
        self.assertIn("ANALYSIS", system)
        self.assertIn("AtlasGate 是一个 LLM 网关", user)
        self.assertIn("WIKI PURPOSE", user)
        self.assertIn("研究 LLM 网关", user)
        self.assertEqual(result["context"]["source_path"], "demo.md")

    def test_generation_prompt_includes_analysis_and_existing_pages(self) -> None:
        analysis = {
            "page_plan": [
                {"action": "create", "path": "sources/demo.md", "type": "source", "title": "Demo"},
                {"action": "update", "path": "entities/atlasgate.md", "type": "entity", "title": "AtlasGate"},
            ]
        }
        result = prepare_ingest_generation(
            self.db_path, {"kb_id": KB_ID, "source_id": SOURCE_ID, "analysis": analysis, "max_pages": 20}
        )
        system = result["messages"][0]["content"]
        user = result["messages"][1]["content"]
        self.assertIn("STAGE: generation", system)
        self.assertIn("PAGE BUDGET: 20", user)
        self.assertIn("EXISTING PAGES TO UPDATE", user)
        self.assertIn("既有实体页", user)
        self.assertEqual(result["page_plan"], analysis["page_plan"])

    def test_missing_source_id_is_rejected(self) -> None:
        with self.assertRaises(AgentCoreError) as context:
            prepare_ingest_analysis(self.db_path, {"kb_id": KB_ID})
        self.assertEqual(context.exception.code, "invalid_ingest_request")

    def test_generation_requires_analysis_object(self) -> None:
        with self.assertRaises(AgentCoreError):
            prepare_ingest_generation(self.db_path, {"kb_id": KB_ID, "source_id": SOURCE_ID, "analysis": "not-json"})


if __name__ == "__main__":
    unittest.main()
