from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atlasgate_agent.engine import AgentCoreError
from atlasgate_agent.lint import prepare_lint

KB_ID = "kb_lint"


class LintPromptTests(unittest.TestCase):
    def setUp(self) -> None:
        handle, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        connection = sqlite3.connect(self.db_path)
        connection.executescript(
            """
            CREATE TABLE knowledge_bases (
              id TEXT PRIMARY KEY, master_version INTEGER NOT NULL, purpose_md TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE knowledge_documents (
              id TEXT, kb_id TEXT, version INTEGER, path TEXT, content TEXT
            );
            """
        )
        connection.execute(
            "INSERT INTO knowledge_bases VALUES (?,1,'# 目的\\n维护一致的 wiki')",
            (KB_ID,),
        )
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?)",
            ("doc_a", KB_ID, 1, "entities/alpha.md", "# Alpha\n\n内容甲。"),
        )
        connection.execute(
            "INSERT INTO knowledge_documents VALUES (?,?,?,?,?)",
            ("doc_b", KB_ID, 1, "concepts/beta.md", "# Beta\n\n内容乙。"),
        )
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        os.unlink(self.db_path)

    def test_prepare_lint_includes_catalog_and_marker(self) -> None:
        result = prepare_lint(self.db_path, {"kb_id": KB_ID})
        system = result["messages"][0]["content"]
        user = result["messages"][1]["content"]
        self.assertIn("STAGE: lint", system)
        self.assertIn("issues", system)
        self.assertIn("entities/alpha.md", user)
        self.assertIn("concepts/beta.md", user)
        self.assertIn("维护一致的 wiki", user)
        self.assertEqual(result["context"]["pages"], 2)

    def test_prepare_lint_requires_kb_id(self) -> None:
        with self.assertRaises(AgentCoreError) as context:
            prepare_lint(self.db_path, {})
        self.assertEqual(context.exception.code, "invalid_lint_request")


if __name__ == "__main__":
    unittest.main()
