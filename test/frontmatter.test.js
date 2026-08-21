import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";

test("frontmatter parses scalars, arrays and block lists", () => {
  const doc = `---
type: entity
title: "OpenAI: o3"
confidence: EXTRACTED
sources: [raw/articles/a.md, raw/pdfs/b.pdf]
count: 3
active: true
tags:
  - llm
  - model
---

# Body
content here
`;
  const { metadata, body, hasFrontmatter } = parseFrontmatter(doc);
  assert.equal(hasFrontmatter, true);
  assert.equal(metadata.type, "entity");
  assert.equal(metadata.title, "OpenAI: o3");
  assert.equal(metadata.confidence, "EXTRACTED");
  assert.deepEqual(metadata.sources, ["raw/articles/a.md", "raw/pdfs/b.pdf"]);
  assert.equal(metadata.count, 3);
  assert.equal(metadata.active, true);
  assert.deepEqual(metadata.tags, ["llm", "model"]);
  assert.match(body, /^# Body/);
  assert.match(body, /content here/);
});

test("frontmatter without a fence returns the whole document as body", () => {
  const { metadata, body, hasFrontmatter } = parseFrontmatter("# Plain\n\nno frontmatter");
  assert.equal(hasFrontmatter, false);
  assert.deepEqual(metadata, {});
  assert.equal(body, "# Plain\n\nno frontmatter");
});

test("frontmatter serialization round-trips through the parser", () => {
  const metadata = {
    type: "concept",
    title: "混合检索: BM25 + Vector",
    confidence: "INFERRED",
    sources: ["raw/articles/mixed.md"],
    tags: ["检索", "rag"],
    active: true,
    weight: 0.45,
  };
  const block = serializeFrontmatter(metadata);
  const parsed = parseFrontmatter(block);
  assert.equal(parsed.hasFrontmatter, true);
  assert.deepEqual(parsed.metadata, metadata);
});

test("frontmatter handles CRLF and empty values", () => {
  const { metadata, hasFrontmatter } = parseFrontmatter("---\r\ntitle: 空值测试\r\nnote:\r\n---\r\n正文");
  assert.equal(hasFrontmatter, true);
  assert.equal(metadata.title, "空值测试");
  assert.equal(metadata.note, "");
});

test("frontmatter keeps safe strings bare, quotes what needs quoting, and round-trips", () => {
  const metadata = { title: "simple-title", note: '包含"引号"与:冒号' };
  const block = serializeFrontmatter(metadata);
  assert.match(block, /title: simple-title/);
  assert.deepEqual(parseFrontmatter(block).metadata, metadata);
});
