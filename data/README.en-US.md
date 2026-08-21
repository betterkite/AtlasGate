# Data Directory (Runtime Artifacts)

This directory contains runtime-generated data and must not be committed to source control.

- `atlasgate.db`, `-wal`, and `-shm`: the SQLite database, including versioned Wiki pages in `knowledge_documents`.
- `backups/`: migration backups created before Wiki model upgrades.
- `server.log`: process log output.

After startup, AtlasGate mirrors each knowledge base Master page to `knowledge/<id>/` as Markdown. The mirror is readable by Obsidian and can be refreshed from the console or exported as ZIP. See [LLM Wiki](../docs/en-US/WIKI.md).

