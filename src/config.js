import path from "node:path";
import { spawnSync } from "node:child_process";

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

// Detected once per process: prefer `python` when it is Python 3, otherwise
// fall back to `python3` so `npm start` works on machines without a `python`
// alias (e.g. some WSL/CI images). Always overridable via ATLASGATE_PYTHON.
let detectedPythonCommand = null;
function detectPythonCommand() {
  if (detectedPythonCommand) return detectedPythonCommand;
  for (const candidate of ["python", "python3"]) {
    try {
      const probe = spawnSync(candidate, ["--version"], { timeout: 3000, windowsHide: true, encoding: "utf8" });
      if (probe.status === 0 && /Python 3\.\d+/.test(`${probe.stdout}${probe.stderr}`)) {
        detectedPythonCommand = candidate;
        return candidate;
      }
    } catch { /* try the next candidate */ }
  }
  return "python";
}

export function loadConfig(overrides = {}) {
  const root = path.resolve(import.meta.dirname, "..");
  const configuredDbPath = overrides.dbPath ?? process.env.ATLASGATE_DB_PATH ?? path.join(root, "data", "atlasgate.db");
  const devMode = overrides.devMode ?? bool(process.env.ATLASGATE_DEV_MODE, true);
  return {
    root,
    host: overrides.host ?? process.env.ATLASGATE_HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? process.env.ATLASGATE_PORT ?? 4310),
    dbPath: configuredDbPath === ":memory:" ? configuredDbPath : path.resolve(configuredDbPath),
    devMode,
    devKey: overrides.devKey ?? process.env.ATLASGATE_DEV_KEY ?? "atlasgate-dev-key",
    adminUsername: overrides.adminUsername ?? process.env.ATLASGATE_ADMIN_USERNAME ?? "admin",
    adminPassword: overrides.adminPassword ?? process.env.ATLASGATE_ADMIN_PASSWORD ?? (devMode ? "atlasgate-admin" : ""),
    adminSessionTtlMs: Number(overrides.adminSessionTtlMs ?? process.env.ATLASGATE_ADMIN_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000),
    pythonCommand: overrides.pythonCommand ?? process.env.ATLASGATE_PYTHON ?? detectPythonCommand(),
    pythonAgentTimeoutMs: Number(overrides.pythonAgentTimeoutMs ?? process.env.ATLASGATE_PYTHON_TIMEOUT_MS ?? 15_000),
    pythonWorkerPoolSize: Math.max(1, Number(overrides.pythonWorkerPoolSize ?? process.env.ATLASGATE_PYTHON_WORKER_POOL_SIZE ?? 2)),
    pythonWorkerQueueLimit: Math.max(0, Number(overrides.pythonWorkerQueueLimit ?? process.env.ATLASGATE_PYTHON_WORKER_QUEUE_LIMIT ?? 100)),
    pythonWorkerMaxRequests: Math.max(1, Number(overrides.pythonWorkerMaxRequests ?? process.env.ATLASGATE_PYTHON_WORKER_MAX_REQUESTS ?? 1_000)),
    // "local" = pure lexical page retrieval (legacy default)
    // "hybrid" = lexical + dense vectors fused by RRF (phase 1; degrades to
    //            pure lexical automatically when no embedding service is set)
    // "qdrant" = dense-only retrieval backed by a Qdrant server
    retrievalMode: overrides.retrievalMode ?? process.env.ATLASGATE_RETRIEVAL_MODE ?? "hybrid",
    embeddingBaseUrl: overrides.embeddingBaseUrl ?? process.env.ATLASGATE_EMBEDDING_BASE_URL ?? "",
    embeddingApiKey: overrides.embeddingApiKey ?? process.env.ATLASGATE_EMBEDDING_API_KEY ?? "",
    embeddingModel: overrides.embeddingModel ?? process.env.ATLASGATE_EMBEDDING_MODEL ?? "bge-small-zh-v1.5",
    embeddingDimensions: Number(overrides.embeddingDimensions ?? process.env.ATLASGATE_EMBEDDING_DIMENSIONS ?? 512),
    qdrantUrl: overrides.qdrantUrl ?? process.env.ATLASGATE_QDRANT_URL ?? "",
    qdrantApiKey: overrides.qdrantApiKey ?? process.env.ATLASGATE_QDRANT_API_KEY ?? "",
    qdrantCollectionPrefix: overrides.qdrantCollectionPrefix ?? process.env.ATLASGATE_QDRANT_COLLECTION_PREFIX ?? "atlasgate",
    requestTimeoutMs: Number(
      overrides.requestTimeoutMs ?? process.env.ATLASGATE_REQUEST_TIMEOUT_MS ?? 60_000,
    ),
    // RAG phase 2 (Q9): when the first retrieval round finds no evidence, ask
    // a real LLM to rewrite the question into a more searchable form and retry
    // once. No-ops without a real (non-mock) provider.
    queryRewriteEnabled: overrides.queryRewriteEnabled ?? bool(process.env.ATLASGATE_QUERY_REWRITE_ENABLED, true),
    wiki: {
      defaultIngestMode: overrides.wikiDefaultIngestMode ?? process.env.ATLASGATE_WIKI_INGEST_MODE ?? "review",
      maxPagesPerSource: Math.max(1, Number(overrides.wikiMaxPagesPerSource ?? process.env.ATLASGATE_WIKI_MAX_PAGES_PER_SOURCE ?? 20)),
      ingestPollMs: Math.max(200, Number(overrides.wikiIngestPollMs ?? process.env.ATLASGATE_WIKI_INGEST_POLL_MS ?? 2000)),
      ingestConcurrency: Math.max(1, Number(overrides.wikiIngestConcurrency ?? process.env.ATLASGATE_WIKI_INGEST_CONCURRENCY ?? 1)),
      // One-way md mirror directory (relative to project root, or absolute).
      // Set ATLASGATE_WIKI_SYNC_DIR="" to disable mirroring.
      syncDir: overrides.wikiSyncDir ?? process.env.ATLASGATE_WIKI_SYNC_DIR ?? "knowledge",
      systemPaths: {
        purpose: overrides.wikiPurposePath ?? process.env.ATLASGATE_WIKI_PURPOSE_PATH ?? "purpose.md",
        schema: overrides.wikiSchemaPath ?? process.env.ATLASGATE_WIKI_SCHEMA_PATH ?? "schema.md",
        index: overrides.wikiIndexPath ?? process.env.ATLASGATE_WIKI_INDEX_PATH ?? "index.md",
        log: overrides.wikiLogPath ?? process.env.ATLASGATE_WIKI_LOG_PATH ?? "log.md",
        overview: overrides.wikiOverviewPath ?? process.env.ATLASGATE_WIKI_OVERVIEW_PATH ?? "overview.md",
      },
    },
  };
}
