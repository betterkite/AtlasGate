import crypto from "node:crypto";

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function now() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableHash(value) {
  const hash = crypto.createHash("sha256").update(value).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function estimateTokens(value) {
  if (!value) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.max(1, Math.ceil((text.length - cjk) / 4 + cjk / 1.5));
}

export function redact(value) {
  if (!value) return value;
  return String(value)
    .replace(/\b(sk|pk|rk)-[a-zA-Z0-9_-]{8,}\b/g, "$1-***")
    .replace(/(bearer\s+)[a-zA-Z0-9._-]+/gi, "$1***")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[PRIVATE KEY REDACTED]");
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function tokenize(text) {
  const normalized = String(text ?? "").toLowerCase();
  const words = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjkRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  const cjk = [];
  for (const run of cjkRuns) {
    if (run.length === 1) cjk.push(run);
    for (let i = 0; i < run.length - 1; i += 1) cjk.push(run.slice(i, i + 2));
  }
  return [...words, ...cjk];
}

export function featureVector(text, dimensions = 96) {
  const vector = Array(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const digest = crypto.createHash("sha1").update(token).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    const sign = digest[2] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export function cosine(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}
