/**
 * Minimal YAML-subset frontmatter parser/serializer shared by the wiki
 * data model (page_type, sources[], confidence, tags, ...).
 *
 * Behavior contract (must stay in sync with
 * python/atlasgate_agent/frontmatter.py):
 * - A frontmatter block is a leading `---` line, content lines, and a closing
 *   `---` line. CRLF is normalized.
 * - Keys: `[A-Za-z0-9_-]+`. Values: scalars, `[a, b]` inline arrays, and
 *   block lists (`- item` lines after a bare `key:`).
 * - Scalar coercion: quoted strings, booleans, integers and floats.
 * - Unknown/junk lines inside the block are skipped.
 */

const KEY_PATTERN = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const LIST_PATTERN = /^\s*-\s+(.+)$/;

/**
 * Parse a markdown document and return its frontmatter metadata plus the body
 * after the closing fence.
 * @param {string} content - markdown document.
 * @returns {{ metadata: Record<string, unknown>, body: string, hasFrontmatter: boolean }}
 */
export function parseFrontmatter(content) {
  const text = String(content ?? "");
  const normalized = text.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return { metadata: {}, body: text, hasFrontmatter: false };
  return {
    metadata: parseFrontmatterBlock(match[1]),
    body: normalized.slice(match[0].length).replace(/^\n/, ""),
    hasFrontmatter: true,
  };
}

/**
 * Serialize a metadata object to a full frontmatter block (fences included).
 * @param {Record<string, unknown>} metadata
 * @returns {string}
 */
export function serializeFrontmatter(metadata) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata ?? {})) {
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function parseFrontmatterBlock(block) {
  const metadata = {};
  let currentKey = null;
  for (const line of block.split("\n")) {
    const listMatch = currentKey !== null && LIST_PATTERN.exec(line);
    if (listMatch) {
      if (!Array.isArray(metadata[currentKey])) metadata[currentKey] = [];
      metadata[currentKey].push(parseScalar(listMatch[1]));
      continue;
    }
    const keyMatch = KEY_PATTERN.exec(line);
    if (!keyMatch) continue;
    currentKey = keyMatch[1];
    const raw = keyMatch[2].trim();
    metadata[currentKey] = raw === "" ? "" : parseScalar(raw);
  }
  return metadata;
}

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(",").map((part) => parseScalar(part)).filter((item) => item !== "");
  }
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function serializeValue(value) {
  return Array.isArray(value) ? `[${value.map(serializeScalar).join(", ")}]` : serializeScalar(value);
}

function serializeScalar(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const text = String(value);
  // Safe unquoted set: letters, digits, CJK, underscore, space, basic punctuation.
  return /^[A-Za-z0-9_\u3400-\u9fff .:()/+%-]+$/.test(text) ? text : JSON.stringify(text);
}
