import { HttpError } from "../core/http.js";
import { id, now, redact, tokenize } from "../core/utils.js";

export class AgentService {
  constructor(db, gateway, pythonAgent, semanticIndex = null, config = null) {
    this.db = db;
    this.gateway = gateway;
    this.pythonAgent = pythonAgent;
    this.semanticIndex = semanticIndex;
    this.config = config;
  }

  listSkills() {
    return this.db.prepare(`SELECT s.*,
      EXISTS(SELECT 1 FROM agent_skills a WHERE a.skill_id=s.id AND a.agent_id='knowledge-agent') AS attached
      FROM skills s ORDER BY value_score DESC,name`).all()
      .map((row) => ({ ...row, enabled: Boolean(row.enabled), attached: Boolean(row.attached) }));
  }

  createSkill(input) {
    if (!input.name || !input.description || !input.instructions) throw new HttpError(400, "name, description and instructions are required", "invalid_skill");
    const skillId = id("skl");
    const version = input.version ?? "1.0.0";
    const timestamp = now();
    // ADR-015 (C): structured retrieval strategy from SKILL.md frontmatter.
    const retrieval = input.retrieval && typeof input.retrieval === "object" && !Array.isArray(input.retrieval) ? input.retrieval : {};
    try {
      this.db.prepare(`INSERT INTO skills
        (id,name,description,instructions,version,scope,value_score,enabled,created_at,status,updated_at,source,retrieval_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(skillId, input.name, input.description, input.instructions, version, input.scope ?? "local", Number(input.value_score ?? 0.5), 1, timestamp, "active", timestamp, input.source ?? "manual", JSON.stringify(retrieval));
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) throw new HttpError(409, "Skill name already exists", "skill_exists");
      throw error;
    }
    this.db.prepare(`INSERT INTO skill_versions
      (id,skill_id,version,instructions,author,change_summary,created_at) VALUES (?,?,?,?,?,?,?)`).run(id("skv"), skillId, version, input.instructions, input.author ?? "local-user", "Initial version", timestamp);
    return this.db.prepare("SELECT * FROM skills WHERE id=?").get(skillId);
  }

  importSkill(input) {
    const filename = String(input.filename ?? "").trim();
    const author = String(input.author ?? "local-user");
    if (!/\.(?:md|json)$/i.test(filename) || !input.data_base64) {
      throw new HttpError(400, "A SKILL.md or skill.json file is required", "invalid_skill_import");
    }
    let bytes;
    try { bytes = Buffer.from(input.data_base64, "base64"); } catch { throw new HttpError(400, "data_base64 is invalid", "invalid_skill_import"); }
    if (!bytes.length || bytes.length > 256 * 1024) throw new HttpError(413, "Skill package must be between 1 byte and 256 KB", "skill_package_too_large");
    const importId = id("ski");
    this.db.prepare(`INSERT INTO skill_imports
      (id,filename,status,author,size_bytes,created_at) VALUES (?,?,?,?,?,?)`).run(importId, filename, "validating", author, bytes.length, now());
    try {
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new HttpError(400, "Skill package must be valid UTF-8", "invalid_skill_encoding"); }
      const manifest = filename.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseSkillMarkdown(text);
      validateSkillManifest(manifest);
      const existing = this.db.prepare("SELECT * FROM skills WHERE name=?").get(manifest.name);
      let skill;
      if (!existing) {
        skill = this.createSkill({ ...manifest, author, source: "import" });
      } else {
        const duplicate = this.db.prepare("SELECT id FROM skill_versions WHERE skill_id=? AND version=?").get(existing.id, manifest.version);
        if (duplicate) throw new HttpError(409, `Skill ${manifest.name} version ${manifest.version} already exists`, "skill_version_exists");
        skill = this.updateSkill(existing.id, { ...manifest, author, source: "import", change_summary: `Imported from ${filename}`, enabled: true, status: "active" });
      }
      this.db.prepare("UPDATE skill_imports SET skill_id=?,imported_version=?,status='imported' WHERE id=?")
        .run(skill.id, manifest.version, importId);
      return { import: this.db.prepare("SELECT * FROM skill_imports WHERE id=?").get(importId), skill };
    } catch (error) {
      this.db.prepare("UPDATE skill_imports SET status='failed',error=? WHERE id=?").run(error.message, importId);
      if (error instanceof SyntaxError) throw new HttpError(400, `skill.json is invalid: ${error.message}`, "invalid_skill_json");
      throw error;
    }
  }

  listSkillImports(limit = 100) {
    return this.db.prepare("SELECT * FROM skill_imports ORDER BY created_at DESC,rowid DESC LIMIT ?").all(Math.min(500, Number(limit)));
  }

  updateSkill(skillId, input) {
    const skill = this.db.prepare("SELECT * FROM skills WHERE id=?").get(skillId);
    if (!skill) throw new HttpError(404, "Skill not found", "skill_not_found");
    const version = input.version ?? bumpPatch(skill.version);
    const instructions = input.instructions ?? skill.instructions;
    const timestamp = now();
    this.db.prepare(`UPDATE skills SET name=?,description=?,instructions=?,version=?,scope=?,value_score=?,enabled=?,status=?,retrieval_json=?,updated_at=? WHERE id=?`).run(
      input.name ?? skill.name, input.description ?? skill.description, instructions, version, input.scope ?? skill.scope,
      Number(input.value_score ?? skill.value_score), input.enabled === undefined ? skill.enabled : input.enabled ? 1 : 0,
      input.status ?? skill.status,
      JSON.stringify(input.retrieval && typeof input.retrieval === "object" && !Array.isArray(input.retrieval) ? input.retrieval : JSON.parse(skill.retrieval_json || "{}")),
      timestamp, skillId,
    );
    if (version !== skill.version || instructions !== skill.instructions) this.db.prepare(`INSERT OR IGNORE INTO skill_versions
      (id,skill_id,version,instructions,author,change_summary,created_at) VALUES (?,?,?,?,?,?,?)`).run(id("skv"), skillId, version, instructions, input.author ?? "local-user", input.change_summary ?? "Skill updated", timestamp);
    return this.db.prepare("SELECT * FROM skills WHERE id=?").get(skillId);
  }

  skillVersions(skillId) {
    if (!this.db.prepare("SELECT id FROM skills WHERE id=?").get(skillId)) throw new HttpError(404, "Skill not found", "skill_not_found");
    return this.db.prepare("SELECT * FROM skill_versions WHERE skill_id=? ORDER BY created_at DESC,rowid DESC").all(skillId);
  }

  recommendSkills(description, limit = 5) {
    const query = new Set(tokenize(description));
    return this.listSkills().filter((skill) => skill.enabled && skill.status === "active").map((skill) => {
      const tokens = tokenize(`${skill.name} ${skill.description} ${skill.instructions}`);
      const overlap = tokens.filter((token) => query.has(token)).length;
      return { ...skill, recommendation_score: Number((overlap / Math.max(1, Math.sqrt(tokens.length * Math.max(1, query.size))) + skill.value_score * 0.2).toFixed(4)) };
    }).sort((left, right) => right.recommendation_score - left.recommendation_score).slice(0, Math.min(20, Number(limit)));
  }

  mergeSkills(input) {
    const sourceIds = [...new Set(input.source_ids ?? [])];
    if (sourceIds.length < 2) throw new HttpError(400, "At least two source_ids are required", "invalid_skill_merge");
    const sources = sourceIds.map((skillId) => this.db.prepare("SELECT * FROM skills WHERE id=?").get(skillId));
    if (sources.some((skill) => !skill)) throw new HttpError(404, "One or more source skills were not found", "skill_not_found");
    const merged = this.createSkill({
      name: input.name, description: input.description ?? sources.map((skill) => skill.description).join(" "),
      instructions: input.instructions ?? sources.map((skill) => skill.instructions).join("\n\n"),
      scope: input.scope ?? "shared", value_score: Math.max(...sources.map((skill) => skill.value_score)), source: "merge",
      author: input.author, version: "1.0.0",
    });
    for (const skill of sources) this.updateSkill(skill.id, { enabled: false, status: "merged", change_summary: `Merged into ${merged.id}` });
    return { merged, retired_source_ids: sourceIds };
  }

  listMemories({ session_id = null, agent_id = "knowledge-agent", status = "active" } = {}) {
    const clauses = ["agent_id=?"];
    const values = [agent_id];
    if (session_id) { clauses.push("session_id=?"); values.push(session_id); }
    if (status) { clauses.push("status=?"); values.push(status); }
    return this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY importance DESC,created_at DESC LIMIT 200`).all(...values);
  }

  createMemory(input) {
    if (!input.session_id || !String(input.content ?? "").trim()) throw new HttpError(400, "session_id and content are required", "invalid_memory");
    const memoryId = id("mem");
    this.db.prepare(`INSERT INTO memories
      (id,session_id,agent_id,content,source_run_id,created_at,kind,scope,importance,expires_at,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(memoryId, input.session_id, input.agent_id ?? "knowledge-agent", redact(input.content), input.source_run_id ?? null, now(), input.kind ?? "semantic", input.scope ?? "session", Math.max(0, Math.min(1, Number(input.importance ?? 0.5))), input.expires_at ?? null, "active");
    this.memoryEvent(memoryId, "created", input.reason ?? "explicit user memory");
    return this.db.prepare("SELECT * FROM memories WHERE id=?").get(memoryId);
  }

  forgetMemory(memoryId, reason = "explicit forget") {
    const memory = this.db.prepare("SELECT * FROM memories WHERE id=?").get(memoryId);
    if (!memory) throw new HttpError(404, "Memory not found", "memory_not_found");
    this.db.prepare("UPDATE memories SET status='forgotten' WHERE id=?").run(memoryId);
    this.memoryEvent(memoryId, "forgotten", reason);
    return { id: memoryId, forgotten: true };
  }

  supersedeMemory(memoryId, input) {
    const previous = this.db.prepare("SELECT * FROM memories WHERE id=?").get(memoryId);
    if (!previous) throw new HttpError(404, "Memory not found", "memory_not_found");
    const replacement = this.createMemory({ ...input, session_id: input.session_id ?? previous.session_id, agent_id: previous.agent_id, kind: input.kind ?? previous.kind, scope: input.scope ?? previous.scope });
    this.db.prepare("UPDATE memories SET status='superseded',superseded_by=? WHERE id=?").run(replacement.id, memoryId);
    this.memoryEvent(memoryId, "superseded", replacement.id);
    return { previous_id: memoryId, replacement };
  }

  memoryEvent(memoryId, event, detail = "") {
    this.db.prepare("INSERT INTO memory_events (id,memory_id,event,detail,created_at) VALUES (?,?,?,?,?)").run(id("mev"), memoryId, event, detail, now());
  }

  attachSkill(agentId, skillId, attached) {
    const skill = this.db.prepare("SELECT id FROM skills WHERE id=? AND enabled=1").get(skillId);
    if (!skill) throw new HttpError(404, "Skill not found", "skill_not_found");
    if (attached) {
      this.db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id,skill_id,attached_at) VALUES (?,?,?)")
        .run(agentId, skillId, now());
    } else {
      this.db.prepare("DELETE FROM agent_skills WHERE agent_id=? AND skill_id=?").run(agentId, skillId);
    }
    return { agent_id: agentId, skill_id: skillId, attached };
  }

  listRuns(limit = 20) {
    return this.db.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?").all(Math.min(100, Number(limit)))
      .map((row) => ({ ...row, sources: JSON.parse(row.sources_json), skill_ids: JSON.parse(row.skill_ids_json), memory_used: Boolean(row.memory_used) }));
  }

  status(model = "auto") {
    const plan = this.gateway.plan({ model, messages: [{ role: "user", content: "status" }] }, {});
    return {
      requested_model: model,
      provider_id: plan.selected.provider_id,
      provider_name: plan.selected.provider_name,
      model: plan.selected.model,
      provider_kind: plan.selected.kind,
      execution_mode: plan.selected.kind === "mock" ? "local_extractive" : "llm",
      agent_runtime: "python",
      routing_profile: plan.profile,
      reason: plan.reason,
    };
  }

  /** ADR-015 (C): merge retrieval parameters declared by activated skills.
   *  multihop/include_raw: any true wins; top_k: maximum; directories: union. */
  retrievalParamsFromSkills() {
    const rows = this.db.prepare(`SELECT s.retrieval_json FROM skills s JOIN agent_skills a ON a.skill_id=s.id
      WHERE a.agent_id='knowledge-agent' AND s.enabled=1`).all();
    const params = {};
    for (const row of rows) {
      let retrieval = {};
      try { retrieval = JSON.parse(row.retrieval_json || "{}"); } catch { /* ignore malformed */ }
      if (typeof retrieval.multihop === "boolean") params.multihop = params.multihop === true ? true : retrieval.multihop;
      if (Number.isFinite(Number(retrieval.top_k))) params.top_k = Math.max(Number(params.top_k ?? 0), Number(retrieval.top_k));
      if (typeof retrieval.include_raw === "boolean") params.include_raw = params.include_raw === true ? true : retrieval.include_raw;
      if (Array.isArray(retrieval.directories)) {
        params.directories = [...new Set([...(params.directories ?? []), ...retrieval.directories.map(String)])];
      }
    }
    return params;
  }

  async ask(input) {
    if (!input.kb_id || !String(input.question ?? "").trim()) {
      throw new HttpError(400, "kb_id and question are required", "invalid_agent_request");
    }
    // ADR-015 (C): activated skills inject retrieval parameters; explicit
    // caller parameters always win.
    const skillParams = this.retrievalParamsFromSkills();
    const mergedInput = { ...input };
    for (const [key, value] of Object.entries(skillParams)) {
      if (mergedInput[key] === undefined) mergedInput[key] = value;
    }
    const question = String(input.question).trim();
    const runId = id("run");
    const precomputedSources = this.semanticIndex?.enabled()
      ? await this.semanticIndex.search(input.kb_id, question, mergedInput)
      : undefined;
    let prepared = await this.pythonAgent.prepare({ ...mergedInput, question, ...(precomputedSources ? { precomputed_sources: precomputedSources } : {}) });
    let effectiveQuestion = question;
    // RAG phase 2 (Q9): zero-evidence first round -> ask a real LLM to rewrite
    // the question into a more searchable form and retry once. Skipped when no
    // real provider is routed (mock) or rewriting is disabled.
    if (prepared.sources.length === 0 && this.config.queryRewriteEnabled) {
      const rewritten = await this.rewriteQuestion(question, input.model ?? "auto");
      if (rewritten && rewritten !== question) {
        const recomputed = this.semanticIndex?.enabled()
          ? await this.semanticIndex.search(input.kb_id, rewritten, mergedInput)
          : undefined;
        const retried = await this.pythonAgent.prepare({
          ...mergedInput, question: rewritten,
          ...(recomputed ? { precomputed_sources: recomputed } : {}),
        });
        if (retried.sources.length > 0) {
          prepared = retried;
          effectiveQuestion = rewritten;
        }
      }
    }
    const sources = prepared.sources;
    const memoryEnabled = input.use_memory === true;
    const skills = prepared.skills;
    let answer;
    let model = input.model ?? "auto";
    let routing = null;

    if (sources.length === 0) {
      answer = prepared.fallback_answer;
    } else {
      const plan = this.gateway.plan({ model, messages: [{ role: "user", content: effectiveQuestion }] }, {});
      if (plan.selected.kind === "mock") {
        answer = prepared.fallback_answer;
        routing = { provider_id: plan.selected.provider_id, model: plan.selected.model, mode: "local_extractive" };
      } else {
        const completion = await this.gateway.complete({
          model,
          temperature: 0.2,
          messages: prepared.messages,
        }, { route: "/api/agents/knowledge/ask" });
        answer = completion.response.choices?.[0]?.message?.content ?? "No answer returned.";
        routing = { provider_id: completion.plan.selected.provider_id, model: completion.plan.selected.model, mode: "llm" };
      }
    }

    const sourceViews = sources;
    this.db.prepare(`INSERT INTO agent_runs
      (id,agent_id,session_id,question,answer,sources_json,memory_used,skill_ids_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      runId, "knowledge-agent", input.session_id ?? null, redact(question), answer,
      JSON.stringify(sourceViews), memoryEnabled ? 1 : 0, JSON.stringify(skills.map((skill) => skill.id)), now(),
    );
    if (memoryEnabled && input.session_id) {
      this.createMemory({ session_id: input.session_id, agent_id: "knowledge-agent", kind: "episodic", scope: "session", importance: Number(input.memory_importance ?? 0.5), source_run_id: runId, content: `Question: ${redact(question).slice(0, 240)}\nAnswer summary: ${redact(answer).slice(0, 420)}`, reason: "agent run with memory opt-in" });
    }
    for (const skill of skills) {
      this.db.prepare("UPDATE skills SET usage_count=usage_count+1,success_count=success_count+1 WHERE id=?").run(skill.id);
      this.db.prepare("INSERT INTO skill_events (id,skill_id,agent_id,event,score,run_id,created_at) VALUES (?,?,?,?,?,?,?)").run(id("sev"), skill.id, "knowledge-agent", "run_success", 1, runId, now());
    }
    return {
      run_id: runId,
      answer,
      sources: sourceViews,
      routing,
      memory: { enabled: memoryEnabled, recalled: prepared.memory.recalled, stored: memoryEnabled && Boolean(input.session_id) },
      skills,
      runtime: "python",
      rewritten_question: effectiveQuestion !== question ? effectiveQuestion : null,
      retrieval_mode: this.semanticIndex?.enabled()
        ? (this.semanticIndex.backend() === "qdrant" ? "semantic_qdrant" : "hybrid")
        : (input.retrieval_mode === "chunk" ? "chunk" : "page"),
    };
  }

  /** RAG phase 2 (Q9): rewrite a zero-hit question into a more searchable
   *  form using a real (non-mock) model. Returns null when no real provider
   *  is routed or the model returns nothing usable. */
  async rewriteQuestion(question, model = "auto") {
    const plan = this.gateway.plan({ model, messages: [{ role: "user", content: question }] }, {});
    if (plan.selected.kind === "mock") return null;
    try {
      const completion = await this.gateway.complete({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: "你是检索查询改写器。把用户问题改写成更适合 Wiki 知识库检索的简洁查询：保留关键实体与术语，去掉口语与冗余，不改变原意。只输出改写后的查询本身，不要任何解释。" },
          { role: "user", content: question },
        ],
      }, { route: "/api/agents/knowledge/ask" });
      const content = completion.response.choices?.[0]?.message?.content ?? "";
      const rewritten = String(content).trim().replace(/^["']|["']$/g, "").slice(0, 200);
      return rewritten || null;
    } catch {
      return null;
    }
  }
}

function bumpPatch(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : `${version}.1`;
}

function parseSkillMarkdown(text) {
  const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]+)$/);
  if (!match) throw new HttpError(400, "SKILL.md requires YAML frontmatter and an instructions body", "invalid_skill_markdown");
  const metadata = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const separator = rawLine.indexOf(":");
    if (separator < 1) continue;
    const key = rawLine.slice(0, separator).trim();
    let value = rawLine.slice(separator + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    // ADR-015 (C): structured values (e.g. retrieval: {"multihop": true}).
    if (value.startsWith("{") || value.startsWith("[")) {
      try { metadata[key] = JSON.parse(value); } catch { metadata[key] = value; }
    } else {
      metadata[key] = value;
    }
  }
  return { ...metadata, instructions: match[2].trim() };
}

function validateSkillManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new HttpError(400, "Skill manifest must be an object", "invalid_skill_manifest");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(manifest.name ?? ""))) throw new HttpError(400, "Skill name must use 2-64 lowercase letters, digits or hyphens", "invalid_skill_name");
  if (!String(manifest.description ?? "").trim() || !String(manifest.instructions ?? "").trim()) throw new HttpError(400, "Skill description and instructions are required", "invalid_skill_manifest");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version ?? ""))) throw new HttpError(400, "Skill version must follow semantic versioning", "invalid_skill_version");
  if (manifest.scope && !["local", "team", "organization", "shared"].includes(manifest.scope)) throw new HttpError(400, "Skill scope is invalid", "invalid_skill_scope");
}
