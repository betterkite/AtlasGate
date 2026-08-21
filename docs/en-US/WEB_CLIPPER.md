# Web Clipper (Web Clipping)

AtlasGate's web ingestion goes through **URL fetching** (already shipped with the compilation pipeline, current version 0.4.0): `POST /api/knowledge-bases/:id/ingest` with `kind=url` fetches the page and converts it to Markdown text, then feeds it into the two-step compilation pipeline (analysis → generation), and `ingest_mode` decides whether it stays pending or is merged and published automatically.

## How to use

**Option 1: manual entry in the console (recommended)**
Open the「Knowledge → Ingest queue」tab, select「URL fetch」, paste the article link, and enqueue it. The system fetches HTML → text and, according to `ingest_mode` (default `review`), either leaves the result as a pending review or merges and publishes it automatically.

**Option 2: HTTP (reproducible example)**

Log in first to save the session, then create a knowledge base and capture its id in `$KB`:

```bash
# Login (default admin / atlasgate-admin)
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'

# Create a knowledge base (review mode; the result stays as a pending Change)
KB=$(curl -b cookies.txt -X POST http://127.0.0.1:4310/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"Clipping KB","ingest_mode":"review"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "KB=$KB"

# URL ingest: fetch → text → two-step compilation (degrades to an atlasgate-degraded archive page without a real model)
curl -b cookies.txt -X POST "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest" \
  -H 'content-type: application/json' \
  -d '{"kind":"url","url":"https://example.com/article","author":"clipper"}'

# Inspect the ingest queue and the compiled output
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/ingest-queue?limit=5"
curl -b cookies.txt "http://127.0.0.1:4310/api/knowledge-bases/$KB/pages"
```

**Option 3: Agent / MCP**

```bash
# MCP tool
wiki_ingest { "kb_id": "...", "kind": "url", "url": "https://example.com/article" }
```

## Browser extension (optional follow-up)

A standalone Manifest V3 extension is not included in this repository (D5 optional; URL clipping itself is already shipped with the compilation pipeline). Implementation points (for a later integration):

1. `content_scripts` extract the article body with `Readability` → convert to Markdown with `Turndown`;
2. configure the AtlasGate address and the console session cookie via the extension `options` (same origin required to carry the cookie);
3. call `POST /api/knowledge-bases/:id/ingest` (`kind=paste` + `text`), relying on the existing deduplication, queue, and review semantics.

## Fetching boundaries

- Only `http(s)` URLs are supported (other protocols return `invalid_url`); redirects are followed, with a 30-second timeout;
- only lightweight HTML → text conversion is performed (title hierarchy / lists / paragraph levels are preserved); login-gated pages are not supported;
- for content behind a login, paste the article body instead (`kind=paste`).
