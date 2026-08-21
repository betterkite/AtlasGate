import { HttpError } from "../core/http.js";
import { id, now } from "../core/utils.js";

/**
 * Persistent LLM Wiki ingest queue. Jobs survive restarts: running jobs are
 * recovered to pending on boot, and a failed job retries up to 2 times before
 * being marked failed. Processing is serial per knowledge base (one running
 * job per KB at a time) so compiler LLM calls never race each other's pending
 * Change baselines.
 */
export class IngestQueue {
  constructor(db) {
    this.db = db;
  }

  list(kbId = null, limit = 100) {
    const rows = kbId
      ? this.db.prepare("SELECT * FROM ingest_queue WHERE kb_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(kbId, Math.min(500, Number(limit)))
      : this.db.prepare("SELECT * FROM ingest_queue ORDER BY created_at DESC,rowid DESC LIMIT ?").all(Math.min(500, Number(limit)));
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }

  create(kbId, sourceId, kind, payload = {}) {
    const jobId = id("inq");
    this.db.prepare(`INSERT INTO ingest_queue
      (id,kb_id,source_id,kind,payload_json,status,attempt,error,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      jobId, kbId, sourceId ?? null, kind, JSON.stringify(payload), "pending", 0, null, now(),
    );
    return this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(jobId);
  }

  claimNext() {
    const row = this.db.prepare(`SELECT * FROM ingest_queue q
      WHERE q.status='pending'
        AND NOT EXISTS (SELECT 1 FROM ingest_queue r WHERE r.status='running' AND r.kb_id=q.kb_id)
      ORDER BY q.created_at,q.rowid LIMIT 1`).get();
    if (!row) return null;
    this.db.prepare("UPDATE ingest_queue SET status='running',started_at=? WHERE id=?").run(now(), row.id);
    return this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(row.id);
  }

  complete(jobId) {
    this.db.prepare("UPDATE ingest_queue SET status='done',error=NULL,completed_at=? WHERE id=?").run(now(), jobId);
  }

  /**
   * Record a failure. Returns the failed job when the retry budget is
   * exhausted, or null when the job was requeued as pending for retry.
   */
  fail(jobId, error) {
    const job = this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(jobId);
    if (!job) return null;
    const attempt = job.attempt + 1;
    const message = String(error?.message ?? error).slice(0, 2000);
    if (attempt >= 3) {
      this.db.prepare("UPDATE ingest_queue SET status='failed',attempt=?,error=?,completed_at=? WHERE id=?")
        .run(attempt, message, now(), jobId);
      return this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(jobId);
    }
    this.db.prepare("UPDATE ingest_queue SET status='pending',attempt=?,error=? WHERE id=?")
      .run(attempt, message, jobId);
    return null;
  }

  cancel(jobId) {
    const job = this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(jobId);
    if (!job) throw new HttpError(404, "Ingest job not found", "ingest_job_not_found");
    if (job.status === "running") throw new HttpError(409, "Cannot cancel a running ingest job", "ingest_job_running");
    if (job.status === "done" || job.status === "cancelled") throw new HttpError(409, "Ingest job already finished", "ingest_job_finished");
    this.db.prepare("UPDATE ingest_queue SET status='cancelled',completed_at=? WHERE id=?").run(now(), jobId);
    return this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(jobId);
  }

  retry(jobId) {
    const job = this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(jobId);
    if (!job) throw new HttpError(404, "Ingest job not found", "ingest_job_not_found");
    if (job.status !== "failed") throw new HttpError(409, "Only failed ingest jobs can be retried", "ingest_job_not_failed");
    this.db.prepare("UPDATE ingest_queue SET status='pending',attempt=0,error=NULL,completed_at=NULL WHERE id=?")
      .run(jobId);
    return this.db.prepare("SELECT * FROM ingest_queue WHERE id=?").get(jobId);
  }

  /** Crash recovery: requeue jobs that were running when the process died. */
  recoverRunning() {
    const result = this.db.prepare("UPDATE ingest_queue SET status='pending',error='Recovered after restart' WHERE status='running'").run();
    return result.changes;
  }
}
