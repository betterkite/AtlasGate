import path from "node:path";
import { spawn } from "node:child_process";
import { HttpError } from "../core/http.js";

export class PythonAgentBridge {
  constructor(config) {
    this.config = config;
    this.workerScript = path.join(config.root, "python", "agent_worker.py");
    this.workers = [];
    this.queue = [];
    this.sequence = 0;
    this.stopped = false;
    // Consecutive spawn failures back off exponentially and eventually mark
    // the pool unhealthy. Without this, a missing/broken python binary causes
    // retireWorker -> spawnWorker(true) to loop forever, leaking file
    // descriptors until the whole server stops accepting connections.
    this.spawnFailures = 0;
    this.lastSpawnFailureAt = 0;
    this.metrics = { started: 0, restarts: 0, requests: 0, rejected: 0 };
  }

  prepare(input) {
    if (this.config.dbPath === ":memory:") {
      throw new HttpError(500, "Python Agent Core requires a file-backed SQLite database", "python_agent_db_unavailable");
    }
    if (this.stopped) throw new HttpError(503, "Python Agent pool is stopped", "python_agent_unavailable");
    if (this.unhealthy()) throw new HttpError(503, "Python Agent pool is unavailable: workers failed to start", "python_agent_unavailable");
    this.ensurePool();
    if (this.queue.length >= this.config.pythonWorkerQueueLimit && !this.workers.some((worker) => !worker.pending)) {
      this.metrics.rejected += 1;
      throw new HttpError(503, "Python Agent queue is full", "python_agent_queue_full");
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: `py_${++this.sequence}`, input, resolve, reject });
      this.dispatch();
    });
  }

  unhealthy() {
    return this.spawnFailures >= 2 && Date.now() - this.lastSpawnFailureAt < this.backoffMs();
  }

  backoffMs() {
    return Math.min(30_000, 500 * 2 ** (this.spawnFailures - 2));
  }

  ensurePool() {
    while (!this.stopped && !this.unhealthy() && this.workers.length < this.config.pythonWorkerPoolSize) this.spawnWorker(false);
  }

  spawnWorker(restart) {
    if (this.stopped || this.unhealthy()) return;
    const worker = {
      child: null,
      pending: null,
      buffer: "",
      stderr: "",
      requests: 0,
      dead: false,
    };
    const child = spawn(this.config.pythonCommand, [this.workerScript, "--db", this.config.dbPath, "--loop"], {
      cwd: this.config.root,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    worker.child = child;
    this.workers.push(worker);
    this.metrics.started += 1;
    if (restart) this.metrics.restarts += 1;
    child.on("spawn", () => { this.spawnFailures = 0; });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(worker, chunk));
    child.stderr.on("data", (chunk) => { worker.stderr = `${worker.stderr}${chunk}`.slice(-4_096); });
    child.on("error", (error) => {
      this.spawnFailures += 1;
      this.lastSpawnFailureAt = Date.now();
      this.retireWorker(worker, `failed to start: ${error.message}`);
    });
    child.on("close", (code) => this.retireWorker(worker, `exited with code ${code}`));
    setImmediate(() => this.dispatch());
  }

  onStdout(worker, chunk) {
    worker.buffer += chunk;
    let newline;
    while ((newline = worker.buffer.indexOf("\n")) >= 0) {
      const line = worker.buffer.slice(0, newline).trim();
      worker.buffer = worker.buffer.slice(newline + 1);
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        this.retireWorker(worker, "returned invalid JSON output");
        return;
      }
      const job = worker.pending;
      if (!job || payload.id !== job.id) {
        this.retireWorker(worker, "returned an unexpected response id");
        return;
      }
      clearTimeout(job.timeout);
      worker.pending = null;
      worker.requests += 1;
      this.metrics.requests += 1;
      if (payload.ok) job.resolve(payload.result);
      else job.reject(this.payloadError(payload));
      if (worker.requests >= this.config.pythonWorkerMaxRequests) {
        this.retireWorker(worker, "recycled after maximum requests", false);
        return;
      }
      this.dispatch();
    }
  }

  payloadError(payload) {
    const code = payload.error?.code ?? "python_agent_error";
    const status = code === "kb_not_found" ? 404 : 400;
    return new HttpError(status, payload.error?.message ?? "Python Agent Core failed", code);
  }

  dispatch() {
    if (this.stopped) return;
    for (const worker of this.workers) {
      if (worker.dead || worker.pending || !this.queue.length) continue;
      const job = this.queue.shift();
      worker.pending = job;
      job.timeout = setTimeout(() => {
        if (worker.pending !== job) return;
        job.reject(new HttpError(504, "Python Agent request timed out", "python_agent_timeout"));
        worker.pending = null;
        this.retireWorker(worker, "request timed out", false);
      }, this.config.pythonAgentTimeoutMs);
      try {
        worker.child.stdin.write(`${JSON.stringify({ id: job.id, input: job.input })}\n`);
      } catch (error) {
        clearTimeout(job.timeout);
        worker.pending = null;
        job.reject(new HttpError(503, `Python Agent write failed: ${error.message}`, "python_agent_unavailable"));
        this.retireWorker(worker, "stdin write failed", false);
      }
    }
  }

  retireWorker(worker, reason, rejectPending = true) {
    if (worker.dead) return;
    worker.dead = true;
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    if (worker.pending) {
      const job = worker.pending;
      clearTimeout(job.timeout);
      worker.pending = null;
      if (rejectPending) {
        const detail = worker.stderr.trim();
        job.reject(new HttpError(503, `Python Agent worker ${reason}${detail ? `: ${detail}` : ""}`, "python_agent_unavailable"));
      }
    }
    if (!worker.child.killed) worker.child.kill();
    if (!this.stopped) {
      if (this.unhealthy()) {
        // Pool is down: reject queued work so callers fail fast instead of
        // hanging on a job no worker can pick up.
        this.rejectQueue("Python Agent pool is unavailable: workers failed to start");
        return;
      }
      this.spawnWorker(true);
      this.dispatch();
    }
  }

  rejectQueue(message) {
    const error = new HttpError(503, message, "python_agent_unavailable");
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timeout);
      job.reject(error);
    }
  }

  status() {
    return {
      state: this.stopped ? "stopped" : this.unhealthy() ? "unhealthy" : "ready",
      size: this.workers.length,
      configured_size: this.config.pythonWorkerPoolSize,
      busy: this.workers.filter((worker) => worker.pending).length,
      queued: this.queue.length,
      ...this.metrics,
    };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const error = new HttpError(503, "Python Agent pool is stopping", "python_agent_unavailable");
    for (const job of this.queue.splice(0)) job.reject(error);
    for (const worker of [...this.workers]) {
      if (worker.pending) {
        clearTimeout(worker.pending.timeout);
        worker.pending.reject(error);
        worker.pending = null;
      }
      worker.dead = true;
      if (!worker.child.killed) worker.child.kill();
    }
    this.workers = [];
  }
}
