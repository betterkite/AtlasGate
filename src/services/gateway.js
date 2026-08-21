import crypto from "node:crypto";
import { HttpError } from "../core/http.js";
import { clamp, estimateTokens, featureVector, id, now, parseJson, redact, sha256, stableHash } from "../core/utils.js";
import { anthropicToChat, fromOpenAIChat, responseText, toAnthropicRequest, toOpenAIRequest } from "./protocol.js";

const PROFILE_WEIGHTS = {
  quality: { quality: 0.6, cost: 0.1, latency: 0.15, reliability: 0.15 },
  balanced: { quality: 0.35, cost: 0.3, latency: 0.2, reliability: 0.15 },
  economy: { quality: 0.15, cost: 0.7, latency: 0.05, reliability: 0.1 },
  latency: { quality: 0.2, cost: 0.1, latency: 0.6, reliability: 0.1 },
};

function providerView(row) {
  return {
    id: row.id, name: row.name, kind: row.kind, base_url: row.base_url,
    has_api_key: Boolean(row.api_key), enabled: Boolean(row.enabled), priority: row.priority,
    weight: row.weight, models: parseJson(row.models_json, []), supports_vision: Boolean(row.supports_vision),
    quality: row.quality, input_cost: row.input_cost, output_cost: row.output_cost,
    latency_hint_ms: row.latency_hint_ms, reliability: row.reliability, health_status: row.health_status,
    credential_count: Number(row.credential_count ?? 0),
    balance: {
      endpoint_configured: Boolean(balanceEndpointFor(row)),
      amount: row.balance_amount,
      currency: row.balance_currency,
      status: row.balance_status ?? "unconfigured",
      checked_at: row.balance_checked_at,
      error: row.balance_error,
      details: parseJson(row.balance_details_json, {}),
    },
  };
}

function credentialView(row) {
  return {
    id: row.id, provider_id: row.provider_id, name: row.name, has_api_key: Boolean(row.api_key),
    key_prefix: row.api_key ? `${row.api_key.slice(0, 6)}...` : "none", weight: row.weight,
    quota_tokens: row.quota_tokens, used_tokens: row.used_tokens, enabled: Boolean(row.enabled),
    error_count: row.error_count, cooldown_until: row.cooldown_until, last_used_at: row.last_used_at,
  };
}

function mappingView(row) {
  return { ...row, enabled: Boolean(row.enabled), capabilities: parseJson(row.capabilities_json, ["text"]) };
}

function promptText(messages) {
  return (messages ?? []).map((message) => {
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content.map((part) => part.text ?? part.input_text ?? "").join(" ");
  }).join("\n");
}

function hasImage(messages) {
  return (messages ?? []).some((message) => Array.isArray(message.content)
    && message.content.some((part) => ["image_url", "input_image", "image"].includes(part?.type)));
}

function riskLevel(text) {
  if (/-----BEGIN [^-]+PRIVATE KEY-----|\bsk-[a-zA-Z0-9_-]{16,}/i.test(text)) return "critical";
  if (/(?:\.env|\.ssh|credentials)|(?:curl|wget)\s+https?:\/\//i.test(text)) return "medium";
  return "clean";
}

function endpoint(baseUrl, suffix) {
  const base = baseUrl.replace(/\/$/, "");
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

// DeepSeek exposes account balance at /user/balance with the same Bearer key.
function balanceEndpointFor(row) {
  if (String(row.balance_endpoint ?? "").trim()) return row.balance_endpoint.trim();
  if (/api\.deepseek\.com/i.test(String(row.base_url ?? ""))) return "https://api.deepseek.com/user/balance";
  return null;
}

export class GatewayService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.rateWindows = new Map();
  }

  authenticate(req, requiredScope = "gateway:invoke") {
    const authorization = req.headers.authorization ?? "";
    const token = req.headers["x-api-key"] ?? authorization.replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(401, "Missing API key", "missing_api_key");
    const key = this.db.prepare("SELECT * FROM api_keys WHERE key_hash=?").get(sha256(token));
    if (!key || !key.enabled) throw new HttpError(401, "Invalid API key", "invalid_api_key");
    if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) throw new HttpError(401, "API key expired", "api_key_expired");
    const scopes = parseJson(key.scopes_json, ["gateway:invoke"]);
    if (!scopes.includes("*") && !scopes.includes(requiredScope)) throw new HttpError(403, `API key lacks scope ${requiredScope}`, "insufficient_scope");
    if (key.used_tokens >= key.quota_tokens) throw new HttpError(429, "Token quota exhausted", "quota_exhausted");
    if (key.monthly_budget_cents > 0 && key.spent_cents >= key.monthly_budget_cents) throw new HttpError(429, "Monthly budget exhausted", "budget_exhausted");
    if (key.user_id) {
      const user = this.db.prepare("SELECT enabled FROM users WHERE id=?").get(key.user_id);
      if (!user?.enabled) throw new HttpError(403, "API key user is disabled", "user_disabled");
    }
    if (key.team_id) {
      const team = this.db.prepare(`SELECT t.enabled,t.monthly_budget_cents,
        COALESCE((SELECT SUM(spent_cents) FROM api_keys WHERE team_id=t.id),0) AS spent_cents,
        o.enabled AS organization_enabled,o.monthly_budget_cents AS organization_budget,
        COALESCE((SELECT SUM(k.spent_cents) FROM api_keys k JOIN teams ot ON ot.id=k.team_id WHERE ot.organization_id=t.organization_id),0) AS organization_spent
        FROM teams t LEFT JOIN organizations o ON o.id=t.organization_id WHERE t.id=?`).get(key.team_id);
      if (!team?.enabled || team.organization_enabled === 0) throw new HttpError(403, "API key team or organization is disabled", "tenant_disabled");
      if (team.monthly_budget_cents > 0 && team.spent_cents >= team.monthly_budget_cents) throw new HttpError(429, "Team budget exhausted", "team_budget_exhausted");
      if (team.organization_budget > 0 && team.organization_spent >= team.organization_budget) throw new HttpError(429, "Organization budget exhausted", "organization_budget_exhausted");
    }
    return key;
  }

  authorizeRequest(key, model, estimatedTokens = 0) {
    if (!key) return;
    const allowed = parseJson(key.allowed_models_json, []);
    if (allowed.length && model !== "auto" && !allowed.includes(model)) throw new HttpError(403, `Model ${model} is not allowed for this key`, "model_not_allowed");
    const minute = Math.floor(Date.now() / 60_000);
    const current = this.rateWindows.get(key.id);
    const window = current?.minute === minute ? current : { minute, requests: 0, tokens: 0 };
    if (window.requests + 1 > key.requests_per_minute) throw new HttpError(429, "Request rate limit exceeded", "rpm_exceeded");
    if (window.tokens + estimatedTokens > key.tokens_per_minute) throw new HttpError(429, "Token rate limit exceeded", "tpm_exceeded");
    window.requests += 1;
    window.tokens += estimatedTokens;
    this.rateWindows.set(key.id, window);
  }

  listProviders() {
    return this.db.prepare(`SELECT p.*,(SELECT COUNT(*) FROM provider_credentials c WHERE c.provider_id=p.id) AS credential_count
      FROM providers p ORDER BY p.priority,p.name`).all().map(providerView);
  }

  createProvider(input) {
    if (!input.name || !input.kind || !Array.isArray(input.models) || input.models.length === 0) throw new HttpError(400, "name, kind and at least one model are required", "invalid_provider");
    if (input.kind !== "mock" && !input.base_url) throw new HttpError(400, "base_url is required", "invalid_provider");
    if (!["mock", "openai", "anthropic"].includes(input.kind)) throw new HttpError(400, "kind must be mock, openai or anthropic", "invalid_provider");
    const providerId = id("prv");
    const timestamp = now();
    this.db.prepare(`INSERT INTO providers
      (id,name,kind,base_url,api_key,enabled,priority,weight,models_json,supports_vision,quality,input_cost,output_cost,latency_hint_ms,reliability,health_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      providerId, input.name, input.kind, input.base_url ?? "", "", input.enabled === false ? 0 : 1,
      Number(input.priority ?? 10), Number(input.weight ?? 1), JSON.stringify(input.models), input.supports_vision ? 1 : 0,
      clamp(Number(input.quality ?? 0.7)), Number(input.input_cost ?? 0), Number(input.output_cost ?? 0),
      Number(input.latency_hint_ms ?? 1000), clamp(Number(input.reliability ?? 0.95)), "unknown", timestamp, timestamp,
    );
    const balanceEndpoint = input.balance_endpoint ?? defaultBalanceEndpoint(input.base_url ?? "");
    if (balanceEndpoint) this.db.prepare("UPDATE providers SET balance_endpoint=? WHERE id=?").run(balanceEndpoint, providerId);
    for (const model of input.models) this.createMapping({ alias: model, provider_id: providerId, upstream_model: model, capabilities: input.supports_vision ? ["text", "vision"] : ["text"] });
    if (input.api_key) this.createCredential(providerId, { name: "Primary", api_key: input.api_key });
    return this.listProviders().find((provider) => provider.id === providerId);
  }

  setProviderEnabled(providerId, enabled) {
    const result = this.db.prepare("UPDATE providers SET enabled=?,updated_at=? WHERE id=?").run(enabled ? 1 : 0, now(), providerId);
    if (!result.changes) throw new HttpError(404, "Provider not found", "provider_not_found");
    return this.listProviders().find((provider) => provider.id === providerId);
  }

  deleteProvider(providerId) {
    const provider = this.db.prepare("SELECT id,name,kind FROM providers WHERE id=?").get(providerId);
    if (!provider) throw new HttpError(404, "Provider not found", "provider_not_found");
    if (provider.kind === "mock" && provider.id === "prv_local_demo") {
      throw new HttpError(409, "The built-in fallback provider cannot be deleted", "protected_provider");
    }
    const activeRuns = this.db.prepare(`SELECT COUNT(*) AS count FROM provider_attempts
      WHERE provider_id=? AND created_at>=?`).get(providerId, new Date(Date.now() - 30_000).toISOString()).count;
    if (activeRuns > 0) throw new HttpError(409, "Provider has very recent attempts; disable it and retry after 30 seconds", "provider_busy");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM providers WHERE id=?").run(providerId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id: provider.id, name: provider.name, deleted: true, audit_history_retained: true };
  }

  listCredentials(providerId) {
    this.requireProvider(providerId);
    return this.db.prepare("SELECT * FROM provider_credentials WHERE provider_id=? ORDER BY created_at").all(providerId).map(credentialView);
  }

  createCredential(providerId, input) {
    this.requireProvider(providerId);
    if (!input.name || !input.api_key) throw new HttpError(400, "name and api_key are required", "invalid_credential");
    const credentialId = id("cred");
    const timestamp = now();
    this.db.prepare(`INSERT INTO provider_credentials
      (id,provider_id,name,api_key,weight,quota_tokens,used_tokens,enabled,error_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(credentialId, providerId, input.name, input.api_key, Number(input.weight ?? 1), Number(input.quota_tokens ?? 0), 0, input.enabled === false ? 0 : 1, 0, timestamp, timestamp);
    return credentialView(this.db.prepare("SELECT * FROM provider_credentials WHERE id=?").get(credentialId));
  }

  setCredentialEnabled(providerId, credentialId, enabled) {
    const result = this.db.prepare("UPDATE provider_credentials SET enabled=?,updated_at=? WHERE id=? AND provider_id=?").run(enabled ? 1 : 0, now(), credentialId, providerId);
    if (!result.changes) throw new HttpError(404, "Credential not found", "credential_not_found");
    return credentialView(this.db.prepare("SELECT * FROM provider_credentials WHERE id=?").get(credentialId));
  }

  listMappings() {
    return this.db.prepare("SELECT * FROM model_mappings ORDER BY alias,priority,provider_id").all().map(mappingView);
  }

  createMapping(input) {
    if (!input.alias || !input.provider_id || !input.upstream_model) throw new HttpError(400, "alias, provider_id and upstream_model are required", "invalid_mapping");
    this.requireProvider(input.provider_id);
    const mappingId = id("map");
    const timestamp = now();
    try {
      this.db.prepare(`INSERT INTO model_mappings
        (id,alias,provider_id,upstream_model,priority,enabled,capabilities_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(mappingId, input.alias, input.provider_id, input.upstream_model, Number(input.priority ?? 10), input.enabled === false ? 0 : 1, JSON.stringify(input.capabilities ?? ["text"]), timestamp, timestamp);
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) return mappingView(this.db.prepare("SELECT * FROM model_mappings WHERE alias=? AND provider_id=? AND upstream_model=?").get(input.alias, input.provider_id, input.upstream_model));
      throw error;
    }
    return mappingView(this.db.prepare("SELECT * FROM model_mappings WHERE id=?").get(mappingId));
  }

  setMappingEnabled(mappingId, enabled) {
    return this.updateMapping(mappingId, { enabled });
  }

  updateMapping(mappingId, input) {
    const mapping = this.db.prepare("SELECT * FROM model_mappings WHERE id=?").get(mappingId);
    if (!mapping) throw new HttpError(404, "Model mapping not found", "mapping_not_found");
    const alias = String(input.alias ?? mapping.alias).trim();
    const upstreamModel = String(input.upstream_model ?? mapping.upstream_model).trim();
    const providerId = input.provider_id ?? mapping.provider_id;
    const capabilities = input.capabilities ?? parseJson(mapping.capabilities_json, ["text"]);
    if (!alias || !upstreamModel || !Array.isArray(capabilities) || capabilities.some((item) => !["text", "vision", "tools", "embeddings"].includes(item))) {
      throw new HttpError(400, "alias, upstream_model and valid capabilities are required", "invalid_mapping");
    }
    this.requireProvider(providerId);
    try {
      this.db.prepare(`UPDATE model_mappings SET alias=?,provider_id=?,upstream_model=?,priority=?,enabled=?,capabilities_json=?,updated_at=? WHERE id=?`).run(
        alias, providerId, upstreamModel, Number(input.priority ?? mapping.priority),
        input.enabled === undefined ? mapping.enabled : input.enabled ? 1 : 0,
        JSON.stringify(capabilities), now(), mappingId,
      );
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) throw new HttpError(409, "This provider route already exists", "mapping_exists");
      throw error;
    }
    return mappingView(this.db.prepare("SELECT * FROM model_mappings WHERE id=?").get(mappingId));
  }

  deleteMapping(mappingId) {
    const mapping = this.db.prepare("SELECT id,alias,provider_id,upstream_model FROM model_mappings WHERE id=?").get(mappingId);
    if (!mapping) throw new HttpError(404, "Model mapping not found", "mapping_not_found");
    this.db.prepare("DELETE FROM model_mappings WHERE id=?").run(mappingId);
    return { ...mapping, deleted: true };
  }

  listModels() {
    const data = [];
    const aliases = new Set();
    for (const mapping of this.listMappings().filter((item) => item.enabled)) {
      if (!aliases.has(mapping.alias)) data.push({ id: mapping.alias, object: "model", owned_by: "atlasgate" });
      aliases.add(mapping.alias);
      data.push({ id: `${mapping.provider_id}:${mapping.upstream_model}`, object: "model", owned_by: mapping.provider_id });
    }
    data.unshift({ id: "auto", object: "model", owned_by: "atlasgate" });
    return { object: "list", data };
  }

  listKeys() {
    return this.db.prepare(`SELECT id,name,key_prefix,team_id,user_id,scopes_json,allowed_models_json,quota_tokens,used_tokens,
      requests_per_minute,tokens_per_minute,monthly_budget_cents,spent_cents,enabled,created_at,expires_at FROM api_keys ORDER BY created_at DESC`).all().map((row) => ({
      ...row, enabled: Boolean(row.enabled), scopes: parseJson(row.scopes_json, []), allowed_models: parseJson(row.allowed_models_json, []),
    }));
  }

  createKey(input) {
    if (!input.name) throw new HttpError(400, "Key name is required", "invalid_api_key");
    const expiresAt = input.expires_at ? new Date(input.expires_at).toISOString() : null;
    if (input.expires_at && (!expiresAt || Date.parse(expiresAt) <= Date.now())) throw new HttpError(400, "expires_at must be a future date", "invalid_api_key_expiry");
    const scopes = Array.isArray(input.scopes) ? input.scopes.map(String).map((item) => item.trim()).filter(Boolean) : ["gateway:invoke"];
    if (!scopes.length) throw new HttpError(400, "At least one scope is required", "invalid_api_key_scope");
    const allowedModels = Array.isArray(input.allowed_models) ? input.allowed_models.map(String).map((item) => item.trim()).filter(Boolean) : [];
    const quotaTokens = Math.max(0, Number(input.quota_tokens ?? 1_000_000));
    const requestsPerMinute = Math.max(1, Number(input.requests_per_minute ?? 60));
    const tokensPerMinute = Math.max(1, Number(input.tokens_per_minute ?? 100_000));
    const monthlyBudgetCents = Math.max(0, Number(input.monthly_budget_cents ?? 0));
    const raw = `ag_${crypto.randomUUID().replaceAll("-", "")}`;
    const keyId = id("key");
    this.db.prepare(`INSERT INTO api_keys
      (id,name,key_hash,key_prefix,quota_tokens,used_tokens,enabled,created_at,expires_at,team_id,user_id,scopes_json,allowed_models_json,requests_per_minute,tokens_per_minute,monthly_budget_cents,spent_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(keyId, input.name, sha256(raw), raw.slice(0, 10), quotaTokens, 0, 1, now(), expiresAt, input.team_id ?? null, input.user_id ?? null, JSON.stringify(scopes), JSON.stringify(allowedModels), requestsPerMinute, tokensPerMinute, monthlyBudgetCents, 0);
    return { id: keyId, key: raw, name: input.name, expires_at: expiresAt, scopes, allowed_models: allowedModels, quota_tokens: quotaTokens, requests_per_minute: requestsPerMinute, tokens_per_minute: tokensPerMinute, monthly_budget_cents: monthlyBudgetCents };
  }

  setKeyEnabled(keyId, enabled) {
    const key = this.db.prepare("SELECT id,name,enabled FROM api_keys WHERE id=?").get(keyId);
    if (!key) throw new HttpError(404, "API key not found", "api_key_not_found");
    this.db.prepare("UPDATE api_keys SET enabled=? WHERE id=?").run(enabled ? 1 : 0, keyId);
    if (!enabled) this.rateWindows.delete(keyId);
    return this.listKeys().find((item) => item.id === keyId);
  }

  deleteKey(keyId) {
    const key = this.db.prepare("SELECT id,name,key_prefix,enabled FROM api_keys WHERE id=?").get(keyId);
    if (!key) throw new HttpError(404, "API key not found", "api_key_not_found");
    const retainedUsageLogs = this.db.prepare("SELECT COUNT(*) AS count FROM usage_logs WHERE api_key_id=?").get(keyId).count;
    this.db.prepare("DELETE FROM api_keys WHERE id=?").run(keyId);
    this.rateWindows.delete(keyId);
    return {
      id: key.id,
      name: key.name,
      key_prefix: key.key_prefix,
      deleted: true,
      retained_usage_logs: retainedUsageLogs,
    };
  }

  plan(body, headers = {}) {
    const request = body.messages && body.protocol === undefined ? fromOpenAIChat(body) : body;
    const requested = request.model ?? "auto";
    const profile = headers["x-atlas-routing-profile"] ?? body.routing_profile ?? "balanced";
    const weights = PROFILE_WEIGHTS[profile];
    if (!weights) throw new HttpError(400, `Unknown routing profile: ${profile}`, "invalid_routing_profile");
    const needsVision = hasImage(request.messages);
    const providers = this.db.prepare("SELECT * FROM providers WHERE enabled=1 ORDER BY priority,name").all();
    const mappings = this.db.prepare("SELECT * FROM model_mappings WHERE enabled=1 ORDER BY priority").all();
    const [explicitProvider, explicitModel] = requested.includes(":") ? requested.split(/:(.*)/s, 2) : [null, null];
    const candidates = [];
    for (const row of providers) {
      if (explicitProvider && row.id !== explicitProvider) continue;
      if (needsVision && !row.supports_vision) continue;
      const providerMappings = mappings.filter((mapping) => mapping.provider_id === row.id);
      const models = parseJson(row.models_json, []);
      let routes = [];
      if (explicitModel) routes = [{ upstream_model: explicitModel, alias: requested, priority: 0, capabilities_json: "[]" }];
      else if (requested === "auto") routes = providerMappings.length ? providerMappings : models.map((model) => ({ upstream_model: model, alias: model, priority: 10, capabilities_json: "[]" }));
      else routes = providerMappings.filter((mapping) => mapping.alias === requested || mapping.upstream_model === requested);
      if (!routes.length && models.includes(requested)) routes = [{ upstream_model: requested, alias: requested, priority: 10, capabilities_json: "[]" }];
      for (const modelRoute of routes) {
        const capabilities = parseJson(modelRoute.capabilities_json, []);
        if (needsVision && capabilities.length && !capabilities.includes("vision")) continue;
        const cost = 1 / (1 + Math.max(0, row.input_cost + row.output_cost));
        const latency = 1 / (1 + Math.max(1, row.latency_hint_ms) / 1000);
        const affinity = (stableHash(`${headers["x-atlas-session-id"] ?? ""}:${row.id}:${modelRoute.upstream_model}`) - 0.5) * 0.01;
        const score = weights.quality * row.quality + weights.cost * cost + weights.latency * latency + weights.reliability * row.reliability + affinity - Number(modelRoute.priority ?? 10) / 10000 + Number(row.weight ?? 1) / 10000;
        candidates.push({
          provider_id: row.id, provider_name: row.name, model: modelRoute.upstream_model, alias: modelRoute.alias,
          kind: row.kind, base_url: row.base_url, legacy_api_key: row.api_key, input_cost: row.input_cost,
          output_cost: row.output_cost, score: Number(score.toFixed(5)),
          signals: { quality: row.quality, cost: Number(cost.toFixed(3)), latency: Number(latency.toFixed(3)), reliability: row.reliability },
        });
      }
    }
    let routed = requested === "auto" && candidates.some((candidate) => candidate.kind !== "mock") ? candidates.filter((candidate) => candidate.kind !== "mock") : candidates;
    if (needsVision && routed.some((candidate) => /vision|multimodal|\bvl\b/i.test(candidate.model))) {
      routed = routed.filter((candidate) => /vision|multimodal|\bvl\b/i.test(candidate.model));
    }
    routed.sort((left, right) => right.score - left.score);
    if (!routed.length) throw new HttpError(503, "No provider satisfies model and capability requirements", "no_route", { requested, needs_vision: needsVision });
    return { requested_model: requested, profile, needs_vision: needsVision, selected: routed[0], candidates: routed, reason: explicitProvider ? "explicit_provider" : requested !== "auto" ? "model_mapping" : needsVision ? "capability_then_score" : "policy_score" };
  }

  simulate(body, headers = {}) {
    const request = body.messages && body.protocol === undefined ? fromOpenAIChat(body) : body;
    const requested = request.model ?? "auto";
    const needsVision = hasImage(request.messages);
    const profile = headers["x-atlas-routing-profile"] ?? body.routing_profile ?? "balanced";
    let plan = null;
    try { plan = this.plan(request, { ...headers, "x-atlas-routing-profile": profile }); }
    catch (error) { if (error.code !== "no_route") throw error; }
    const providers = this.db.prepare("SELECT * FROM providers ORDER BY priority,name").all();
    const mappings = this.db.prepare("SELECT * FROM model_mappings ORDER BY priority,rowid").all();
    const selectedKeys = new Set((plan?.candidates ?? []).map((candidate) => `${candidate.provider_id}:${candidate.model}:${candidate.alias}`));
    const [explicitProvider, explicitModel] = requested.includes(":") ? requested.split(/:(.*)/s, 2) : [null, null];
    const excluded = [];
    for (const provider of providers) {
      if (!provider.enabled) {
        excluded.push({ provider_id: provider.id, provider_name: provider.name, model: null, reason: "provider_disabled" });
        continue;
      }
      if (explicitProvider && provider.id !== explicitProvider) {
        excluded.push({ provider_id: provider.id, provider_name: provider.name, model: null, reason: "explicit_provider_mismatch" });
        continue;
      }
      if (needsVision && !provider.supports_vision) {
        excluded.push({ provider_id: provider.id, provider_name: provider.name, model: null, reason: "provider_lacks_vision" });
        continue;
      }
      const providerMappings = mappings.filter((mapping) => mapping.provider_id === provider.id);
      const matching = explicitModel
        ? [{ alias: requested, upstream_model: explicitModel, enabled: 1, capabilities_json: "[]" }]
        : requested === "auto"
          ? providerMappings
          : providerMappings.filter((mapping) => mapping.alias === requested || mapping.upstream_model === requested);
      if (!matching.length) {
        excluded.push({ provider_id: provider.id, provider_name: provider.name, model: requested, reason: "model_not_mapped" });
        continue;
      }
      for (const mapping of matching) {
        const key = `${provider.id}:${mapping.upstream_model}:${mapping.alias}`;
        if (selectedKeys.has(key)) continue;
        let reason = "lower_policy_priority";
        if (!mapping.enabled) reason = "mapping_disabled";
        else if (needsVision && !parseJson(mapping.capabilities_json, []).includes("vision")) reason = "mapping_lacks_vision";
        else if (requested === "auto" && provider.kind === "mock" && (plan?.candidates ?? []).some((candidate) => candidate.kind !== "mock")) reason = "mock_fallback_suppressed";
        else if (needsVision && (plan?.candidates ?? []).some((candidate) => /vision|multimodal|\bvl\b/i.test(candidate.model)) && !/vision|multimodal|\bvl\b/i.test(mapping.upstream_model)) reason = "non_vision_model_suppressed";
        excluded.push({ provider_id: provider.id, provider_name: provider.name, model: mapping.upstream_model, alias: mapping.alias, reason });
      }
    }
    return {
      status: plan ? "routable" : "no_route",
      requested_model: requested,
      profile,
      needs_vision: needsVision,
      selected: plan?.selected ?? null,
      candidates: plan?.candidates ?? [],
      excluded,
      reason: plan?.reason ?? "no_eligible_route",
    };
  }

  async complete(body, options = {}) { return this.completeRequest(fromOpenAIChat(body), options); }

  async completeRequest(request, { headers = {}, apiKey = null, route = "/v1/chat/completions" } = {}) {
    if (!Array.isArray(request.messages) || !request.messages.length) throw new HttpError(400, "messages must be a non-empty array", "invalid_messages");
    const requestId = id("req");
    const decisionId = id("rtd");
    const started = Date.now();
    const text = promptText(request.messages);
    const inputTokens = estimateTokens(text);
    const risk = riskLevel(text);
    this.authorizeRequest(apiKey, request.model, inputTokens);
    if (risk === "critical" && headers["x-atlas-risk-mode"] === "block") {
      this.logUsage({ requestId, apiKey, providerId: null, model: request.model, route, status: 403, inputTokens, outputTokens: 0, started, risk, text, error: "Blocked by risk policy" });
      throw new HttpError(403, "Request blocked by risk policy", "risk_blocked");
    }
    const plan = this.plan(request, headers);
    this.db.prepare(`INSERT INTO routing_decisions
      (id,request_id,requested_model,selected_provider,selected_model,profile,candidates_json,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(decisionId, requestId, plan.requested_model, plan.selected.provider_id, plan.selected.model, plan.profile, JSON.stringify(plan.candidates.map(publicCandidate)), plan.reason, now());
    let lastError = null;
    const maxAttempts = Math.min(plan.candidates.length, Number(headers["x-atlas-max-attempts"] ?? 4));
    for (let index = 0; index < maxAttempts; index += 1) {
      const selected = plan.candidates[index];
      const credential = this.pickCredential(selected.provider_id, requestId, selected.legacy_api_key);
      const attemptStarted = Date.now();
      try {
        const response = selected.kind === "mock" ? this.mockCompletion(request, selected.model, requestId) : await this.forwardCompletion(request, selected, credential, requestId);
        this.recordAttempt(requestId, index + 1, selected, credential, 200, Date.now() - attemptStarted, false, null);
        this.markCredential(credential, true, response.usage?.total_tokens ?? 0);
        const outputTokens = response.usage?.completion_tokens ?? estimateTokens(responseText(response));
        this.logUsage({ requestId, apiKey, providerId: selected.provider_id, model: selected.model, route, status: 200, inputTokens, outputTokens, started, risk, text, selected });
        return { response, headers: { "x-atlas-request-id": requestId, "x-atlas-routing-decision-id": decisionId, "x-atlas-provider": selected.provider_id, "x-atlas-attempts": String(index + 1) }, plan: { ...plan, selected } };
      } catch (error) {
        lastError = error;
        const status = error.status ?? 502;
        const retryable = status === 408 || status === 429 || status >= 500;
        this.recordAttempt(requestId, index + 1, selected, credential, status, Date.now() - attemptStarted, retryable, error.message);
        this.markCredential(credential, false, 0, retryable);
        if (!retryable) break;
      }
    }
    this.logUsage({ requestId, apiKey, providerId: plan.selected.provider_id, model: plan.selected.model, route, status: lastError?.status ?? 502, inputTokens, outputTokens: 0, started, risk, text, error: lastError?.message ?? "All routes failed" });
    throw lastError ?? new HttpError(502, "All upstream routes failed", "all_routes_failed");
  }

  mockCompletion(request, model, requestId) {
    const latest = [...request.messages].reverse().find((message) => message.role === "user");
    const source = typeof latest?.content === "string" ? latest.content : "Multimodal request accepted.";
    const content = `AtlasGate local route is healthy. Request understood: ${source.slice(0, 180)}`;
    const promptTokens = estimateTokens(request.messages);
    const completionTokens = estimateTokens(content);
    return { id: `chatcmpl-${requestId}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } };
  }

  async forwardCompletion(request, selected, credential, requestId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const isAnthropic = selected.kind === "anthropic";
    const url = endpoint(selected.base_url, isAnthropic ? "/messages" : "/chat/completions");
    const apiKey = credential?.api_key ?? selected.legacy_api_key;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId, ...(apiKey ? (isAnthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` }) : {}) },
        body: JSON.stringify(isAnthropic ? toAnthropicRequest(request, selected.model) : toOpenAIRequest(request, selected.model)),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, payload.error?.message ?? `Upstream returned ${response.status}`, response.status === 429 ? "upstream_rate_limited" : "upstream_error", { upstream_status: response.status });
      return isAnthropic ? anthropicToChat(payload, selected.model, requestId) : payload;
    } catch (error) {
      if (error.name === "AbortError") throw new HttpError(504, "Upstream timed out", "upstream_timeout");
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `Upstream request failed: ${error.message}`, "upstream_unavailable");
    } finally { clearTimeout(timeout); }
  }

  async embeddings(body, { apiKey = null, headers = {} } = {}) {
    if (!body.input || !body.model) throw new HttpError(400, "model and input are required", "invalid_embeddings");
    const input = Array.isArray(body.input) ? body.input : [body.input];
    this.authorizeRequest(apiKey, body.model, estimateTokens(input));
    const plan = this.plan({ model: body.model, messages: [{ role: "user", content: input.join("\n") }] }, headers);
    const requestId = id("req");
    const selected = plan.selected;
    if (selected.kind === "mock") {
      const data = input.map((text, index) => ({ object: "embedding", index, embedding: featureVector(String(text), Number(body.dimensions ?? 96)) }));
      return { response: { object: "list", data, model: selected.model, usage: { prompt_tokens: estimateTokens(input), total_tokens: estimateTokens(input) } }, headers: { "x-atlas-request-id": requestId, "x-atlas-provider": selected.provider_id } };
    }
    if (selected.kind === "anthropic") throw new HttpError(503, "Selected provider does not support embeddings", "capability_not_supported");
    const credential = this.pickCredential(selected.provider_id, requestId, selected.legacy_api_key);
    const apiKeyValue = credential?.api_key ?? selected.legacy_api_key;
    const response = await fetch(endpoint(selected.base_url, "/embeddings"), { method: "POST", headers: { "content-type": "application/json", ...(apiKeyValue ? { authorization: `Bearer ${apiKeyValue}` } : {}) }, body: JSON.stringify({ ...body, model: selected.model }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(502, payload.error?.message ?? `Upstream returned ${response.status}`, "upstream_error");
    return { response: payload, headers: { "x-atlas-request-id": requestId, "x-atlas-provider": selected.provider_id } };
  }

  countTokens(request) { return { input_tokens: estimateTokens(promptText(request.messages)), model: request.model ?? "auto" }; }

  async testProvider(providerId) {
    const provider = this.db.prepare("SELECT * FROM providers WHERE id=?").get(providerId);
    if (!provider) throw new HttpError(404, "Provider not found", "provider_not_found");
    if (provider.kind === "mock") { this.updateProviderHealth(providerId, "healthy", 0); return { provider_id: providerId, status: "healthy", latency_ms: 0 }; }
    const credential = this.pickCredential(providerId, id("health"), provider.api_key);
    const started = Date.now();
    try {
      const apiKey = credential?.api_key ?? provider.api_key;
      const response = await fetch(endpoint(provider.base_url, "/models"), { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(Math.min(this.config.requestTimeoutMs, 10_000)) });
      const status = response.ok ? "healthy" : "degraded";
      this.updateProviderHealth(providerId, status, Date.now() - started);
      return { provider_id: providerId, status, upstream_status: response.status, latency_ms: Date.now() - started };
    } catch (error) {
      this.updateProviderHealth(providerId, "unhealthy", Date.now() - started);
      return { provider_id: providerId, status: "unhealthy", error: error.message, latency_ms: Date.now() - started };
    }
  }

  async refreshProviderBalance(providerId) {
    const provider = this.db.prepare("SELECT * FROM providers WHERE id=?").get(providerId);
    if (!provider) throw new HttpError(404, "Provider not found", "provider_not_found");
    const endpointUrl = balanceEndpointFor(provider);
    if (!endpointUrl) {
      this.storeBalance(providerId, { status: "unconfigured", amount: null, currency: null, available: null, details: {}, error: null });
      return { provider_id: providerId, status: "unconfigured", message: "This provider has no balance endpoint configured" };
    }
    const credential = this.pickCredential(providerId, id("balance"), provider.api_key);
    const apiKey = credential?.api_key ?? provider.api_key;
    if (!apiKey) throw new HttpError(409, "Provider has no active credential", "credential_unavailable");
    try {
      const response = await fetch(endpointUrl, {
        headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
        signal: AbortSignal.timeout(Math.min(this.config.requestTimeoutMs, 10_000)),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new HttpError(502, payload.error?.message ?? `Balance endpoint returned ${response.status}`, "balance_upstream_error", { upstream_status: response.status });
      const parsed = parseBalancePayload(payload);
      this.storeBalance(providerId, { ...parsed, status: "healthy", error: null, details: payload });
      return { provider_id: providerId, ...parsed, status: "healthy", checked_at: now() };
    } catch (error) {
      this.storeBalance(providerId, {
        status: "unavailable",
        amount: provider.balance_amount,
        currency: provider.balance_currency,
        available: false,
        details: parseJson(provider.balance_details_json, {}),
        error: error.message,
      });
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `Balance request failed: ${error.message}`, "balance_unavailable");
    }
  }

  storeBalance(providerId, { status, amount, currency, available, details, error }) {
    const checkedAt = now();
    this.db.prepare(`UPDATE providers SET balance_amount=?,balance_currency=?,balance_status=?,balance_checked_at=?,
      balance_error=?,balance_details_json=?,updated_at=? WHERE id=?`).run(
      amount, currency, status, checkedAt, error, JSON.stringify(details ?? {}), checkedAt, providerId,
    );
    this.db.prepare(`INSERT INTO provider_balance_snapshots
      (id,provider_id,amount,currency,available,status,details_json,error,checked_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id("bal"), providerId, amount, currency, available === null || available === undefined ? null : available ? 1 : 0,
      status, JSON.stringify(details ?? {}), error, checkedAt,
    );
  }

  listAttempts(limit = 100) { return this.db.prepare("SELECT * FROM provider_attempts ORDER BY created_at DESC,rowid DESC LIMIT ?").all(Math.min(500, Number(limit))); }

  requireProvider(providerId) {
    const row = this.db.prepare("SELECT id FROM providers WHERE id=?").get(providerId);
    if (!row) throw new HttpError(404, "Provider not found", "provider_not_found");
    return row;
  }

  pickCredential(providerId, requestId, legacyApiKey = "") {
    const rows = this.db.prepare(`SELECT * FROM provider_credentials WHERE provider_id=? AND enabled=1
      AND (cooldown_until IS NULL OR cooldown_until<=?) AND (quota_tokens=0 OR used_tokens<quota_tokens)`).all(providerId, now());
    if (!rows.length) return legacyApiKey ? { id: null, api_key: legacyApiKey, provider_id: providerId } : null;
    const total = rows.reduce((sum, row) => sum + Math.max(0.01, row.weight), 0);
    let target = stableHash(requestId) * total;
    for (const row of rows) { target -= Math.max(0.01, row.weight); if (target <= 0) return row; }
    return rows[rows.length - 1];
  }

  markCredential(credential, success, tokens = 0, retryable = false) {
    if (!credential?.id) return;
    if (success) this.db.prepare("UPDATE provider_credentials SET used_tokens=used_tokens+?,error_count=0,cooldown_until=NULL,last_used_at=?,updated_at=? WHERE id=?").run(tokens, now(), now(), credential.id);
    else {
      const cooldown = retryable ? new Date(Date.now() + Math.min(300_000, 15_000 * (credential.error_count + 1))).toISOString() : null;
      this.db.prepare("UPDATE provider_credentials SET error_count=error_count+1,cooldown_until=?,last_used_at=?,updated_at=? WHERE id=?").run(cooldown, now(), now(), credential.id);
    }
  }

  recordAttempt(requestId, attempt, selected, credential, status, latencyMs, retryable, error) {
    this.db.prepare(`INSERT INTO provider_attempts
      (id,request_id,attempt,provider_id,credential_id,model,status,latency_ms,retryable,error,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id("att"), requestId, attempt, selected.provider_id, credential?.id ?? null, selected.model, status, latencyMs, retryable ? 1 : 0, error, now());
  }

  updateProviderHealth(providerId, status, latencyMs) { this.db.prepare("UPDATE providers SET health_status=?,latency_hint_ms=?,updated_at=? WHERE id=?").run(status, latencyMs, now(), providerId); }

  logUsage({ requestId, apiKey, providerId, model, route, status, inputTokens, outputTokens, started, risk, text, error = null, selected = null }) {
    this.db.prepare(`INSERT INTO usage_logs
      (id,request_id,api_key_id,provider_id,model,route,status,input_tokens,output_tokens,latency_ms,risk_level,prompt_preview,error,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id("log"), requestId, apiKey?.id ?? null, providerId, model ?? "", route, status, inputTokens, outputTokens, Date.now() - started, risk, redact(text).slice(0, 180), error, now());
    if (apiKey && status < 500) {
      const cents = selected ? Math.ceil(((inputTokens * Number(selected.input_cost ?? 0)) + (outputTokens * Number(selected.output_cost ?? 0))) / 10_000) : 0;
      this.db.prepare("UPDATE api_keys SET used_tokens=used_tokens+?,spent_cents=spent_cents+? WHERE id=?").run(inputTokens + outputTokens, cents, apiKey.id);
    }
  }
}

function publicCandidate(candidate) {
  const { legacy_api_key, ...safe } = candidate;
  return safe;
}

function defaultBalanceEndpoint(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "api.deepseek.com") return `${url.origin}/user/balance`;
    if (url.hostname.includes("openrouter.ai")) return `${url.origin}/api/v1/credits`;
  } catch { return ""; }
  return "";
}

function parseBalancePayload(payload) {
  if (Array.isArray(payload.balance_infos) && payload.balance_infos.length) {
    const info = payload.balance_infos.find((item) => item.currency === "CNY") ?? payload.balance_infos[0];
    return { amount: Number(info.total_balance), currency: info.currency ?? "CNY", available: payload.is_available !== false };
  }
  if (payload.data && Number.isFinite(Number(payload.data.total_credits))) {
    return { amount: Number(payload.data.total_credits) - Number(payload.data.total_usage ?? 0), currency: "USD", available: true };
  }
  if (Number.isFinite(Number(payload.balance))) return { amount: Number(payload.balance), currency: payload.currency ?? "USD", available: payload.available !== false };
  throw new HttpError(502, "Balance endpoint returned an unsupported payload", "unsupported_balance_payload");
}
