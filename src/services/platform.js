import { HttpError } from "../core/http.js";
import { id, now } from "../core/utils.js";

export class PlatformService {
  constructor(db) {
    this.db = db;
  }

  overview(range = "7d") {
    const selectedRange = ["24h", "7d", "30d"].includes(range) ? range : "7d";
    const usageSelect = `SELECT COUNT(*) AS requests,
      COALESCE(SUM(l.input_tokens),0) AS input_tokens,
      COALESCE(SUM(l.output_tokens),0) AS output_tokens,
      COALESCE(SUM(l.input_tokens+l.output_tokens),0) AS tokens,
      COALESCE(SUM((l.input_tokens*p.input_cost+l.output_tokens*p.output_cost)/10000.0),0) AS estimated_spend_cents,
      COALESCE(AVG(l.latency_ms),0) AS avg_latency,
      COALESCE(SUM(CASE WHEN l.status BETWEEN 200 AND 299 THEN 1 ELSE 0 END),0) AS successful,
      COALESCE(SUM(CASE WHEN l.status>=400 THEN 1 ELSE 0 END),0) AS errors
      FROM usage_logs l LEFT JOIN providers p ON p.id=l.provider_id`;
    const today = this.db.prepare(`${usageSelect} WHERE date(l.created_at,'localtime')=date('now','localtime')`).get();
    const totals = this.db.prepare(usageSelect).get();
    const recentWindow = this.db.prepare(`${usageSelect} WHERE julianday(l.created_at)>=julianday('now','-1 day')`).get();
    const minute = this.db.prepare(`SELECT COUNT(*) AS rpm,COALESCE(SUM(input_tokens+output_tokens),0) AS tpm
      FROM usage_logs WHERE julianday(created_at)>=julianday('now','-1 minute')`).get();
    const latencyRows = this.db.prepare(`SELECT latency_ms FROM usage_logs
      WHERE julianday(created_at)>=julianday('now','-1 day') ORDER BY latency_ms`).all();
    const p95Latency = latencyRows.length ? latencyRows[Math.min(latencyRows.length - 1, Math.floor(latencyRows.length * 0.95))].latency_ms : 0;
    const providerSummary = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(enabled),0) AS enabled,
      COALESCE(SUM(CASE WHEN enabled=1 AND health_status='healthy' THEN 1 ELSE 0 END),0) AS healthy,
      COALESCE(SUM(CASE WHEN enabled=1 AND health_status='unhealthy' THEN 1 ELSE 0 END),0) AS unhealthy
      FROM providers`).get();
    const providerAccounts = this.db.prepare(`SELECT p.id,p.name,p.kind,p.enabled,p.health_status,p.latency_hint_ms,
      p.balance_amount,p.balance_currency,p.balance_status,p.balance_checked_at,p.balance_error,p.balance_endpoint,p.base_url,
      COUNT(l.id) AS requests,
      COALESCE(SUM(CASE WHEN l.status>=400 THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(l.input_tokens+l.output_tokens),0) AS tokens,
      COALESCE(AVG(l.latency_ms),0) AS avg_latency
      FROM providers p LEFT JOIN usage_logs l ON l.provider_id=p.id AND julianday(l.created_at)>=julianday('now','-1 day')
      GROUP BY p.id ORDER BY requests DESC,p.name`).all().map((row) => ({ ...row, enabled: Boolean(row.enabled), balance_endpoint_configured: Boolean(row.balance_endpoint) || /api\.deepseek\.com/i.test(String(row.base_url ?? "")) }));
    const balances = this.db.prepare(`SELECT balance_currency AS currency,SUM(balance_amount) AS amount,COUNT(*) AS accounts,
      MAX(balance_checked_at) AS checked_at
      FROM providers WHERE balance_amount IS NOT NULL AND balance_status='healthy'
      GROUP BY balance_currency ORDER BY balance_currency`).all();
    const balanceSummary = balanceSummaryOf(balances);
    const knowledge = this.db.prepare(`SELECT COUNT(*) AS bases,
      (SELECT COUNT(*) FROM knowledge_changes WHERE status='pending') AS pending,
      (SELECT COUNT(*) FROM knowledge_documents d JOIN knowledge_bases kb ON kb.id=d.kb_id AND kb.master_version=d.version) AS documents
      FROM knowledge_bases`).get();
    const runs = this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE julianday(created_at)>=julianday('now','-1 day')").get().count;
    const recent = this.db.prepare(`SELECT request_id,provider_id,model,route,status,input_tokens,output_tokens,latency_ms,risk_level,created_at
      FROM usage_logs ORDER BY created_at DESC LIMIT 8`).all();
    const rangeModifier = selectedRange === "24h" ? "-24 hours" : selectedRange === "30d" ? "-30 days" : "-7 days";
    const rangeRows = this.db.prepare(`SELECT l.created_at,l.input_tokens,l.output_tokens,l.status,l.model,l.provider_id,l.route,l.latency_ms,
      COALESCE(t.name,'未分组') AS team_name,
      COALESCE((l.input_tokens*p.input_cost+l.output_tokens*p.output_cost)/10000.0,0) AS spend_cents
      FROM usage_logs l
      LEFT JOIN providers p ON p.id=l.provider_id
      LEFT JOIN api_keys k ON k.id=l.api_key_id
      LEFT JOIN teams t ON t.id=k.team_id
      WHERE julianday(l.created_at)>=julianday('now',?) ORDER BY l.created_at`).all(rangeModifier);
    const trend = buildTrend(rangeRows, selectedRange);
    const models = distribution(rangeRows, "model");
    const providerNames = new Map(providerAccounts.map((provider) => [provider.id, provider.name]));
    const providerDistribution = distribution(rangeRows, "provider_id").map((item) => ({ ...item, label: providerNames.get(item.key) ?? item.key ?? "未分配" }));
    const routes = distribution(rangeRows, "route");
    const teams = distribution(rangeRows, "team_name");
    const keys = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(enabled),0) AS enabled,
      COALESCE(SUM(quota_tokens),0) AS quota_tokens,COALESCE(SUM(used_tokens),0) AS used_tokens FROM api_keys`).get();
    const alerts = [];
    if (!providerSummary.enabled) alerts.push({ level: "critical", code: "no_provider", message: "没有启用中的 Provider，网关无法路由请求。" });
    if (providerSummary.unhealthy) alerts.push({ level: "warning", code: "provider_unhealthy", message: `${providerSummary.unhealthy} 个 Provider 状态异常。` });
    const staleBalances = providerAccounts.filter((provider) => provider.balance_status === "unavailable").length;
    if (staleBalances) alerts.push({ level: "warning", code: "balance_stale", message: `${staleBalances} 个上游账户余额刷新失败，当前显示最后一次成功值。` });
    if (knowledge.pending) alerts.push({ level: "info", code: "knowledge_pending", message: `${knowledge.pending} 个知识变更等待合并。` });
    return {
      range: selectedRange,
      today: withRates(today),
      totals: withRates(totals),
      usage: withRates(recentWindow),
      performance: { rpm: minute.rpm, tpm: minute.tpm, avg_latency: recentWindow.avg_latency, p95_latency: p95Latency },
      providers: { ...providerSummary, accounts: providerAccounts, balances, balance_summary: balanceSummary },
      api_keys: keys,
      knowledge,
      agent_runs: runs,
      recent,
      trend,
      distributions: { models, teams, providers: providerDistribution, routes },
      alerts,
    };
  }

  logs(limit = 100) {
    return this.db.prepare(`SELECT l.*,k.name AS api_key_name,k.key_prefix AS api_key_prefix,
      d.id AS decision_id,d.reason AS routing_reason,d.candidates_json
      FROM usage_logs l
      LEFT JOIN api_keys k ON k.id=l.api_key_id
      LEFT JOIN routing_decisions d ON d.request_id=l.request_id
      ORDER BY l.created_at DESC LIMIT ?`).all(Math.min(500, Number(limit)))
      .map((row) => ({ ...row, candidates: row.candidates_json ? JSON.parse(row.candidates_json) : [] }));
  }

  listOrganizations() {
    return this.db.prepare(`SELECT o.*,
      (SELECT COUNT(*) FROM teams t WHERE t.organization_id=o.id) AS team_count,
      COALESCE((SELECT SUM(k.spent_cents) FROM api_keys k JOIN teams t ON t.id=k.team_id WHERE t.organization_id=o.id),0) AS spent_cents
      FROM organizations o ORDER BY o.name`).all().map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  }

  createOrganization(input) {
    if (!input.name) throw new HttpError(400, "Organization name is required", "invalid_organization");
    const organizationId = id("org");
    this.db.prepare("INSERT INTO organizations (id,name,monthly_budget_cents,enabled,created_at) VALUES (?,?,?,?,?)")
      .run(organizationId, input.name, Number(input.monthly_budget_cents ?? 0), 1, now());
    return this.db.prepare("SELECT * FROM organizations WHERE id=?").get(organizationId);
  }

  listTeams() {
    return this.db.prepare(`SELECT t.*,
      (SELECT COUNT(*) FROM team_members m WHERE m.team_id=t.id) AS member_count,
      COALESCE((SELECT SUM(k.spent_cents) FROM api_keys k WHERE k.team_id=t.id),0) AS spent_cents
      FROM teams t ORDER BY t.name`).all().map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  }

  createTeam(input) {
    if (!input.name) throw new HttpError(400, "Team name is required", "invalid_team");
    if (input.organization_id && !this.db.prepare("SELECT id FROM organizations WHERE id=?").get(input.organization_id)) throw new HttpError(404, "Organization not found", "organization_not_found");
    const teamId = id("team");
    this.db.prepare("INSERT INTO teams (id,organization_id,name,monthly_budget_cents,enabled,created_at) VALUES (?,?,?,?,?,?)")
      .run(teamId, input.organization_id ?? null, input.name, Number(input.monthly_budget_cents ?? 0), 1, now());
    return this.db.prepare("SELECT * FROM teams WHERE id=?").get(teamId);
  }

  listUsers() {
    return this.db.prepare(`SELECT u.*,(SELECT COUNT(*) FROM team_members m WHERE m.user_id=u.id) AS team_count
      FROM users u ORDER BY u.display_name`).all().map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  }

  createUser(input) {
    if (!input.email || !input.display_name) throw new HttpError(400, "email and display_name are required", "invalid_user");
    const userId = id("usr");
    try { this.db.prepare("INSERT INTO users (id,email,display_name,enabled,created_at) VALUES (?,?,?,?,?)").run(userId, input.email, input.display_name, 1, now()); }
    catch (error) { if (/UNIQUE/i.test(error.message)) throw new HttpError(409, "Email already exists", "user_exists"); throw error; }
    return this.db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  }

  addTeamMember(teamId, input) {
    if (!this.db.prepare("SELECT id FROM teams WHERE id=?").get(teamId)) throw new HttpError(404, "Team not found", "team_not_found");
    if (!this.db.prepare("SELECT id FROM users WHERE id=?").get(input.user_id)) throw new HttpError(404, "User not found", "user_not_found");
    this.db.prepare(`INSERT INTO team_members (team_id,user_id,role,created_at) VALUES (?,?,?,?)
      ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role`).run(teamId, input.user_id, input.role ?? "member", now());
    return this.db.prepare("SELECT * FROM team_members WHERE team_id=? AND user_id=?").get(teamId, input.user_id);
  }

  usageBreakdown() {
    return {
      by_provider: this.db.prepare(`SELECT provider_id,COUNT(*) AS requests,SUM(input_tokens+output_tokens) AS tokens,
        AVG(latency_ms) AS avg_latency,SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) AS errors FROM usage_logs GROUP BY provider_id ORDER BY tokens DESC`).all(),
      by_model: this.db.prepare(`SELECT model,COUNT(*) AS requests,SUM(input_tokens+output_tokens) AS tokens FROM usage_logs GROUP BY model ORDER BY tokens DESC`).all(),
      by_key: this.db.prepare(`SELECT k.id,k.name,k.team_id,k.user_id,k.used_tokens,k.quota_tokens,k.spent_cents,k.monthly_budget_cents,
        COUNT(l.id) AS requests FROM api_keys k LEFT JOIN usage_logs l ON l.api_key_id=k.id GROUP BY k.id ORDER BY k.used_tokens DESC`).all(),
    };
  }
}

function withRates(row) {
  return {
    ...row,
    success_rate: row.requests ? row.successful / row.requests : 1,
    error_rate: row.requests ? row.errors / row.requests : 0,
  };
}

function balanceSummaryOf(balances) {
  const currencies = balances.map((row) => ({
    currency: row.currency,
    amount: Number(row.amount ?? 0),
    accounts: row.accounts,
    checked_at: row.checked_at ?? null,
  }));
  const primary = [...currencies].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0] ?? null;
  return { currencies, primary };
}

function buildTrend(rows, range) {
  const hourly = range === "24h";
  const count = hourly ? 24 : range === "30d" ? 30 : 7;
  const buckets = [];
  const byKey = new Map();
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * (hourly ? 3_600_000 : 86_400_000));
    const key = hourly
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}`
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const bucket = { key, label: hourly ? `${pad(date.getHours())}:00` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, requests: 0, input_tokens: 0, output_tokens: 0, tokens: 0, errors: 0 };
    buckets.push(bucket);
    byKey.set(key, bucket);
  }
  for (const row of rows) {
    const date = new Date(row.created_at);
    const key = hourly
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}`
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const bucket = byKey.get(key);
    if (!bucket) continue;
    bucket.requests += 1;
    bucket.input_tokens += Number(row.input_tokens ?? 0);
    bucket.output_tokens += Number(row.output_tokens ?? 0);
    bucket.tokens += Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
    if (row.status >= 400) bucket.errors += 1;
  }
  return buckets;
}

function distribution(rows, field) {
  const totals = new Map();
  for (const row of rows) {
    const key = row[field] || "未分配";
    const current = totals.get(key) ?? { key, label: key, requests: 0, tokens: 0, spend_cents: 0, errors: 0 };
    current.requests += 1;
    current.tokens += Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
    current.spend_cents += Number(row.spend_cents ?? 0);
    if (row.status >= 400) current.errors += 1;
    totals.set(key, current);
  }
  return [...totals.values()].sort((left, right) => right.tokens - left.tokens || right.requests - left.requests).slice(0, 8);
}

function pad(value) { return String(value).padStart(2, "0"); }
