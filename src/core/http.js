import fs from "node:fs";
import path from "node:path";

export class HttpError extends Error {
  constructor(status, message, code = "request_error", details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res, status, payload, headers = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    ...securityHeaders(),
    ...headers,
  });
  res.end(data);
}

export async function readJson(req, limit = 28 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body is too large", "body_too_large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

function compile(pattern) {
  const names = [];
  const source = pattern
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        names.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}/?$`), names };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, ...compile(pattern), handler });
  }

  get(pattern, handler) { this.add("GET", pattern, handler); }
  post(pattern, handler) { this.add("POST", pattern, handler); }
  patch(pattern, handler) { this.add("PATCH", pattern, handler); }
  put(pattern, handler) { this.add("PUT", pattern, handler); }
  delete(pattern, handler) { this.add("DELETE", pattern, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.regex);
      if (!match) continue;
      return {
        handler: route.handler,
        params: Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])])),
      };
    }
    return null;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function serveStatic(res, webRoot, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(webRoot, relative);
  if (!target.startsWith(path.resolve(webRoot)) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return false;
  }
  const data = fs.readFileSync(target);
  res.writeHead(200, {
    "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
    "content-length": data.length,
    "cache-control": "no-cache",
    ...securityHeaders(),
  });
  res.end(data);
  return true;
}

function securityHeaders() {
  return {
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

export function errorPayload(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  console.error(error);
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "Internal server error" } },
  };
}
