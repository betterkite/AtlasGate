import { activateKnowledgeTab } from "/knowledge-tabs.js";
import { drawForceGraph } from "/graph.js";

let lastBalanceAutoRefresh = 0;

const state = {
  view: "overview",
  kbId: "",
  messages: [],
  evidence: [],
  useMemory: false,
  knowledgeTab: "changes",
  editingChangeId: "",
  changeDraft: null,
  versionInspect: null,
  documentInspect: "",
  agentModel: "auto",
  overviewRange: "7d",
  overviewMeasure: "tokens",
  debugKey: "",
  debugKeyId: "",
  admin: null,
  wikiPage: "",
  wikiEditDraft: null,
  showHeadings: false,
  sessionId: localStorage.getItem("atlasgate-session") || crypto.randomUUID(),
};
localStorage.setItem("atlasgate-session", state.sessionId);

const titles = {
  overview: ["CONTROL PLANE", "运行总览"],
  agent: ["AGENT WORKSPACE", "知识 Agent"],
  knowledge: ["KNOWLEDGE CONTROL", "知识版本"],
  gateway: ["DATA PLANE", "模型网关"],
  routing: ["ROUTING CONTROL", "路由策略"],
  skills: ["AGENT CAPABILITIES", "Skills 与 Memory"],
  audit: ["EVIDENCE LEDGER", "审计证据"],
  wiki: ["WIKI KNOWLEDGE BASE", "Wiki 知识库"],
};

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.view));
});
document.querySelector("#refresh").addEventListener("click", () => render());
document.querySelector("#logout").addEventListener("click", logoutConsole);
document.querySelector("#login-form").addEventListener("submit", loginConsole);
document.querySelector("#account-settings").addEventListener("click", () => document.querySelector("#account-dialog").showModal());
document.querySelectorAll("[data-account-close]").forEach((button) => button.addEventListener("click", () => document.querySelector("#account-dialog").close()));
document.querySelector("#password-form").addEventListener("submit", changeAdminPassword);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) showAuthGate();
    throw new Error(payload.error?.message ?? `请求失败 (${response.status})`);
  }
  return payload;
}

function showAuthGate() {
  document.querySelector("#auth-gate").hidden = false;
  document.querySelector("#logout").hidden = true;
  document.querySelector("#account-settings").hidden = true;
  document.querySelector("#admin-identity").textContent = "未登录";
  document.querySelector("#service-status").textContent = "需要登录";
}

function setAdmin(user) {
  state.admin = user;
  document.querySelector("#auth-gate").hidden = true;
  document.querySelector("#logout").hidden = false;
  document.querySelector("#account-settings").hidden = false;
  document.querySelector("#admin-identity").textContent = user?.display_name || user?.username || "管理员";
}

async function loginConsole(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  const error = document.querySelector("#login-error");
  error.textContent = "";
  button.disabled = true;
  try {
    const result = await api("/api/auth/login", { method: "POST", body: { username: document.querySelector("#login-username").value, password: document.querySelector("#login-password").value } });
    setAdmin(result.user);
    document.querySelector("#login-password").value = "";
    await render();
  } catch (loginError) {
    error.textContent = loginError.message;
  } finally { button.disabled = false; }
}

async function logoutConsole() {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch { /* session may already be expired */ }
  state.admin = null;
  showAuthGate();
}

async function changeAdminPassword(event) {
  event.preventDefault();
  const error = document.querySelector("#password-error");
  const current = document.querySelector("#current-password").value;
  const next = document.querySelector("#new-password").value;
  const confirm = document.querySelector("#confirm-password").value;
  error.textContent = "";
  if (next !== confirm) { error.textContent = "两次输入的新密码不一致"; return; }
  try {
    await api("/api/auth/password", { method: "POST", body: { current_password: current, new_password: next } });
    document.querySelector("#password-form").reset();
    document.querySelector("#account-dialog").close();
    toast("管理员密码已修改");
  } catch (changeError) { error.textContent = changeError.message; }
}

function navigate(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelector("#page-eyebrow").textContent = titles[view][0];
  document.querySelector("#page-title").textContent = titles[view][1];
  render();
}

async function render() {
  const app = document.querySelector("#app");
  app.innerHTML = '<div class="loading">正在读取运行状态...</div>';
  try {
    await ({
      overview: renderOverview,
      agent: renderAgent,
      knowledge: renderKnowledge,
      gateway: renderGatewayWorkspace,
      routing: renderRouting,
      skills: renderSkills,
      audit: renderAudit,
      wiki: renderWiki,
    })[state.view](app);
    document.querySelector("#service-status").textContent = "服务正常";
  } catch (error) {
    app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    document.querySelector("#service-status").textContent = "连接失败";
  }
}

async function renderOverview(app) {
  const data = await api(`/api/overview?range=${encodeURIComponent(state.overviewRange)}`);
  const period = data.range === "24h" ? "近 24 小时" : data.range === "30d" ? "近 30 天" : "近 7 天";
  const balance = data.providers?.balance_summary ?? { currencies: [], primary: null };
  const refreshable = data.providers?.accounts?.filter((provider) => provider.balance_endpoint_configured) ?? [];
  const balanceHolders = (data.providers?.accounts ?? []).filter((provider) => provider.balance_amount != null);
  const balanceDetail = balance.currencies.length
    ? `${balance.currencies.map((row) => `${money(row.amount, row.currency)} ${row.currency}`).join(" · ")}${balance.primary?.checked_at ? ` · ${shortTime(balance.primary.checked_at)} 更新` : ""}`
    : "未配置余额查询端点";
  app.innerHTML = `
    <div class="dashboard-toolbar">
      <div><strong>用量与余额</strong><span>${period} · API 调用量曲线与上游密钥余额</span></div>
      <div class="toolbar-controls" role="group" aria-label="统计区间">
        ${["24h", "7d", "30d"].map((range) => `<button class="segment ${data.range === range ? "active" : ""}" data-overview-range="${range}">${range === "24h" ? "24 小时" : range === "7d" ? "7 天" : "30 天"}</button>`).join("")}
        <button class="button secondary" id="open-usage-ledger">用量明细</button>
      </div>
    </div>
    <section class="balance-hero">
      <div class="balance-main">
        <span class="balance-label">上游 API Key 余额</span>
        <strong class="balance-amount">${balance.primary ? money(balance.primary.amount, balance.primary.currency) : "未配置"}</strong>
        <small class="balance-detail">${escapeHtml(balanceDetail)}</small>
        ${balanceHolders.length ? `<small class="balance-detail">${balanceHolders.map((provider) => escapeHtml(provider.name)).join("、")}</small>` : ""}
      </div>
      <div class="balance-actions">
        ${refreshable.length ? `<button class="button secondary" id="refresh-all-balances">刷新余额（${refreshable.length}）</button>` : ""}
        <span class="balance-hint">上游 API Key 余额来自 DeepSeek 等平台的账户余额查询；与客户端密钥的 token 配额无关</span>
      </div>
    </section>
    <section class="usage-charts">
      <article class="panel usage-chart-panel">
        <div class="analytics-title"><div><h2>API 请求数</h2><p>${period} · 悬停查看对应时间点</p></div></div>
        <div class="usage-chart"><canvas id="usage-curve-requests" aria-label="API 请求数曲线"></canvas><div class="chart-tooltip" id="usage-tooltip-requests" hidden></div></div>
      </article>
      <article class="panel usage-chart-panel">
        <div class="analytics-title"><div><h2>Token 用量</h2><p>${period} · 悬停查看对应时间点</p></div><div class="chart-legend"><span class="input">输入</span><span class="output">输出</span></div></div>
        <div class="usage-chart"><canvas id="usage-curve-tokens" aria-label="Token 用量曲线"></canvas><div class="chart-tooltip" id="usage-tooltip-tokens" hidden></div></div>
      </article>
    </section>`;
  document.querySelectorAll("[data-overview-range]").forEach((button) => button.addEventListener("click", () => {
    state.overviewRange = button.dataset.overviewRange;
    render();
  }));
  document.querySelector("#open-usage-ledger").addEventListener("click", () => navigate("audit"));
  document.querySelector("#refresh-all-balances")?.addEventListener("click", async () => {
    const button = document.querySelector("#refresh-all-balances");
    button.disabled = true;
    button.textContent = "刷新中…";
    try {
      await Promise.allSettled(refreshable.map((provider) => api(`/api/providers/${provider.id}/balance`, { method: "POST" })));
      toast("余额已刷新");
      render();
    } catch (error) { toast(error.message); button.disabled = false; }
  });
  requestAnimationFrame(() => {
    drawUsageCurve("usage-curve-requests", data.trend, document.querySelector("#usage-tooltip-requests"), {
      key: "requests", label: "请求数", color: "#4e7ac2", fill: "rgba(78,122,194,0.10)",
    });
    drawUsageCurve("usage-curve-tokens", data.trend, document.querySelector("#usage-tooltip-tokens"), {
      key: "tokens", label: "Token", color: "#2e9e6b", fill: "rgba(46,158,107,0.12)",
      inputKey: "input_tokens", outputKey: "output_tokens",
    });
  });
  // Auto-refresh upstream balances on load (at most once a minute) so the
  // current API key balance shows without a manual click.
  const nowTs = Date.now();
  if (refreshable.length && nowTs - lastBalanceAutoRefresh > 60_000) {
    lastBalanceAutoRefresh = nowTs;
    Promise.allSettled(refreshable.map((provider) => api(`/api/providers/${provider.id}/balance`, { method: "POST" })))
      .then(() => { if (state.view === "overview") render(); })
      .catch(() => {});
  }
}

async function renderAgent(app) {
  const [kbs, providers, agentStatus] = await Promise.all([
    api("/api/knowledge-bases"),
    api("/api/providers"),
    api(`/api/agents/knowledge/status?model=${encodeURIComponent(state.agentModel)}`),
  ]);
  if (!state.kbId) state.kbId = kbs[0]?.id ?? "";
  const models = providers.filter((provider) => provider.enabled).flatMap((provider) =>
    provider.models.map((model) => ({ id: `${provider.id}:${model}`, label: `${provider.name} / ${model}` })),
  );
  app.innerHTML = `
    <div class="chat-layout">
      <section class="panel chat-panel">
        <div class="chat-toolbar">
          <select id="agent-kb" aria-label="知识库">${kbs.map((kb) => `<option value="${attr(kb.id)}" ${kb.id === state.kbId ? "selected" : ""}>${escapeHtml(kb.name)} · v${kb.master_version}</option>`).join("")}</select>
          <select id="agent-model" aria-label="Agent 模型"><option value="auto">Auto route</option>${models.map((model) => `<option value="${attr(model.id)}" ${model.id === state.agentModel ? "selected" : ""}>${escapeHtml(model.label)}</option>`).join("")}</select>
          <label class="switch-row"><input id="memory-opt" type="checkbox" ${state.useMemory ? "checked" : ""}> 启用本次 Memory</label>
          <label class="switch-row" title="把有价值的回答保存为 queries/ 页面（D8，默认关闭）"><input id="save-wiki-opt" type="checkbox"> 回存 Wiki</label>
          <span class="badge ${agentStatus.execution_mode === "llm" ? "" : "warn"}">${escapeHtml(agentStatus.provider_name)} / ${escapeHtml(agentStatus.model)} · ${escapeHtml(agentStatus.execution_mode)} · PYTHON CORE</span>
        </div>
        <div class="messages" id="messages">
          ${state.messages.length ? state.messages.map(messageHtml).join("") : '<div class="empty">当前会话没有消息</div>'}
        </div>
        <form class="composer" id="ask-form">
          <textarea id="question" placeholder="向已发布知识版本提问" required></textarea>
          <button class="button primary" type="submit">发送</button>
        </form>
      </section>
      <aside class="panel">
        <div class="panel-title"><h3>检索证据</h3><span class="badge">${state.evidence.length} SOURCES</span></div>
        <div class="evidence-list">${state.evidence.length ? state.evidence.map(evidenceHtml).join("") : '<div class="empty">等待检索</div>'}</div>
      </aside>
    </div>`;
  document.querySelector("#agent-kb").addEventListener("change", (event) => { state.kbId = event.target.value; });
  document.querySelector("#agent-model").addEventListener("change", (event) => { state.agentModel = event.target.value; render(); });
  document.querySelector("#memory-opt").addEventListener("change", (event) => { state.useMemory = event.target.checked; });
  document.querySelector("#ask-form").addEventListener("submit", askAgent);
}
async function askAgent(event) {
  event.preventDefault();
  const input = document.querySelector("#question");
  const button = event.currentTarget.querySelector("button");
  const question = input.value.trim();
  if (!question || !state.kbId) return;
  state.messages.push({ role: "user", content: question });
  input.value = "";
  button.disabled = true;
  await renderAgent(document.querySelector("#app"));
  try {
    const result = await api("/api/agents/knowledge/ask", {
      method: "POST",
      body: {
        kb_id: state.kbId,
        question,
        model: state.agentModel,
        session_id: state.sessionId,
        use_memory: state.useMemory,
        save_to_wiki: document.querySelector("#save-wiki-opt")?.checked === true,
      },
    });
    state.messages.push({ role: "assistant", content: result.answer, meta: `${result.routing?.mode ?? "grounded"} · ${result.memory.recalled} memories` });
    state.evidence = result.sources;
  } catch (error) {
    state.messages.push({ role: "assistant", content: `请求失败：${error.message}`, error: true });
  }
  await renderAgent(document.querySelector("#app"));
  const messages = document.querySelector("#messages");
  messages.scrollTop = messages.scrollHeight;
}

async function renderKnowledge(app) {
  const kbs = await api("/api/knowledge-bases");
  if (!state.kbId || !kbs.some((kb) => kb.id === state.kbId)) state.kbId = kbs[0]?.id ?? "";
  const selected = kbs.find((kb) => kb.id === state.kbId);
  const [documents, changes, versions, conflicts, imports, graph] = selected
    ? await Promise.all([
      api(`/api/knowledge-bases/${selected.id}/documents`),
      api(`/api/knowledge-bases/${selected.id}/changes`),
      api(`/api/knowledge-bases/${selected.id}/versions`),
      api(`/api/knowledge-bases/${selected.id}/conflicts`),
      api(`/api/knowledge-bases/${selected.id}/imports`),
      api(`/api/knowledge-bases/${selected.id}/graph`),
    ]) : [[], [], [], [], [], { nodes: [], edges: [] }];
  const [schema, purpose] = selected
    ? await Promise.all([
      api(`/api/knowledge-bases/${selected.id}/schema`).catch(() => ({ content: "" })),
      api(`/api/knowledge-bases/${selected.id}/purpose`).catch(() => ({ content: "" })),
    ]) : [{ content: "" }, { content: "" }];
  const [queue, reviews, sources] = selected
    ? await Promise.all([
      api(`/api/knowledge-bases/${selected.id}/ingest-queue`).catch(() => []),
      api(`/api/knowledge-bases/${selected.id}/reviews?status=open`).catch(() => []),
      api(`/api/knowledge-bases/${selected.id}/sources`).catch(() => []),
    ]) : [[], [], []];
  const lintReports = selected
    ? await api(`/api/knowledge-bases/${selected.id}/lint-reports?status=open`).catch(() => [])
    : [];
  const inspectedVersion = state.versionInspect && versions.some((version) => version.version === state.versionInspect) ? state.versionInspect : selected?.master_version;
  const versionDocuments = selected && inspectedVersion ? await api(`/api/knowledge-bases/${selected.id}/documents?version=${inspectedVersion}`) : [];
  const inspectedDocument = selected && state.documentInspect
    ? await api(`/api/knowledge-bases/${selected.id}/document?path=${encodeURIComponent(state.documentInspect)}`).catch(() => null)
    : null;
  const draft = state.changeDraft ?? { path: "notes/new-knowledge.md", author: "local-user", content: "" };
  app.innerHTML = `
    <div class="section-header">
      <div><h2>知识发布流</h2><p>master v${selected?.master_version ?? "-"} · ${selected?.pending_changes ?? 0} pending changes</p></div>
      <div class="toolbar"><button class="button secondary" id="new-kb">新建</button><button class="button secondary" id="edit-kb" ${!selected ? "disabled" : ""}>修改</button><button class="button danger" id="delete-kb" ${!selected ? "disabled" : ""}>删除</button><button class="button primary" id="merge" ${!selected?.pending_changes ? "disabled" : ""}>发布合并</button></div>
    </div>
    <div class="knowledge-layout">
      <aside class="panel">
        <div class="panel-title"><h3>知识库</h3><span class="badge neutral">${kbs.length}</span></div>
        <div class="kb-list">${kbs.map((kb) => `<button class="kb-item ${kb.id === state.kbId ? "active" : ""}" data-kb="${attr(kb.id)}"><strong>${escapeHtml(kb.name)}</strong><small>v${kb.master_version} · ${kb.document_count} docs · ${kb.pending_changes} pending</small></button>`).join("")}</div>
      </aside>
      <section class="panel" id="knowledge-workspace">
        <div class="tabs" role="tablist" aria-label="知识版本视图">
          <button class="tab" role="tab" data-knowledge-tab="changes">待合并变更 <span>${changes.filter((change) => change.status === "pending").length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="versions">版本记录 <span>${versions.length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="documents">Master 文档 <span>${documents.length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="import">文档导入 <span>${imports.length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="graph">关系图 <span>${graph.nodes.length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="conflicts">冲突账本 <span>${conflicts.length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="wiki">Wiki 设置</button>
          <button class="tab" role="tab" data-knowledge-tab="ingest">摄入队列 <span>${queue.filter((item) => item.status === "pending" || item.status === "running").length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="reviews">Review 队列 <span>${reviews.length}</span></button>
          <button class="tab" role="tab" data-knowledge-tab="lint">Lint 体检 <span>${lintReports.length}</span></button>
        </div>
        <div data-knowledge-panel="changes" role="tabpanel">
          <div class="panel-body">
            <form id="change-form" class="form-grid">
              <div class="field"><label>文档路径</label><input id="change-path" value="${attr(draft.path)}" required></div>
              <div class="field"><label>提交人</label><input id="change-author" value="${attr(draft.author)}" required></div>
              <div class="field wide"><label>知识内容</label><textarea id="change-content" required>${escapeHtml(draft.content)}</textarea></div>
              <div class="wide form-actions">${state.editingChangeId || state.changeDraft ? '<button class="button secondary" id="cancel-change" type="button">取消</button>' : ""}<button class="button primary" type="submit" ${!selected ? "disabled" : ""}>${state.editingChangeId ? "保存修改" : "提交 Change"}</button></div>
            </form>
          </div>
          <div class="panel-title"><h3>Pending / Merged Changes</h3><span class="badge ${changes.filter((c) => c.status === "pending").length ? "warn" : "neutral"}">${changes.filter((c) => c.status === "pending").length} PENDING</span></div>
          ${batchSummary(changes)}
          ${changeTable(changes)}
        </div>
        <div data-knowledge-panel="versions" role="tabpanel">
          <div class="panel-title"><h3>Versions</h3><span class="badge neutral">当前查看 v${inspectedVersion ?? "-"}</span></div>
          ${versionTable(versions)}
          <div class="panel-title"><h3>v${inspectedVersion ?? "-"} Documents</h3><span class="badge neutral">${versionDocuments.length}</span></div>
          ${versionDocumentTable(versionDocuments)}
        </div>
        <div data-knowledge-panel="documents" role="tabpanel">
          <div class="panel-title"><h3>Master Documents</h3><span class="badge neutral">${documents.length}</span></div>
          ${documentTable(documents)}
          ${inspectedDocument ? `<div class="document-preview"><div class="panel-title"><h3>${escapeHtml(inspectedDocument.path)} · v${inspectedDocument.version}</h3><button class="button secondary" id="close-document">关闭</button></div><pre>${escapeHtml(inspectedDocument.content)}</pre></div>` : ""}
        </div>
        <div data-knowledge-panel="import" role="tabpanel">
          <form id="import-form" class="panel-body form-grid">
            <div class="field wide"><label>MD / TXT / PDF 文档</label><input id="import-file" type="file" accept=".md,.txt,.pdf,text/markdown,text/plain,application/pdf" required></div>
            <div class="field"><label>提交人</label><input id="import-author" value="local-user" required></div>
            <label class="switch-row"><input id="import-publish" type="checkbox"> 导入后立即发布新 Master</label>
            <div class="wide form-actions"><button class="button primary" type="submit">导入文档</button></div>
          </form>
          <div class="panel-title"><h3>Import Ledger</h3><span class="badge neutral">${imports.length}</span></div>
          ${importTable(imports)}
        </div>
        <div data-knowledge-panel="graph" role="tabpanel">
          <div class="panel-title"><h3>Knowledge Graph · master v${selected?.master_version ?? "-"}</h3><span class="badge">${graph.nodes.length} NODES / ${graph.edges.length} EDGES</span></div>
          ${graphToolbarButtons()}
          <div class="graph-wrap"><canvas id="knowledge-graph" aria-label="知识关系图"></canvas><div class="graph-legend"><span><i class="node-document"></i>文档</span><span><i class="node-heading"></i>标题</span><span><i class="node-tag"></i>标签</span><span><i class="node-reference"></i>引用</span></div></div>
        </div>
        <div data-knowledge-panel="conflicts" role="tabpanel">
          <div class="panel-title"><h3>Conflict Resolution Ledger</h3><span class="badge ${conflicts.length ? "warn" : "neutral"}">${conflicts.length}</span></div>
          ${conflictTable(conflicts)}
        </div>
        <div data-knowledge-panel="wiki" role="tabpanel">
          <div class="panel-body form-grid">
            <div class="field"><label>Ingest 模式</label>
              <select id="wiki-ingest-mode" ${!selected ? "disabled" : ""}>
                <option value="review" ${selected?.ingest_mode === "review" ? "selected" : ""}>review（LLM 产物留待审阅）</option>
                <option value="auto" ${selected?.ingest_mode === "auto" ? "selected" : ""}>auto（自动合并发布）</option>
              </select>
            </div>
            <div class="field wide"><label>schema.md（Wiki 公约）</label><textarea id="wiki-schema" rows="14" spellcheck="false" ${!selected ? "disabled" : ""}>${escapeHtml(schema.content)}</textarea></div>
            <div class="field wide"><label>purpose.md（知识库目标）</label><textarea id="wiki-purpose" rows="10" spellcheck="false" ${!selected ? "disabled" : ""}>${escapeHtml(purpose.content)}</textarea></div>
            <div class="wide form-actions"><button class="button primary" id="save-wiki-settings" type="button" ${!selected ? "disabled" : ""}>保存 Wiki 设置</button><small class="hint">保存会更新知识库配置，并把 schema.md / purpose.md 的修改作为 Pending Change 提交（走版本治理）。</small></div>
          </div>
        </div>
        <div data-knowledge-panel="ingest" role="tabpanel">
          <form id="ingest-form" class="panel-body form-grid">
            <div class="field"><label>摄入方式</label>
              <select id="ingest-kind">
                <option value="paste">粘贴文本</option>
                <option value="url">URL 抓取</option>
                <option value="document">文档上传（MD/TXT/PDF）</option>
              </select>
            </div>
            <div class="field"><label>提交人</label><input id="ingest-author" value="local-user"></div>
            <div class="field wide" id="ingest-text-wrap"><label>素材内容</label><textarea id="ingest-text" rows="8" spellcheck="false"></textarea></div>
            <div class="field wide" id="ingest-url-wrap" hidden><label>URL</label><input id="ingest-url" placeholder="https://..."></div>
            <div class="field wide" id="ingest-file-wrap" hidden><label>文档</label><input id="ingest-file" type="file" accept=".md,.txt,.pdf,text/markdown,text/plain,application/pdf"></div>
            <label class="switch-row wide" title="相同内容之前已摄入过时会跳过；勾选后忽略去重，重新编译"><input id="ingest-force" type="checkbox"> 强制重新摄入（忽略去重）</label>
            <div class="wide form-actions"><button class="button primary" type="submit" ${!selected ? "disabled" : ""}>入队摄入</button><small class="hint">两步编译（分析→生成）需要配置真实模型 Provider；未配置时退化为"素材存档 + 原文成页"。</small></div>
          </form>
          <div class="panel-title"><h3>Ingest Queue</h3><span class="badge neutral">${queue.length}</span></div>
          <div style="overflow:auto"><table><thead><tr><th>KIND</th><th>SOURCE</th><th>STATUS</th><th>ATTEMPT</th><th>ERROR</th><th>TIME</th><th></th></tr></thead><tbody>${queue.map((job) => `<tr><td><span class="badge neutral">${escapeHtml(job.kind)}</span></td><td class="mono">${escapeHtml(job.source_id ? job.source_id.slice(0, 18) : "-")}</td><td><span class="badge ${job.status === "failed" ? "error" : job.status === "running" ? "" : job.status === "done" ? "ok" : "warn"}">${job.status}</span></td><td>${job.attempt}</td><td>${job.error ? `<small>${escapeHtml(job.error.slice(0, 120))}</small>` : "-"}</td><td>${shortTime(job.created_at)}</td><td>${job.status === "pending" ? `<button class="button danger" data-ingest-cancel="${attr(job.id)}">取消</button>` : job.status === "failed" ? `<button class="button secondary" data-ingest-retry="${attr(job.id)}">重试</button>` : "-"}</td></tr>`).join("")}</tbody></table></div>
          <div class="panel-title"><h3>Raw Sources</h3><span class="badge neutral">${sources.length}</span></div>
          <div style="overflow:auto"><table><thead><tr><th>PATH</th><th>FILE</th><th>STATUS</th><th>ERROR</th><th>INGESTED</th></tr></thead><tbody>${sources.map((source) => `<tr><td class="mono">${escapeHtml(source.path)}</td><td>${escapeHtml(source.filename)}</td><td><span class="badge ${source.status === "failed" ? "error" : source.status === "ingested" ? "ok" : "warn"}">${source.status}</span></td><td>${source.error ? `<small>${escapeHtml(source.error.slice(0, 120))}</small>` : "-"}</td><td>${source.ingested_at ? shortTime(source.ingested_at) : "-"}</td></tr>`).join("")}</tbody></table></div>
        </div>
        <div data-knowledge-panel="reviews" role="tabpanel">
          <div class="panel-title"><h3>Human Review Queue</h3><span class="badge ${reviews.length ? "warn" : "neutral"}">${reviews.length} OPEN</span></div>
          ${reviews.length ? `<div class="panel-body"><button class="button secondary" id="resolve-all-reviews">全部标记已处理</button></div>` : ""}
          <div style="overflow:auto"><table><thead><tr><th>KIND</th><th>SUGGESTED ACTION</th><th>PAYLOAD</th><th>TIME</th><th></th></tr></thead><tbody>${reviews.map((review) => `<tr><td><span class="badge neutral">${escapeHtml(review.kind)}</span></td><td>${escapeHtml(review.suggested_action || "-")}</td><td class="mono">${escapeHtml(JSON.stringify(review.payload).slice(0, 160))}</td><td>${shortTime(review.created_at)}</td><td><div class="row-actions"><button class="button secondary" data-review-resolve="${attr(review.id)}">已处理</button><button class="button danger" data-review-dismiss="${attr(review.id)}">忽略</button></div></td></tr>`).join("")}</tbody></table></div>
        </div>
        <div data-knowledge-panel="lint" role="tabpanel">
          <div class="panel-body"><div class="row-actions"><button class="button secondary" id="lint-structural" ${!selected ? "disabled" : ""}>运行结构级检查（免费）</button><button class="button secondary" id="lint-llm" ${!selected ? "disabled" : ""}>运行 LLM 级体检</button></div><small class="hint">结构级检查（孤立页/断链/index 一致性）在每次发布后自动执行，无需人工触发；LLM 级体检（矛盾/过时/数据缺口）需要真实模型 Provider。</small></div>
          <div class="panel-title"><h3>Lint Reports</h3><span class="badge ${lintReports.length ? "warn" : "neutral"}">${lintReports.length} OPEN</span></div>
          <div style="overflow:auto"><table><thead><tr><th>KIND</th><th>SEVERITY</th><th>PATHS</th><th>DETAIL</th><th>TIME</th><th></th></tr></thead><tbody>${lintReports.length ? lintReports.map((report) => `<tr><td><span class="badge neutral">${escapeHtml(report.kind)}</span></td><td><span class="badge ${report.severity === "error" ? "error" : report.severity === "warn" ? "warn" : ""}">${report.severity}</span></td><td class="mono">${escapeHtml(report.path_a ?? "-")}${report.path_b ? ` → ${escapeHtml(report.path_b)}` : ""}</td><td>${escapeHtml(report.detail.slice(0, 160))}</td><td>${shortTime(report.created_at)}</td><td><div class="row-actions">${report.kind === "missing_page" && report.suggested_path ? `<button class="button secondary" data-lint-create="${attr(report.id)}">一键建页</button>` : ""}<button class="button secondary" data-lint-ack="${attr(report.id)}">已确认</button><button class="button danger" data-lint-dismiss="${attr(report.id)}">忽略</button></div></td></tr>`).join("") : '<tr><td colspan="6" class="empty">没有待处理的 Lint 报告</td></tr>'}</tbody></table></div>
        </div>
      </section>
    </div>`;
  const knowledgeWorkspace = document.querySelector("#knowledge-workspace");
  state.knowledgeTab = activateKnowledgeTab(knowledgeWorkspace, state.knowledgeTab);
  document.querySelectorAll("[data-knowledge-tab]").forEach((button) => button.addEventListener("click", () => {
    state.knowledgeTab = activateKnowledgeTab(knowledgeWorkspace, button.dataset.knowledgeTab);
    if (state.knowledgeTab === "graph") requestAnimationFrame(() => drawKnowledgeGraph(graph));
  }));
  wireGraphToolbar(() => drawKnowledgeGraph(graph));
  document.querySelectorAll("[data-kb]").forEach((item) => item.addEventListener("click", () => {
    state.kbId = item.dataset.kb;
    resetChangeDraft();
    render();
  }));
  document.querySelector("#change-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const body = {
        path: document.querySelector("#change-path").value,
        content: document.querySelector("#change-content").value,
        author: document.querySelector("#change-author").value,
        expected_revision: draft.revision,
      };
      const result = state.editingChangeId
        ? await api(`/api/knowledge-bases/${state.kbId}/changes/${state.editingChangeId}`, { method: "PATCH", body })
        : await api(`/api/knowledge-bases/${state.kbId}/changes`, { method: "POST", body });
      toast(state.editingChangeId ? "Pending Change 已修改" : result.auto_merged ? `已自动发布 v${result.auto_merged.version}` : "Change 已进入待合并队列");
      resetChangeDraft();
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#cancel-change")?.addEventListener("click", () => { resetChangeDraft(); render(); });
  document.querySelectorAll("[data-change-edit]").forEach((button) => button.addEventListener("click", () => {
    const change = changes.find((item) => item.id === button.dataset.changeEdit);
    if (!change) return;
    state.editingChangeId = change.id;
    state.changeDraft = { path: change.path, author: change.author, content: change.content, revision: change.revision };
    state.knowledgeTab = "changes";
    render();
  }));
  document.querySelectorAll("[data-change-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("撤销这个 Pending Change？")) return;
    try {
      await api(`/api/knowledge-bases/${state.kbId}/changes/${button.dataset.changeDelete}`, { method: "DELETE" });
      resetChangeDraft();
      toast("Pending Change 已撤销");
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-document-edit]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const documentData = await api(`/api/knowledge-bases/${state.kbId}/document?path=${encodeURIComponent(button.dataset.documentEdit)}`);
      state.editingChangeId = "";
      state.changeDraft = { path: documentData.path, author: "local-user", content: documentData.content };
      state.knowledgeTab = "changes";
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-document-view]").forEach((button) => button.addEventListener("click", () => {
    state.documentInspect = button.dataset.documentView;
    state.knowledgeTab = "documents";
    render();
  }));
  document.querySelector("#close-document")?.addEventListener("click", () => { state.documentInspect = ""; render(); });
  document.querySelectorAll("[data-version-open]").forEach((button) => button.addEventListener("click", () => {
    state.versionInspect = Number(button.dataset.versionOpen);
    state.knowledgeTab = "versions";
    render();
  }));
  document.querySelector("#import-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = document.querySelector("#import-file").files[0];
    if (!file) return;
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api(`/api/knowledge-bases/${state.kbId}/import`, { method: "POST", body: {
        filename: file.name,
        media_type: file.type || undefined,
        data_base64: await fileToBase64(file),
        author: document.querySelector("#import-author").value,
        publish: document.querySelector("#import-publish").checked,
      } });
      toast(result.published ? `文档已导入并发布 v${result.published.version}` : "文档已解析并进入待合并队列");
      render();
    } catch (error) { button.disabled = false; toast(error.message); }
  });
  document.querySelectorAll("[data-document-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm(`删除 Master 文档 ${button.dataset.documentDelete}？该操作会先生成 Change。`)) return;
    try {
      const result = await api(`/api/knowledge-bases/${state.kbId}/changes`, { method: "POST", body: {
        path: button.dataset.documentDelete,
        operation: "delete",
        author: "local-user",
      } });
      state.knowledgeTab = "changes";
      toast(result.auto_merged ? `删除已自动发布到 v${result.auto_merged.version}` : "删除 Change 已进入待合并队列");
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelector("#merge").addEventListener("click", async () => {
    try {
      const result = await api(`/api/knowledge-bases/${state.kbId}/merge`, { method: "POST", body: { summary: "Console batch merge" } });
      toast(`已发布 master v${result.version}，冲突 ${result.conflict_count}`);
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#save-wiki-settings")?.addEventListener("click", async () => {
    if (!selected) return;
    try {
      const mode = document.querySelector("#wiki-ingest-mode").value;
      const schemaText = document.querySelector("#wiki-schema").value;
      const purposeText = document.querySelector("#wiki-purpose").value;
      if (mode !== selected.ingest_mode) {
        await api(`/api/knowledge-bases/${selected.id}`, { method: "PATCH", body: { ingest_mode: mode } });
      }
      if (schemaText !== schema.content) {
        await api(`/api/knowledge-bases/${selected.id}/schema`, { method: "PUT", body: { content: schemaText, author: "local-user" } });
      }
      if (purposeText !== purpose.content) {
        await api(`/api/knowledge-bases/${selected.id}/purpose`, { method: "PUT", body: { content: purposeText, author: "local-user" } });
      }
      toast("Wiki 设置已保存，schema/purpose 变更已进入待合并队列");
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#ingest-kind").addEventListener("change", () => {
    const kind = document.querySelector("#ingest-kind").value;
    document.querySelector("#ingest-text-wrap").hidden = kind !== "paste";
    document.querySelector("#ingest-url-wrap").hidden = kind !== "url";
    document.querySelector("#ingest-file-wrap").hidden = kind !== "document";
  });
  document.querySelector("#ingest-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const kind = document.querySelector("#ingest-kind").value;
    const body = { kind, author: document.querySelector("#ingest-author").value, force: document.querySelector("#ingest-force")?.checked === true };
    if (kind === "url") body.url = document.querySelector("#ingest-url").value.trim();
    else if (kind === "document") {
      const file = document.querySelector("#ingest-file").files[0];
      if (!file) return;
      body.filename = file.name;
      body.media_type = file.type || undefined;
      body.data_base64 = await fileToBase64(file);
    } else {
      body.text = document.querySelector("#ingest-text").value;
    }
    try {
      const result = await api(`/api/knowledge-bases/${state.kbId}/ingest`, { method: "POST", body });
      toast(result.skipped
        ? "摄入跳过：相同内容此前已摄入过（去重）。如需重新编译，请勾选「强制重新摄入」后重试"
        : `摄入任务已入队（${result.job.id}）`);
      state.knowledgeTab = "ingest";
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelectorAll("[data-ingest-cancel]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/knowledge-bases/${state.kbId}/ingest-queue/${button.dataset.ingestCancel}/cancel`, { method: "POST" });
      toast("摄入任务已取消");
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-ingest-retry]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/knowledge-bases/${state.kbId}/ingest-queue/${button.dataset.ingestRetry}/retry`, { method: "POST" });
      toast("摄入任务已重新入队");
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-review-resolve]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/knowledge-bases/${state.kbId}/reviews/${button.dataset.reviewResolve}`, { method: "PATCH", body: { status: "resolved", action: "acknowledged" } });
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-review-dismiss]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/knowledge-bases/${state.kbId}/reviews/${button.dataset.reviewDismiss}`, { method: "PATCH", body: { status: "dismissed", action: "dismissed" } });
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelector("#resolve-all-reviews")?.addEventListener("click", async () => {
    try {
      const ids = reviews.map((review) => review.id);
      const result = await api(`/api/knowledge-bases/${state.kbId}/reviews/resolve`, { method: "POST", body: { ids, action: "acknowledged" } });
      toast(`已处理 ${result.count} 条 Review`);
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelectorAll("[data-batch-withdraw]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("撤销该编译批次的所有 Pending Change？")) return;
    try {
      const pending = changes.filter((change) => change.status === "pending" && change.batch_id === button.dataset.batchWithdraw);
      for (const change of pending) await api(`/api/knowledge-bases/${state.kbId}/changes/${change.id}`, { method: "DELETE" });
      toast(`已撤销 ${pending.length} 个 Change`);
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelector("#lint-structural")?.addEventListener("click", async () => {
    try {
      const result = await api(`/api/knowledge-bases/${state.kbId}/lint`, { method: "POST", body: { mode: "structural" } });
      toast(`结构级检查完成，新增 ${result.reports.length} 条报告`);
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#lint-llm")?.addEventListener("click", async () => {
    try {
      const result = await api(`/api/knowledge-bases/${state.kbId}/lint`, { method: "POST", body: { mode: "llm" } });
      toast(`LLM 体检完成，新增 ${result.reports.length} 条报告`);
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelectorAll("[data-lint-ack]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/knowledge-bases/${state.kbId}/lint-reports/${button.dataset.lintAck}`, { method: "PATCH", body: { status: "acked" } });
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-lint-dismiss]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/knowledge-bases/${state.kbId}/lint-reports/${button.dataset.lintDismiss}`, { method: "PATCH", body: { status: "dismissed" } });
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-lint-create]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const result = await api(`/api/knowledge-bases/${state.kbId}/lint-reports/${button.dataset.lintCreate}/create-page`, { method: "POST", body: {} });
      toast(`已创建待补页面 ${result.change.path}`);
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelector("#new-kb").addEventListener("click", async () => {
    const name = prompt("知识库名称");
    if (!name) return;
    try {
      const kb = await api("/api/knowledge-bases", { method: "POST", body: { name } });
      state.kbId = kb.id;
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#edit-kb").addEventListener("click", async () => {
    if (!selected) return;
    const name = prompt("知识库名称", selected.name);
    if (name === null) return;
    const description = prompt("知识库描述", selected.description);
    if (description === null) return;
    try {
      await api(`/api/knowledge-bases/${selected.id}`, { method: "PATCH", body: { name, description } });
      toast("知识库信息已修改");
      render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#delete-kb").addEventListener("click", async () => {
    if (!selected || !confirm(`永久删除知识库 ${selected.name} 及其全部版本？`)) return;
    try {
      await api(`/api/knowledge-bases/${selected.id}`, { method: "DELETE" });
      state.kbId = "";
      resetChangeDraft();
      toast("知识库已删除");
      render();
    } catch (error) { toast(error.message); }
  });
  if (state.knowledgeTab === "graph") requestAnimationFrame(() => drawKnowledgeGraph(graph));
}

function resetChangeDraft() {
  state.editingChangeId = "";
  state.changeDraft = null;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

async function renderGateway(app) {
  const [providers, keys, mappings, attempts] = await Promise.all([api("/api/providers"), api("/api/keys"), api("/api/model-mappings"), api("/api/provider-attempts?limit=30")]);
  app.innerHTML = `
    <section class="metric-grid">
      ${metric("Providers", providers.length, `${providers.filter((p) => p.enabled).length} enabled`)}
      ${metric("模型映射", mappings.length, `${new Set(mappings.map((item) => item.alias)).size} client aliases`)}
      ${metric("API Keys", keys.length, `${keys.filter((key) => key.enabled).length} active`)}
      ${metric("协议入口", "3 + MCP", "Chat / Responses / Messages")}
    </section>
    <section class="policy-grid">
      <div class="policy-cell"><span>ROUTING</span><strong>映射 + 能力 + 评分</strong><small>质量、成本、延迟、可靠性和会话亲和</small></div>
      <div class="policy-cell"><span>RESILIENCE</span><strong>凭据池 + Failover</strong><small>加权选择、冷却、最多四次有界重试</small></div>
      <div class="policy-cell"><span>GOVERNANCE</span><strong>Scope + RPM/TPM + Budget</strong><small>按 API Key、用户和团队记录用量</small></div>
    </section>
    <section class="split">
      <div class="panel">
        <div class="panel-title"><h3>Provider Inventory</h3><span class="badge">LIVE CONFIG</span></div>
        ${providerTable(providers)}
      </div>
      <div class="panel">
        <div class="panel-title"><h3>路由试算</h3><span class="badge neutral">NO EGRESS</span></div>
        <form class="panel-body stack" id="route-form">
          <div class="field"><label>请求模型</label><input id="route-model" value="auto"></div>
          <div class="field"><label>Profile</label><select id="route-profile"><option>balanced</option><option>quality</option><option>economy</option><option>latency</option></select></div>
          <label class="switch-row"><input id="route-vision" type="checkbox"> 包含图片内容</label>
          <button class="button primary" type="submit">计算候选</button>
          <div id="route-result"></div>
        </form>
      </div>
    </section>
    <section class="section split">
      <div class="panel">
        <div class="panel-title"><h3>Model Mappings</h3><span class="badge">${mappings.length} ROUTES</span></div>
        ${mappingTable(mappings, providers)}
      </div>
      <div class="panel">
        <div class="panel-title"><h3>新增模型映射</h3><span class="badge neutral">ALIAS</span></div>
        <form id="mapping-form" class="panel-body stack">
          <div class="field"><label>客户端模型名</label><input id="mapping-alias" placeholder="smart-chat" required></div>
          <div class="field"><label>Provider</label><select id="mapping-provider">${providers.map((provider) => `<option value="${attr(provider.id)}">${escapeHtml(provider.name)}</option>`).join("")}</select></div>
          <div class="field"><label>上游模型名</label><input id="mapping-model" required></div>
          <button class="button primary" type="submit">保存映射</button>
        </form>
      </div>
    </section>
    <section class="section panel">
      <div class="panel-title"><h3>Provider Attempt Ledger</h3><span class="badge neutral">${attempts.length} ATTEMPTS</span></div>
      ${attemptTable(attempts)}
    </section>
    <section class="section panel">
      <div class="panel-title"><h3>新增 Provider</h3><span class="badge neutral">OPENAI / ANTHROPIC</span></div>
      <form id="provider-form" class="panel-body form-grid">
        <div class="field"><label>名称</label><input id="provider-name" required></div>
        <div class="field"><label>协议</label><select id="provider-kind"><option value="openai">OpenAI compatible</option><option value="anthropic">Anthropic Messages</option></select></div>
        <div class="field"><label>Base URL</label><input id="provider-url" placeholder="http://127.0.0.1:8000/v1" required></div>
        <div class="field"><label>模型（逗号分隔）</label><input id="provider-models" placeholder="qwen3-8b,qwen3-vl" required></div>
        <div class="field"><label>API Key</label><input id="provider-key" type="password"></div>
        <label class="switch-row"><input id="provider-vision" type="checkbox"> Vision capability</label>
        <div class="form-actions"><button class="button primary" type="submit">保存 Provider</button></div>
      </form>
    </section>`;
  document.querySelectorAll("[data-provider-toggle]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/providers/${button.dataset.providerToggle}`, { method: "PATCH", body: { enabled: button.dataset.enabled !== "true" } });
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-provider-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm(`删除 Provider ${button.dataset.providerName}？模型映射和凭据池会同时删除，历史审计记录保留。`)) return;
    try {
      await api(`/api/providers/${button.dataset.providerDelete}`, { method: "DELETE" });
      toast("Provider 已删除");
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-provider-test]").forEach((button) => button.addEventListener("click", async () => {
    try { const result = await api(`/api/providers/${button.dataset.providerTest}/test`, { method: "POST" }); toast(`Provider ${result.status} · ${result.latency_ms} ms`); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-provider-balance]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await api(`/api/providers/${button.dataset.providerBalance}/balance`, { method: "POST" });
      toast(result.status === "healthy" ? `余额 ${money(result.amount, result.currency)}` : `余额查询：${result.status}`);
      render();
    } catch (error) { toast(error.message); button.disabled = false; }
  }));
  document.querySelectorAll("[data-provider-credential]").forEach((button) => button.addEventListener("click", async () => {
    const name = prompt("凭据名称", "Pool key");
    if (!name) return;
    const apiKeyValue = prompt("上游 API Key");
    if (!apiKeyValue) return;
    try { await api(`/api/providers/${button.dataset.providerCredential}/credentials`, { method: "POST", body: { name, api_key: apiKeyValue } }); toast("凭据已加入池"); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-mapping-toggle]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/api/model-mappings/${button.dataset.mappingToggle}`, { method: "PATCH", body: { enabled: button.dataset.enabled !== "true" } }); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelector("#mapping-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/model-mappings", { method: "POST", body: { alias: document.querySelector("#mapping-alias").value, provider_id: document.querySelector("#mapping-provider").value, upstream_model: document.querySelector("#mapping-model").value } });
      toast("模型映射已保存"); render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#route-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const vision = document.querySelector("#route-vision").checked;
      const content = vision ? [{ type: "text", text: "analyze" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] : "analyze";
      const result = await api("/api/routing/simulate", { method: "POST", headers: { "x-atlas-routing-profile": document.querySelector("#route-profile").value }, body: { model: document.querySelector("#route-model").value, messages: [{ role: "user", content }] } });
      document.querySelector("#route-result").innerHTML = `<div class="evidence"><strong>${escapeHtml(result.selected.provider_name)} / ${escapeHtml(result.selected.model)}</strong><p>${escapeHtml(result.reason)} · score ${result.selected.score}</p><span class="badge">${result.candidates.length} candidates</span></div>`;
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#provider-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/providers", { method: "POST", body: {
        name: document.querySelector("#provider-name").value,
        kind: document.querySelector("#provider-kind").value,
        base_url: document.querySelector("#provider-url").value,
        api_key: document.querySelector("#provider-key").value,
        models: document.querySelector("#provider-models").value.split(",").map((item) => item.trim()).filter(Boolean),
        supports_vision: document.querySelector("#provider-vision").checked,
      } });
      toast("Provider 已保存"); render();
    } catch (error) { toast(error.message); }
  });
}

async function renderGatewayWorkspace(app) {
  const [providers, keys, attempts, overview, mappings] = await Promise.all([
    api("/api/providers"), api("/api/keys"), api("/api/provider-attempts?limit=40"), api("/api/overview?range=24h"), api("/api/model-mappings"),
  ]);
  const balance = overview.providers.balances.length
    ? overview.providers.balances.map((item) => money(item.amount, item.currency)).join(" / ")
    : "未配置";
  const gatewayModels = [...new Set(["auto", ...mappings.filter((item) => item.enabled).map((item) => item.alias), ...providers.flatMap((item) => item.models)])];
  const baseUrl = `${window.location.origin}/v1`;
  app.innerHTML = `
    <div class="workspace-heading">
      <div><h2>上游渠道</h2><p>Provider、凭据池、余额和故障转移的运行入口</p></div>
      <div class="toolbar"><button class="button secondary" id="go-routing">路由策略</button><button class="button primary" id="open-provider-dialog">添加 Provider</button></div>
    </div>
    <section class="overview-kpis compact-kpis">
      ${overviewMetric("上游 Provider", format(providers.length), `${providers.filter((item) => item.enabled).length} 个已启用`, "providers")}
      ${overviewMetric("健康渠道", `${overview.providers.healthy}/${overview.providers.enabled}`, `${overview.providers.unhealthy} 个异常`, "health")}
      ${overviewMetric("上游余额", balance, "按币种汇总已成功查询账户", "balance")}
      ${overviewMetric("客户端密钥", format(keys.length), `${keys.filter((item) => item.enabled).length} 个可用`, "keys")}
    </section>
    <section class="section">
      <div class="section-header"><div><h2>Provider 列表</h2><p>测试按钮执行真实连通性检查；余额仅在配置查询端点后可刷新</p></div><span class="badge">LIVE CONFIG</span></div>
      <div class="panel">${providerTable(providers)}</div>
    </section>
    <section class="gateway-lower-grid section">
      <article class="panel">
        <div class="panel-title"><h3>最近上游尝试</h3><span class="badge neutral">${attempts.length} ATTEMPTS</span></div>
        ${attemptTable(attempts)}
      </article>
      <article class="panel">
        <div class="panel-title key-panel-title"><div><h3>客户端访问密钥</h3><p>供业务系统调用 AtlasGate /v1 接口；不同于上游 Provider Key</p></div><button class="button secondary" id="new-gateway-key">创建密钥</button></div>
        ${gatewayKeyTable(keys)}
      </article>
    </section>
    <section class="gateway-tools section">
      <article class="panel guide-panel">
        <div class="panel-title"><div><h3>接入指南</h3><p>客户端访问密钥用于调用网关，不用于登录控制台</p></div><span class="badge neutral">OPENAI / CLAUDE CODE</span></div>
        <div class="guide-body">
          <div class="guide-fact"><span>Base URL</span><code>${escapeHtml(baseUrl)}</code><button class="button secondary copy-button" data-copy-text="${attr(baseUrl)}">复制</button></div>
          ${guideBlock("curl", `curl ${baseUrl}/chat/completions -H \"Authorization: Bearer ${state.debugKey || "ag_your_client_key"}\" -H \"Content-Type: application/json\" -d '{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'`)}
          ${guideBlock("OpenAI SDK", `from openai import OpenAI\nclient = OpenAI(base_url=\"${baseUrl}\", api_key=\"${state.debugKey || "ag_your_client_key"}\")\nclient.chat.completions.create(model=\"auto\", messages=[{\"role\":\"user\",\"content\":\"你好\"}])`)}
          ${guideBlock("Claude Code", `ANTHROPIC_BASE_URL=${baseUrl.replace(/\/v1$/, "")}\nANTHROPIC_API_KEY=${state.debugKey || "ag_your_client_key"}\nANTHROPIC_MODEL=auto`)}
        </div>
      </article>
      <article class="panel debug-panel">
        <div class="panel-title"><div><h3>在线调试</h3><p>使用客户端密钥向本地网关发送一次真实请求</p></div><span class="badge">GATEWAY TEST</span></div>
        <form class="panel-body stack" id="gateway-debug-form">
          <div class="field"><label>客户端密钥</label><select id="debug-key-id"><option value="">选择密钥</option>${keys.map((key) => `<option value="${attr(key.id)}" ${key.id === state.debugKeyId ? "selected" : ""}>${escapeHtml(key.name)} · ${escapeHtml(key.key_prefix)}...${key.enabled ? "" : " · 已撤销"}</option>`).join("")}</select></div>
          <div class="field"><label>原始密钥</label><input id="debug-key" type="password" autocomplete="off" value="${attr(state.debugKey)}" placeholder="创建后粘贴 ag_..."></div>
          <div class="field"><label>模型</label><select id="debug-model">${gatewayModels.map((model) => `<option value="${attr(model)}">${escapeHtml(model)}</option>`).join("")}</select></div>
          <div class="field"><label>测试问题</label><textarea id="debug-question" rows="3" required>请用一句话介绍 AtlasGate。</textarea></div>
          <button class="button primary" type="submit">发送测试请求</button>
        </form>
        <div class="debug-result" id="debug-result"><div class="empty">选择密钥并发送请求后显示响应</div></div>
      </article>
    </section>
    <dialog class="modal" id="provider-dialog">
      <form method="dialog" class="modal-card" id="provider-form-v2">
        <div class="modal-header"><div><h2>添加 Provider</h2><p>接入 OpenAI 兼容或 Anthropic Messages 上游</p></div><button class="icon-button" type="button" data-dialog-close aria-label="关闭">×</button></div>
        <div class="modal-body form-grid">
          <div class="field"><label>渠道名称</label><input id="provider-name-v2" required></div>
          <div class="field"><label>协议</label><select id="provider-kind-v2"><option value="openai">OpenAI compatible</option><option value="anthropic">Anthropic Messages</option></select></div>
          <div class="field wide"><label>Base URL</label><input id="provider-url-v2" placeholder="https://api.example.com/v1" required></div>
          <div class="field wide"><label>模型（逗号分隔）</label><input id="provider-models-v2" placeholder="deepseek-chat,deepseek-reasoner" required></div>
          <div class="field wide"><label>API Key</label><input id="provider-key-v2" type="password" autocomplete="new-password"></div>
          <div class="field"><label>输入价格 / 10K Token</label><input id="provider-input-cost" type="number" min="0" step="0.0001" value="0"></div>
          <div class="field"><label>输出价格 / 10K Token</label><input id="provider-output-cost" type="number" min="0" step="0.0001" value="0"></div>
          <label class="switch-row wide"><input id="provider-vision-v2" type="checkbox"> 支持图片输入</label>
        </div>
        <div class="modal-actions"><button class="button secondary" type="button" data-dialog-close>取消</button><button class="button primary" id="save-provider" value="default">保存并接入</button></div>
      </form>
    </dialog>
    <dialog class="modal" id="key-dialog">
      <form method="dialog" class="modal-card" id="key-form">
        <div class="modal-header"><div><h2>创建客户端访问密钥</h2><p>原始密钥只显示一次，请交给调用方安全保存</p></div><button class="icon-button" type="button" data-dialog-close aria-label="关闭">×</button></div>
        <div class="modal-body form-grid">
          <div class="field wide"><label>调用方名称</label><input id="key-name-v2" placeholder="研发 Agent / BI 服务" required></div>
          <div class="field"><label>权限范围（逗号分隔）</label><input id="key-scopes-v2" value="gateway:invoke" required></div>
          <div class="field"><label>模型白名单（留空=全部）</label><input id="key-models-v2" placeholder="auto,deepseek-chat"></div>
          <div class="field"><label>RPM 请求上限</label><input id="key-rpm-v2" type="number" min="1" value="60" required></div>
          <div class="field"><label>TPM Token 上限</label><input id="key-tpm-v2" type="number" min="1" value="100000" required></div>
          <div class="field"><label>总 Token 额度</label><input id="key-quota-v2" type="number" min="0" value="1000000" required></div>
          <div class="field"><label>月预算（美元，0=不限）</label><input id="key-budget-v2" type="number" min="0" step="0.01" value="0" required></div>
          <div class="field"><label>到期时间（留空=永不过期）</label><input id="key-expires-v2" type="datetime-local"></div>
        </div>
        <div class="modal-actions"><button class="button secondary" type="button" data-dialog-close>取消</button><button class="button primary" value="default">创建并显示密钥</button></div>
      </form>
    </dialog>
    <dialog class="modal secret-modal" id="key-secret-dialog">
      <div class="modal-card"><div class="modal-header"><div><h2>客户端密钥已创建</h2><p>这是唯一一次显示原始密钥，请立即复制并安全保存</p></div><button class="icon-button" type="button" data-secret-close aria-label="关闭">×</button></div><div class="secret-value"><code id="issued-key-value"></code><button class="button secondary" id="copy-issued-key" type="button">复制密钥</button></div><div class="modal-actions"><button class="button primary" type="button" data-secret-close>我已保存</button></div></div>
    </dialog>`;
  document.querySelector("#go-routing").addEventListener("click", () => navigate("routing"));
  const dialog = document.querySelector("#provider-dialog");
  document.querySelector("#open-provider-dialog").addEventListener("click", () => dialog.showModal());
  dialog.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => dialog.close()));
  bindProviderActions();
  bindGatewayKeyActions();
  const keyDialog = document.querySelector("#key-dialog");
  const secretDialog = document.querySelector("#key-secret-dialog");
  document.querySelector("#new-gateway-key").addEventListener("click", () => keyDialog.showModal());
  keyDialog.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => keyDialog.close()));
  secretDialog.querySelectorAll("[data-secret-close]").forEach((button) => button.addEventListener("click", () => secretDialog.close()));
  document.querySelector("#copy-issued-key").addEventListener("click", async () => { await navigator.clipboard?.writeText(state.debugKey); toast("密钥已复制"); });
  document.querySelectorAll("[data-copy-text]").forEach((button) => button.addEventListener("click", async () => { await navigator.clipboard?.writeText(button.dataset.copyText); toast("已复制"); }));
  document.querySelector("#key-form").addEventListener("submit", createGatewayKey);
  document.querySelector("#debug-key-id").addEventListener("change", (event) => { state.debugKeyId = event.target.value; });
  document.querySelector("#gateway-debug-form").addEventListener("submit", runGatewayDebug);
  document.querySelector("#provider-form-v2").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/providers", { method: "POST", body: {
        name: document.querySelector("#provider-name-v2").value,
        kind: document.querySelector("#provider-kind-v2").value,
        base_url: document.querySelector("#provider-url-v2").value,
        api_key: document.querySelector("#provider-key-v2").value,
        models: document.querySelector("#provider-models-v2").value.split(",").map((item) => item.trim()).filter(Boolean),
        input_cost: Number(document.querySelector("#provider-input-cost").value),
        output_cost: Number(document.querySelector("#provider-output-cost").value),
        supports_vision: document.querySelector("#provider-vision-v2").checked,
      } });
      dialog.close();
      toast("Provider 已保存");
      render();
    } catch (error) { toast(error.message); }
  });
}

async function renderRouting(app) {
  const [providers, mappings] = await Promise.all([api("/api/providers"), api("/api/model-mappings")]);
  const activeAliases = new Set(mappings.filter((item) => item.enabled).map((item) => item.alias));
  app.innerHTML = `
    <div class="workspace-heading">
      <div><h2>模型目录与路由策略</h2><p>一个客户端别名可绑定多个上游，按能力、策略评分和优先级选路</p></div>
      <div class="toolbar"><button class="button secondary" id="open-simulation">策略验证</button><button class="button primary" id="open-mapping">新增映射</button></div>
    </div>
    <section class="overview-kpis compact-kpis">
      ${overviewMetric("客户端模型", format(activeAliases.size), "对外暴露的稳定模型别名", "aliases")}
      ${overviewMetric("路由条目", format(mappings.length), `${mappings.filter((item) => item.enabled).length} 个已启用`, "routes")}
      ${overviewMetric("可用 Provider", format(providers.filter((item) => item.enabled).length), `${providers.filter((item) => item.health_status === "healthy").length} 个健康`, "providers")}
      ${overviewMetric("视觉路由", format(mappings.filter((item) => item.capabilities.includes("vision") && item.enabled).length), "通过能力检查后参与评分", "vision")}
    </section>
    <section class="section">
      <div class="section-header"><div><h2>模型映射</h2><p>优先级数值越小越优先；评分仍综合质量、成本、延迟和可靠性</p></div><span class="badge neutral">${mappings.length} ROUTES</span></div>
      <div class="panel">${routingMappingTable(mappings, providers)}</div>
    </section>
    <dialog class="modal" id="mapping-dialog">
      <form method="dialog" class="modal-card" id="mapping-editor">
        <div class="modal-header"><div><h2 id="mapping-dialog-title">新增模型映射</h2><p>配置客户端别名到具体上游模型的可治理路由</p></div><button class="icon-button" type="button" data-dialog-close aria-label="关闭">×</button></div>
        <input id="mapping-id" type="hidden">
        <div class="modal-body form-grid">
          <div class="field"><label>客户端模型别名</label><input id="mapping-alias-v2" required></div>
          <div class="field"><label>Provider</label><select id="mapping-provider-v2" required>${providers.map((provider) => `<option value="${attr(provider.id)}">${escapeHtml(provider.name)}</option>`).join("")}</select></div>
          <div class="field"><label>上游模型</label><input id="mapping-upstream-v2" required></div>
          <div class="field"><label>优先级</label><input id="mapping-priority-v2" type="number" min="0" value="10" required></div>
          <div class="field wide"><label>能力</label><div class="check-row"><label><input type="checkbox" name="mapping-capability" value="text" checked> 文本</label><label><input type="checkbox" name="mapping-capability" value="vision"> 图片</label><label><input type="checkbox" name="mapping-capability" value="tools"> 工具</label><label><input type="checkbox" name="mapping-capability" value="embeddings"> Embedding</label></div></div>
          <label class="switch-row wide"><input id="mapping-enabled-v2" type="checkbox" checked> 保存后立即启用</label>
        </div>
        <div class="modal-actions"><button class="button secondary" type="button" data-dialog-close>取消</button><button class="button primary" value="default">保存映射</button></div>
      </form>
    </dialog>
    <dialog class="modal simulation-modal" id="simulation-dialog">
      <form method="dialog" class="modal-card" id="simulation-form">
        <div class="modal-header"><div><h2>策略验证</h2><p>仅计算候选和排除原因，不向上游发送请求</p></div><button class="icon-button" type="button" data-dialog-close aria-label="关闭">×</button></div>
        <div class="modal-body route-test-grid">
          <div class="field"><label>请求模型</label><input id="simulation-model" value="auto" required></div>
          <div class="field"><label>路由 Profile</label><select id="simulation-profile"><option value="balanced">均衡</option><option value="quality">质量优先</option><option value="economy">成本优先</option><option value="latency">延迟优先</option></select></div>
          <label class="switch-row"><input id="simulation-vision" type="checkbox"> 模拟图片请求</label>
          <button class="button primary" id="run-simulation" value="default">运行验证</button>
        </div>
        <div class="simulation-result" id="simulation-result"><div class="empty">填写请求条件后运行策略验证</div></div>
      </form>
    </dialog>`;
  const mappingDialog = document.querySelector("#mapping-dialog");
  const simulationDialog = document.querySelector("#simulation-dialog");
  mappingDialog.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => mappingDialog.close()));
  simulationDialog.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => simulationDialog.close()));
  document.querySelector("#open-mapping").addEventListener("click", () => { resetMappingEditor(); mappingDialog.showModal(); });
  document.querySelector("#open-simulation").addEventListener("click", () => simulationDialog.showModal());
  document.querySelectorAll("[data-mapping-edit]").forEach((button) => button.addEventListener("click", () => {
    const mapping = mappings.find((item) => item.id === button.dataset.mappingEdit);
    fillMappingEditor(mapping);
    mappingDialog.showModal();
  }));
  document.querySelectorAll("[data-mapping-toggle]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/api/model-mappings/${button.dataset.mappingToggle}`, { method: "PATCH", body: { enabled: button.dataset.enabled !== "true" } }); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-mapping-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm(`删除模型映射 ${button.dataset.mappingName}？`)) return;
    try { await api(`/api/model-mappings/${button.dataset.mappingDelete}`, { method: "DELETE" }); toast("模型映射已删除"); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelector("#mapping-editor").addEventListener("submit", async (event) => {
    event.preventDefault();
    const mappingId = document.querySelector("#mapping-id").value;
    const body = {
      alias: document.querySelector("#mapping-alias-v2").value.trim(),
      provider_id: document.querySelector("#mapping-provider-v2").value,
      upstream_model: document.querySelector("#mapping-upstream-v2").value.trim(),
      priority: Number(document.querySelector("#mapping-priority-v2").value),
      enabled: document.querySelector("#mapping-enabled-v2").checked,
      capabilities: [...document.querySelectorAll('[name="mapping-capability"]:checked')].map((item) => item.value),
    };
    try {
      await api(mappingId ? `/api/model-mappings/${mappingId}` : "/api/model-mappings", { method: mappingId ? "PATCH" : "POST", body });
      mappingDialog.close(); toast(mappingId ? "模型映射已更新" : "模型映射已创建"); render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#simulation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const vision = document.querySelector("#simulation-vision").checked;
    const content = vision ? [{ type: "text", text: "route test" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] : "route test";
    const target = document.querySelector("#simulation-result");
    target.innerHTML = '<div class="loading">正在计算候选...</div>';
    try {
      const result = await api("/api/routing/simulate", { method: "POST", headers: { "x-atlas-routing-profile": document.querySelector("#simulation-profile").value }, body: { model: document.querySelector("#simulation-model").value.trim(), messages: [{ role: "user", content }] } });
      target.innerHTML = simulationResult(result);
    } catch (error) { target.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
  });
}

function bindProviderActions() {
  document.querySelectorAll("[data-provider-toggle]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/api/providers/${button.dataset.providerToggle}`, { method: "PATCH", body: { enabled: button.dataset.enabled !== "true" } }); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-provider-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm(`删除 Provider ${button.dataset.providerName}？关联映射和凭据会删除，历史审计保留。`)) return;
    try { await api(`/api/providers/${button.dataset.providerDelete}`, { method: "DELETE" }); toast("Provider 已删除"); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-provider-test]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { const result = await api(`/api/providers/${button.dataset.providerTest}/test`, { method: "POST" }); toast(`连通性 ${result.status} · ${result.latency_ms} ms`); render(); }
    catch (error) { toast(error.message); button.disabled = false; }
  }));
  document.querySelectorAll("[data-provider-balance]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { const result = await api(`/api/providers/${button.dataset.providerBalance}/balance`, { method: "POST" }); toast(result.status === "healthy" ? `余额 ${money(result.amount, result.currency)}` : `余额状态 ${result.status}`); render(); }
    catch (error) { toast(error.message); button.disabled = false; }
  }));
  document.querySelectorAll("[data-provider-credential]").forEach((button) => button.addEventListener("click", async () => {
    const name = prompt("凭据名称", "Pool key");
    if (!name) return;
    const apiKeyValue = prompt("上游 API Key");
    if (!apiKeyValue) return;
    try { await api(`/api/providers/${button.dataset.providerCredential}/credentials`, { method: "POST", body: { name, api_key: apiKeyValue } }); toast("凭据已加入池"); render(); }
    catch (error) { toast(error.message); }
  }));
}

function guideBlock(title, content) {
  return `<div class="guide-block"><strong>${escapeHtml(title)}</strong><pre>${escapeHtml(content)}</pre></div>`;
}

async function createGatewayKey(event) {
  event.preventDefault();
  try {
    const expiry = document.querySelector("#key-expires-v2").value;
    const result = await api("/api/keys", { method: "POST", body: {
      name: document.querySelector("#key-name-v2").value.trim(),
      scopes: document.querySelector("#key-scopes-v2").value.split(",").map((item) => item.trim()).filter(Boolean),
      allowed_models: document.querySelector("#key-models-v2").value.split(",").map((item) => item.trim()).filter(Boolean),
      requests_per_minute: Number(document.querySelector("#key-rpm-v2").value),
      tokens_per_minute: Number(document.querySelector("#key-tpm-v2").value),
      quota_tokens: Number(document.querySelector("#key-quota-v2").value),
      monthly_budget_cents: Math.round(Number(document.querySelector("#key-budget-v2").value) * 100),
      expires_at: expiry ? new Date(expiry).toISOString() : null,
    } });
    state.debugKey = result.key;
    state.debugKeyId = result.id;
    document.querySelector("#key-dialog").close();
    toast("客户端密钥已创建");
    await render();
    document.querySelector("#issued-key-value").textContent = result.key;
    document.querySelector("#key-secret-dialog").showModal();
  } catch (error) { toast(error.message); }
}

async function runGatewayDebug(event) {
  event.preventDefault();
  const key = document.querySelector("#debug-key").value.trim();
  const model = document.querySelector("#debug-model").value;
  const question = document.querySelector("#debug-question").value.trim();
  const resultElement = document.querySelector("#debug-result");
  state.debugKey = key;
  if (!key) { resultElement.innerHTML = '<div class="empty">请提供原始客户端密钥。列表只返回脱敏前缀，不会再次返回完整密钥。</div>'; return; }
  resultElement.innerHTML = '<div class="loading">正在调用网关...</div>';
  try {
    const started = performance.now();
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: question }] }),
    });
    const payload = await response.json().catch(() => ({}));
    resultElement.innerHTML = `<div class="debug-response"><div class="debug-response-head"><span class="badge ${response.ok ? "" : "error"}">${response.status}</span><span>${Math.round(performance.now() - started)} ms</span></div><pre>${escapeHtml(response.ok ? payload.choices?.[0]?.message?.content ?? JSON.stringify(payload, null, 2) : payload.error?.message ?? JSON.stringify(payload, null, 2))}</pre></div>`;
  } catch (error) { resultElement.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

function bindGatewayKeyActions() {
  document.querySelectorAll("[data-key-toggle]").forEach((button) => button.addEventListener("click", async () => {
    const enable = button.dataset.enabled !== "true";
    try {
      await api(`/api/keys/${button.dataset.keyToggle}`, { method: "PATCH", body: { enabled: enable } });
      toast(enable ? "客户端密钥已恢复" : "客户端密钥已撤销，后续调用将被拒绝");
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-key-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm(`永久移除客户端密钥 ${button.dataset.keyName}？该密钥会立即失效，历史用量和审计记录仍保留。`)) return;
    try {
      const result = await api(`/api/keys/${button.dataset.keyDelete}`, { method: "DELETE" });
      toast(`密钥已移除，保留 ${result.retained_usage_logs} 条历史调用记录`);
      render();
    } catch (error) { toast(error.message); }
  }));
}

function resetMappingEditor() {
  document.querySelector("#mapping-dialog-title").textContent = "新增模型映射";
  document.querySelector("#mapping-id").value = "";
  document.querySelector("#mapping-editor").reset();
  document.querySelector('#mapping-editor [value="text"]').checked = true;
  document.querySelector("#mapping-enabled-v2").checked = true;
}

function fillMappingEditor(mapping) {
  resetMappingEditor();
  document.querySelector("#mapping-dialog-title").textContent = "编辑模型映射";
  document.querySelector("#mapping-id").value = mapping.id;
  document.querySelector("#mapping-alias-v2").value = mapping.alias;
  document.querySelector("#mapping-provider-v2").value = mapping.provider_id;
  document.querySelector("#mapping-upstream-v2").value = mapping.upstream_model;
  document.querySelector("#mapping-priority-v2").value = mapping.priority;
  document.querySelector("#mapping-enabled-v2").checked = mapping.enabled;
  document.querySelectorAll('[name="mapping-capability"]').forEach((item) => { item.checked = mapping.capabilities.includes(item.value); });
}

async function renderSkills(app) {
  const [skills, memories, imports] = await Promise.all([api("/api/skills"), api(`/api/memories?session_id=${encodeURIComponent(state.sessionId)}`), api("/api/skill-imports?limit=20")]);
  app.innerHTML = `
    <section class="policy-grid">
      <div class="policy-cell"><span>MEMORY READ</span><strong>Explicit opt-in</strong><small>request.use_memory = true</small></div>
      <div class="policy-cell"><span>MEMORY LIFECYCLE</span><strong>${memories.length} active</strong><small>importance / expiry / supersede / forget</small></div>
      <div class="policy-cell"><span>SKILL LOAD</span><strong>${skills.filter((skill) => skill.attached).length} attached</strong><small>versioned registry / usage feedback</small></div>
    </section>
    <section class="section split">
      <div class="panel">
        <div class="panel-title"><h3>Skill Registry</h3><span class="badge">${skills.length} SKILLS</span></div>
        ${skills.map((skill) => `<div class="skill-row"><div><strong>${escapeHtml(skill.name)} <span class="badge neutral">v${escapeHtml(skill.version)}</span> <span class="badge ${skill.status === "active" ? "" : "warn"}">${escapeHtml(skill.status)}</span></strong><p>${escapeHtml(skill.description)} · ${skill.usage_count} runs · value ${skill.value_score}</p></div><button class="toggle ${skill.attached ? "on" : ""}" data-skill="${attr(skill.id)}" data-attached="${skill.attached}" aria-label="切换 Skill"></button></div>`).join("")}
      </div>
      <div class="panel">
        <div class="panel-title"><h3>Session Memory</h3><span class="badge neutral">${memories.length} ACTIVE</span></div>
        ${memoryTable(memories)}
      </div>
    </section>
    <section class="section split">
      <div class="panel">
        <div class="panel-title"><h3>新增 Skill</h3><span class="badge neutral">VERSIONED</span></div>
        <form id="skill-form" class="panel-body stack">
          <div class="field"><label>名称</label><input id="skill-name" required></div>
          <div class="field"><label>描述</label><input id="skill-description" required></div>
          <div class="field"><label>Instructions</label><textarea id="skill-instructions" required></textarea></div>
          <button class="button primary" type="submit">创建 Skill</button>
        </form>
      </div>
      <div class="panel">
        <div class="panel-title"><h3>导入 Skill 包</h3><span class="badge neutral">SKILL.MD / JSON</span></div>
        <form id="skill-import-form" class="panel-body stack">
          <div class="field"><label>Package</label><input id="skill-package" type="file" accept=".md,.json,text/markdown,application/json" required></div>
          <div class="field"><label>Author</label><input id="skill-import-author" value="local-user" required></div>
          <button class="button primary" type="submit">校验并导入</button>
        </form>
      </div>
    </section>
    <section class="section panel"><div class="panel-title"><h3>Skill Import Ledger</h3><span class="badge neutral">${imports.length} IMPORTS</span></div>${skillImportTable(imports)}</section>`;
  document.querySelectorAll("[data-skill]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/agents/knowledge-agent/skills/${button.dataset.skill}`, { method: "POST", body: { attached: button.dataset.attached !== "true" } });
      render();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll("[data-memory-forget]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/api/memories/${button.dataset.memoryForget}`, { method: "DELETE" }); toast("Memory 已遗忘"); render(); }
    catch (error) { toast(error.message); }
  }));
  document.querySelector("#skill-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/skills", { method: "POST", body: { name: document.querySelector("#skill-name").value, description: document.querySelector("#skill-description").value, instructions: document.querySelector("#skill-instructions").value } });
      toast("Skill 已创建"); render();
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#skill-import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = document.querySelector("#skill-package").files[0];
    if (!file) return;
    try {
      await api("/api/skills/import", { method: "POST", body: { filename: file.name, data_base64: await fileToBase64(file), author: document.querySelector("#skill-import-author").value } });
      toast("Skill 包已导入"); render();
    } catch (error) { toast(error.message); }
  });
}

async function renderAudit(app) {
  const logs = await api("/api/logs?limit=200");
  app.innerHTML = `
    <div class="section-header"><div><h2>Request Evidence Ledger</h2><p>提示词预览已脱敏；路由候选保留评分证据</p></div><span class="badge neutral">${logs.length} ROWS</span></div>
    <section class="panel">${auditTable(logs)}</section>`;
}

function overviewMetric(label, value, detail, tone) {
  return `<article class="overview-metric ${attr(tone)}"><div class="metric-label"><span>${escapeHtml(label)}</span><i aria-hidden="true"></i></div><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`;
}

function distributionPanel(title, canvasId, rows, measure) {
  const total = rows.reduce((sum, row) => sum + Number(measure === "spend" ? row.spend_cents : row.tokens), 0);
  const value = (row) => measure === "spend" ? money(row.spend_cents / 100, "USD") : format(row.tokens);
  const body = rows.length ? rows.map((row, index) => `<tr><td><span class="series-key color-${index % 6}"></span>${escapeHtml(row.label)}</td><td>${value(row)}</td><td>${total ? `${Math.round(Number(measure === "spend" ? row.spend_cents : row.tokens) / total * 100)}%` : "0%"}</td></tr>`).join("") : '<tr><td colspan="3" class="empty-cell">当前区间暂无数据</td></tr>';
  return `<article class="panel analytics-panel">
    <div class="analytics-title"><div><h2>${escapeHtml(title)}</h2><p>按真实网关账本聚合</p></div><div class="segmented"><button class="segment ${measure === "tokens" ? "active" : ""}" data-overview-measure="tokens">按 Token</button><button class="segment ${measure === "spend" ? "active" : ""}" data-overview-measure="spend">按消费</button></div></div>
    <div class="distribution-body"><div class="donut-wrap"><canvas id="${attr(canvasId)}"></canvas><div class="donut-total"><strong>${measure === "spend" ? money(total / 100, "USD") : format(total)}</strong><span>${measure === "spend" ? "消费" : "Token"}</span></div></div><div class="distribution-table"><table><thead><tr><th>名称</th><th>${measure === "spend" ? "消费" : "Token"}</th><th>占比</th></tr></thead><tbody>${body}</tbody></table></div></div>
  </article>`;
}

function routingMappingTable(rows, providers) {
  if (!rows.length) return '<div class="empty">还没有模型映射，请先新增一条可用路由</div>';
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  return `<div class="table-scroll"><table><thead><tr><th>客户端模型</th><th>上游 Provider</th><th>上游模型</th><th>优先级</th><th>能力</th><th>状态</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.alias)}</strong><br><span class="mono">${escapeHtml(row.id)}</span></td><td>${escapeHtml(names.get(row.provider_id) ?? row.provider_id)}</td><td class="mono">${escapeHtml(row.upstream_model)}</td><td>${row.priority}</td><td>${row.capabilities.map((item) => `<span class="badge neutral">${escapeHtml(item)}</span>`).join(" ")}</td><td><span class="badge ${row.enabled ? "" : "error"}">${row.enabled ? "active" : "disabled"}</span></td><td><div class="row-actions"><button class="button secondary" data-mapping-edit="${attr(row.id)}">编辑</button><button class="button secondary" data-mapping-toggle="${attr(row.id)}" data-enabled="${row.enabled}">${row.enabled ? "停用" : "启用"}</button><button class="button danger" data-mapping-delete="${attr(row.id)}" data-mapping-name="${attr(row.alias)}">删除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function gatewayKeyTable(rows) {
  if (!rows.length) return '<div class="empty">尚未签发客户端密钥</div>';
  return `<div class="table-scroll"><table><thead><tr><th>调用方</th><th>前缀</th><th>权限范围</th><th>Token 配额</th><th>月预算</th><th>到期</th><th>状态</th><th></th></tr></thead><tbody>${rows.map((row) => { const expired = row.expires_at && Date.parse(row.expires_at) <= Date.now(); const status = !row.enabled ? "revoked" : expired ? "expired" : "active"; return `<tr><td><strong>${escapeHtml(row.name)}</strong><br><span class="mono">${escapeHtml(row.id)}</span></td><td class="mono">${escapeHtml(row.key_prefix)}...</td><td>${row.scopes.map((scope) => `<span class="badge neutral">${escapeHtml(scope)}</span>`).join(" ")}</td><td>${format(row.used_tokens)} / ${format(row.quota_tokens)}<br><span class="mono">${row.requests_per_minute} RPM · ${format(row.tokens_per_minute)} TPM</span></td><td>${row.monthly_budget_cents ? money(row.monthly_budget_cents / 100, "USD") : "不限"}</td><td>${row.expires_at ? shortTime(row.expires_at) : "永不过期"}</td><td><span class="badge ${status === "active" ? "" : "error"}">${status}</span></td><td><div class="row-actions"><button class="button secondary" data-key-toggle="${attr(row.id)}" data-enabled="${row.enabled}">${row.enabled ? "撤销" : "恢复"}</button><button class="button danger" data-key-delete="${attr(row.id)}" data-key-name="${attr(row.name)}">移除</button></div></td></tr>`; }).join("")}</tbody></table></div>`;
}

const routeReasonLabels = {
  provider_disabled: "Provider 已停用",
  explicit_provider_mismatch: "不匹配指定 Provider",
  provider_lacks_vision: "Provider 不支持图片",
  model_not_mapped: "没有匹配的模型映射",
  mapping_disabled: "模型映射已停用",
  mapping_lacks_vision: "映射未声明图片能力",
  mock_fallback_suppressed: "已有真实上游，内置模拟回退不参与",
  non_vision_model_suppressed: "已有视觉模型，普通模型不参与图片请求",
  lower_policy_priority: "策略评分较低",
};

function simulationResult(result) {
  const selected = result.selected
    ? `<div class="selected-route"><span>最终选中</span><strong>${escapeHtml(result.selected.provider_name)} / ${escapeHtml(result.selected.model)}</strong><small>score ${result.selected.score} · ${escapeHtml(result.reason)}</small></div>`
    : `<div class="selected-route no-route"><span>无法路由</span><strong>没有候选满足当前条件</strong><small>请检查模型别名、启用状态和能力声明</small></div>`;
  const candidates = result.candidates.length ? result.candidates.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.provider_name)}</td><td class="mono">${escapeHtml(item.model)}</td><td><strong>${item.score}</strong></td><td>质量 ${item.signals.quality} · 成本 ${item.signals.cost} · 延迟 ${item.signals.latency} · 可靠性 ${item.signals.reliability}</td></tr>`).join("") : '<tr><td colspan="5" class="empty-cell">无合格候选</td></tr>';
  const excluded = result.excluded.length ? result.excluded.map((item) => `<tr><td>${escapeHtml(item.provider_name)}</td><td class="mono">${escapeHtml(item.model || "-")}</td><td>${escapeHtml(routeReasonLabels[item.reason] ?? item.reason)}</td></tr>`).join("") : '<tr><td colspan="3" class="empty-cell">没有被排除的路由</td></tr>';
  return `${selected}<div class="result-section"><h3>候选评分</h3><div class="table-scroll"><table><thead><tr><th>#</th><th>Provider</th><th>模型</th><th>总分</th><th>评分信号</th></tr></thead><tbody>${candidates}</tbody></table></div></div><div class="result-section"><h3>排除诊断</h3><div class="table-scroll"><table><thead><tr><th>Provider</th><th>模型</th><th>原因</th></tr></thead><tbody>${excluded}</tbody></table></div></div>`;
}

function metric(label, value, detail) {
  return `<article class="metric"><label>${escapeHtml(label)}</label><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`;
}
function flow(number, title, detail) { return `<div class="flow-step"><span>${number}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>`; }
function statusLine(label, value) { return `<div class="section-header"><span class="mono">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`; }
function format(value) { return new Intl.NumberFormat("zh-CN", { notation: value > 9999 ? "compact" : "standard" }).format(value ?? 0); }
function statusBadge(status, risk = "clean") {
  const className = status >= 400 || risk === "critical" ? "error" : risk !== "clean" ? "warn" : "";
  return `<span class="badge ${className}">${status ?? risk}</span>`;
}

function usageTable(rows) {
  if (!rows.length) return '<div class="empty">暂无网关调用</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>REQUEST</th><th>ROUTE</th><th>MODEL</th><th>STATUS</th><th>TOKENS</th><th>LATENCY</th><th>TIME</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.request_id)}</td><td>${escapeHtml(row.route)}</td><td>${escapeHtml(row.model || "-")}</td><td>${statusBadge(row.status, row.risk_level)}</td><td>${row.input_tokens + row.output_tokens}</td><td>${row.latency_ms} ms</td><td>${shortTime(row.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function providerTable(rows) {
  return `<div style="overflow:auto"><table><thead><tr><th>PROVIDER</th><th>MODELS</th><th>HEALTH</th><th>BALANCE</th><th>POOL</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><br><span class="mono">${escapeHtml(row.kind)} · ${escapeHtml(row.id)}</span></td><td>${row.models.map((model) => `<span class="badge neutral">${escapeHtml(model)}</span>`).join(" ")}</td><td><span class="badge ${row.health_status === "unhealthy" || !row.enabled ? "error" : row.health_status === "unknown" ? "warn" : ""}">${row.enabled ? row.health_status : "disabled"}</span><br><span class="mono">Q ${row.quality} · ${row.latency_hint_ms} ms</span></td><td><strong>${row.balance.amount == null ? "-" : money(row.balance.amount, row.balance.currency)}</strong><br><span class="mono">${escapeHtml(row.balance.status)} · ${shortTime(row.balance.checked_at)}</span></td><td>${row.credential_count} keys</td><td><div class="row-actions"><button class="button secondary" data-provider-test="${attr(row.id)}">测试</button>${row.balance.endpoint_configured ? `<button class="button secondary" data-provider-balance="${attr(row.id)}">余额</button>` : ""}<button class="button secondary" data-provider-credential="${attr(row.id)}">加 Key</button><button class="button secondary" data-provider-toggle="${attr(row.id)}" data-enabled="${row.enabled}">${row.enabled ? "停用" : "启用"}</button>${row.id === "prv_local_demo" ? "" : `<button class="button danger" data-provider-delete="${attr(row.id)}" data-provider-name="${attr(row.name)}">删除</button>`}</div></td></tr>`).join("")}</tbody></table></div>`;
}

function providerAccountTable(rows) {
  if (!rows.length) return '<div class="empty">没有 Provider 账户</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>ACCOUNT</th><th>HEALTH</th><th>BALANCE</th><th>24H REQUESTS</th><th>TOKENS</th><th>ERROR RATE</th><th>AVG LATENCY</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><br><span class="mono">${escapeHtml(row.kind)}</span></td><td><span class="badge ${!row.enabled || row.health_status === "unhealthy" ? "error" : row.health_status === "unknown" ? "warn" : ""}">${row.enabled ? escapeHtml(row.health_status) : "disabled"}</span></td><td><strong>${row.balance_amount == null ? "-" : money(row.balance_amount, row.balance_currency)}</strong><br><span class="mono">${shortTime(row.balance_checked_at)}</span></td><td>${format(row.requests)}</td><td>${format(row.tokens)}</td><td>${row.requests ? `${Math.round(row.errors / row.requests * 100)}%` : "-"}</td><td>${Math.round(row.avg_latency)} ms</td><td>${row.balance_endpoint_configured ? `<button class="button secondary" data-balance-refresh="${attr(row.id)}">刷新</button>` : "-"}</td></tr>`).join("")}</tbody></table></div>`;
}

function skillImportTable(rows) {
  if (!rows.length) return '<div class="empty">还没有 Skill 包导入记录</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>FILE</th><th>VERSION</th><th>STATUS</th><th>AUTHOR</th><th>TIME</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.filename)}</td><td>${escapeHtml(row.imported_version || "-")}</td><td><span class="badge ${row.status === "failed" ? "error" : ""}">${escapeHtml(row.status)}</span>${row.error ? `<br><small>${escapeHtml(row.error)}</small>` : ""}</td><td>${escapeHtml(row.author)}</td><td>${shortTime(row.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function mappingTable(rows, providers) {
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  if (!rows.length) return '<div class="empty">没有模型映射</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>ALIAS</th><th>PROVIDER</th><th>UPSTREAM</th><th>CAPABILITIES</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.alias)}</strong></td><td>${escapeHtml(names.get(row.provider_id) ?? row.provider_id)}</td><td class="mono">${escapeHtml(row.upstream_model)}</td><td>${row.capabilities.map((item) => `<span class="badge neutral">${escapeHtml(item)}</span>`).join(" ")}</td><td><button class="button secondary" data-mapping-toggle="${attr(row.id)}" data-enabled="${row.enabled}">${row.enabled ? "停用" : "启用"}</button></td></tr>`).join("")}</tbody></table></div>`;
}
function attemptTable(rows) {
  if (!rows.length) return '<div class="empty">还没有上游尝试记录</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>REQUEST</th><th>ATTEMPT</th><th>PROVIDER</th><th>MODEL</th><th>STATUS</th><th>LATENCY</th><th>RETRY</th><th>TIME</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.request_id)}</td><td>${row.attempt}</td><td class="mono">${escapeHtml(row.provider_id)}</td><td>${escapeHtml(row.model)}</td><td>${statusBadge(row.status)}</td><td>${row.latency_ms} ms</td><td>${row.retryable ? "yes" : "-"}</td><td>${shortTime(row.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function batchSummary(changes) {
  const batches = new Map();
  for (const change of changes) {
    if (change.status === "pending" && change.batch_id) {
      const list = batches.get(change.batch_id) ?? [];
      list.push(change);
      batches.set(change.batch_id, list);
    }
  }
  if (!batches.size) return "";
  return `<div class="panel-body"><h3>编译批次（可整批打回）</h3>${[...batches.entries()].map(([batchId, list]) => `<div class="batch-row"><span class="badge neutral">${escapeHtml(batchId.slice(-8))}</span> ${list.length} 个 Change 待审阅 <button class="button danger" data-batch-withdraw="${attr(batchId)}">整批打回</button></div>`).join("")}<small class="hint">"发布合并"会一次发布全部 Pending Change；逐条挑拣请使用下方列表。</small></div>`;
}

function changeTable(rows) {
  if (!rows.length) return '<div class="empty">没有变更记录</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>PATH</th><th>OP</th><th>BASE</th><th>AUTHOR</th><th>STATUS</th><th>CONFLICT</th><th>TIME</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${row.batch_id ? `<span class="badge neutral" title="编译批次 ${escapeHtml(row.batch_id)}">${escapeHtml(row.batch_id.slice(-6))}</span> ` : ""}${escapeHtml(row.path)}</td><td><span class="badge neutral">${escapeHtml(row.operation)}</span></td><td>v${row.base_version}</td><td>${escapeHtml(row.author)}</td><td><span class="badge ${row.status === "pending" ? "warn" : ""}">${row.status}</span></td><td>${row.conflict ? '<span class="badge error">yes</span>' : "-"}</td><td>${shortTime(row.created_at)}</td><td>${row.status === "pending" ? `<div class="row-actions">${row.operation === "upsert" ? `<button class="button secondary" data-change-edit="${attr(row.id)}">修改</button>` : ""}<button class="button danger" data-change-delete="${attr(row.id)}">撤销</button></div>` : "-"}</td></tr>`).join("")}</tbody></table></div>`;
}
function versionTable(rows) {
  return `<div style="overflow:auto"><table><thead><tr><th>VERSION</th><th>SUMMARY</th><th>CHANGES</th><th>CONFLICTS</th><th>PUBLISHED</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td><span class="badge">v${row.version}</span></td><td>${escapeHtml(row.summary)}</td><td>${row.change_count}</td><td>${row.conflict_count}</td><td>${shortTime(row.created_at)}</td><td><button class="button secondary" data-version-open="${row.version}">打开</button></td></tr>`).join("")}</tbody></table></div>`;
}
function documentTable(rows) {
  if (!rows.length) return '<div class="empty">当前 master 没有文档</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>PATH</th><th>SIZE</th><th>HASH</th><th>UPDATED</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono"><button class="link-button" data-document-view="${attr(row.path)}">${escapeHtml(row.path)}</button></td><td>${format(row.size)} chars</td><td class="mono">${row.content_hash.slice(0, 10)}</td><td>${shortTime(row.updated_at)}</td><td><div class="row-actions"><button class="button secondary" data-document-view="${attr(row.path)}">查看</button><button class="button secondary" data-document-edit="${attr(row.path)}">编辑</button><button class="button danger" data-document-delete="${attr(row.path)}">删除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}
function versionDocumentTable(rows) {
  if (!rows.length) return '<div class="empty">该版本没有文档</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>PATH</th><th>SIZE</th><th>HASH</th><th>UPDATED</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.path)}</td><td>${format(row.size)} chars</td><td class="mono">${row.content_hash.slice(0, 10)}</td><td>${shortTime(row.updated_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function importTable(rows) {
  if (!rows.length) return '<div class="empty">还没有导入记录</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>FILE</th><th>TYPE</th><th>SIZE</th><th>STATUS</th><th>AUTHOR</th><th>TIME</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.filename)}</td><td>${escapeHtml(row.media_type)}</td><td>${format(row.size_bytes)} B</td><td><span class="badge ${row.status === "failed" ? "error" : row.status === "staged" ? "warn" : ""}">${escapeHtml(row.status)}</span>${row.error ? `<br><small>${escapeHtml(row.error)}</small>` : ""}</td><td>${escapeHtml(row.author)}</td><td>${shortTime(row.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function conflictTable(rows) {
  if (!rows.length) return '<div class="empty">当前没有冲突记录</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>VERSION</th><th>PATH</th><th>REASON</th><th>RESOLUTION</th><th>WINNER</th><th>TIME</th></tr></thead><tbody>${rows.map((row) => `<tr><td><span class="badge warn">v${row.version}</span></td><td class="mono">${escapeHtml(row.path)}</td><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.resolution)}</td><td class="mono">${escapeHtml(row.winning_change_id)}</td><td>${shortTime(row.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function memoryTable(rows) {
  if (!rows.length) return '<div class="empty">本会话没有启用中的 Memory</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>TYPE</th><th>CONTENT</th><th>IMPORTANCE</th><th>RECALL</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td><span class="badge neutral">${escapeHtml(row.kind)}</span><br>${escapeHtml(row.scope)}</td><td>${escapeHtml(String(row.content).slice(0, 150))}</td><td>${row.importance}</td><td>${row.access_count}</td><td><button class="button danger" data-memory-forget="${attr(row.id)}">遗忘</button></td></tr>`).join("")}</tbody></table></div>`;
}
function auditTable(rows) {
  if (!rows.length) return '<div class="empty">暂无证据记录</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>REQUEST / DECISION</th><th>调用密钥</th><th>PROMPT PREVIEW</th><th>PROVIDER</th><th>REASON</th><th>RISK</th><th>STATUS</th><th>TIME</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.request_id)}<br>${escapeHtml(row.decision_id || "-")}</td><td>${row.api_key_name ? `<strong>${escapeHtml(row.api_key_name)}</strong><br><span class="mono">${escapeHtml(row.api_key_prefix ?? "")}...</span>` : '<span class="badge neutral">内部调用</span>'}</td><td>${escapeHtml(row.prompt_preview || "-")}</td><td>${escapeHtml(row.provider_id || "-")}</td><td>${escapeHtml(row.routing_reason || "-")}<br><span class="mono">${row.candidates.length} candidates</span></td><td>${statusBadge(null, row.risk_level)}</td><td>${statusBadge(row.status)}</td><td>${shortTime(row.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function messageHtml(message) {
  return `<div class="message ${message.role}"><div class="meta">${message.role === "user" ? "YOU" : `ATLAS AGENT${message.meta ? ` · ${escapeHtml(message.meta)}` : ""}`}</div><div class="bubble">${escapeHtml(message.content)}</div></div>`;
}
function evidenceHtml(source, index) {
  return `<div class="evidence"><strong>[${index + 1}] ${escapeHtml(source.path)}</strong><p>${escapeHtml(source.snippet)}</p><span class="mono">hybrid ${source.score} · v${source.version}</span><div class="score"><i style="width:${Math.max(3, Math.min(100, source.score * 100))}%"></i></div></div>`;
}

function drawChart(rows) {
  const canvas = document.querySelector("#usage-chart");
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, box.width * ratio);
  canvas.height = Math.max(1, box.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const width = box.width;
  const height = box.height;
  ctx.strokeStyle = "#e6ebe8";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  const values = rows.length ? rows.map((row) => row.requests) : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(1, ...values);
  ctx.strokeStyle = "#087f6d";
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = values.length === 1 ? width / 2 : index * (width / (values.length - 1));
    const y = height - 14 - (value / max) * (height - 28);
    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  values.forEach((value, index) => {
    const x = values.length === 1 ? width / 2 : index * (width / (values.length - 1));
    const y = height - 14 - (value / max) * (height - 28);
    ctx.fillStyle = "#f2bd3d"; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  });
}

function drawDonut(canvasId, rows, measure) {
  const canvas = document.querySelector(`#${canvasId}`);
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(box.width * ratio));
  canvas.height = Math.max(1, Math.floor(box.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const width = box.width;
  const height = box.height;
  const values = rows.map((row) => Number(measure === "spend" ? row.spend_cents : row.tokens));
  const total = values.reduce((sum, value) => sum + value, 0);
  const colors = ["#1386d7", "#11a67a", "#f2bd3d", "#e26d5c", "#7357bd", "#56b4c8"];
  let start = -Math.PI / 2;
  const radius = Math.min(width, height) * 0.38;
  if (!total) {
    ctx.strokeStyle = "#e6ecea";
    ctx.lineWidth = Math.max(13, radius * 0.27);
    ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.stroke();
    return;
  }
  rows.forEach((row, index) => {
    const amount = Number(measure === "spend" ? row.spend_cents : row.tokens);
    const end = start + (amount / total) * Math.PI * 2;
    ctx.strokeStyle = colors[index % colors.length];
    ctx.lineWidth = Math.max(13, radius * 0.27);
    ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, start, end - 0.018); ctx.stroke();
    start = end;
  });
}

function drawUsageCurve(canvasId, rows, tooltip, metric) {
  const canvas = document.querySelector(`#${canvasId}`);
  if (!canvas || !rows?.length) return;
  const m = metric ?? { key: "tokens", label: "Token", color: "#2e9e6b", fill: "rgba(46,158,107,0.12)" };
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(box.width * ratio));
  canvas.height = Math.max(1, Math.floor(box.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const width = box.width;
  const height = box.height;
  const padX = 52;
  const padY = 18;
  const innerW = width - padX - 10;
  const innerH = height - padY * 2;
  const maxValue = Math.max(1, ...rows.map((row) => Number(row[m.key] ?? 0))) * 1.1;
  const xFor = (index) => rows.length === 1 ? padX + innerW / 2 : padX + (innerW * index) / (rows.length - 1);
  const yFor = (value) => padY + innerH - (Number(value) / maxValue) * innerH;
  const draw = (hoverIndex = null) => {
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#e8eeec";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#66716e";
    ctx.font = "10px system-ui";
    for (let index = 0; index <= 4; index += 1) {
      const y = padY + (innerH / 4) * index;
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(width - 8, y); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(compact(maxValue - (maxValue / 4) * index), padX - 6, y + 3);
    }
    ctx.textAlign = "center";
    rows.forEach((row, index) => {
      if (index % Math.max(1, Math.ceil(rows.length / 8)) !== 0 && index !== rows.length - 1) return;
      ctx.fillText(row.label, xFor(index), height - 4);
    });
    // Area fill + line for the metric.
    ctx.beginPath();
    rows.forEach((row, index) => {
      const x = xFor(index);
      const y = yFor(row[m.key] ?? 0);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.lineTo(xFor(rows.length - 1), padY + innerH);
    ctx.lineTo(xFor(0), padY + innerH);
    ctx.closePath();
    ctx.fillStyle = m.fill;
    ctx.fill();
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    rows.forEach((row, index) => {
      const x = xFor(index);
      const y = yFor(row[m.key] ?? 0);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    if (hoverIndex !== null) {
      const x = xFor(hoverIndex);
      ctx.strokeStyle = "#26312e";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, padY); ctx.lineTo(x, padY + innerH); ctx.stroke();
      ctx.setLineDash([]);
      const row = rows[hoverIndex];
      ctx.beginPath(); ctx.arc(x, yFor(row[m.key] ?? 0), 4, 0, Math.PI * 2); ctx.fillStyle = m.color; ctx.fill();
    }
  };
  draw();
  if (!tooltip) return;
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const relativeX = event.clientX - rect.left;
    const index = Math.max(0, Math.min(rows.length - 1, Math.round((relativeX - padX) / (innerW / Math.max(1, rows.length - 1)))));
    draw(index);
    const row = rows[index];
    const inputPart = m.inputKey ? `<div>输入 ${format(row[m.inputKey] ?? 0)} · 输出 ${format(row[m.outputKey] ?? 0)}</div>` : "";
    tooltip.innerHTML = `<strong>${escapeHtml(row.label)}</strong><div>${m.label} <b>${format(row[m.key] ?? 0)}</b></div>${inputPart}${row.errors ? `<div class="tooltip-errors">错误 ${row.errors}</div>` : ""}`;
    tooltip.hidden = false;
    const left = Math.min(relativeX + 14, rect.width - tooltip.offsetWidth - 8);
    const top = Math.max(4, Math.min(event.clientY - rect.top - tooltip.offsetHeight - 10, rect.height - tooltip.offsetHeight - 4));
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${top}px`;
  });
  canvas.addEventListener("pointerleave", () => {
    tooltip.hidden = true;
    draw();
  });
}

function compact(value) {
  return new Intl.NumberFormat("zh-CN", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value ?? 0);
}

const COMMUNITY_PALETTE = ["#087f6d", "#3f6f93", "#c28b16", "#8a5a9e", "#c25b4e", "#4e7ac2", "#6d8a3f", "#9b5c74", "#2f8f9b", "#b06f3f"];

async function renderWiki(app) {
  const kbs = await api("/api/knowledge-bases");
  if (!state.kbId || !kbs.some((kb) => kb.id === state.kbId)) state.kbId = kbs[0]?.id ?? "";
  const selected = kbs.find((kb) => kb.id === state.kbId);
  const pages = selected ? await api(`/api/knowledge-bases/${selected.id}/pages`).catch(() => []) : [];
  const graph = selected
    ? await api(`/api/knowledge-bases/${selected.id}/graph`).catch(() => ({ nodes: [], edges: [], communities: [], insights: { isolated: [], sparse: [], bridges: [], surprising: [] } }))
    : { nodes: [], edges: [], communities: [], insights: { isolated: [], sparse: [], bridges: [], surprising: [] } };
  const [schema, purpose] = selected
    ? await Promise.all([
      api(`/api/knowledge-bases/${selected.id}/schema`).catch(() => ({ content: "" })),
      api(`/api/knowledge-bases/${selected.id}/purpose`).catch(() => ({ content: "" })),
    ]) : [{ content: "" }, { content: "" }];
  const researchJobs = selected
    ? await api(`/api/knowledge-bases/${selected.id}/research-jobs?status=pending`).catch(() => [])
    : [];
  if (!state.wikiPage && pages.length) state.wikiPage = pages[0].path;
  if (!pages.some((page) => page.path === state.wikiPage)) state.wikiPage = pages[0]?.path ?? "";
  const inspected = pages.find((page) => page.path === state.wikiPage) ?? null;
  const editing = state.wikiEditDraft?.path === state.wikiPage ? state.wikiEditDraft : null;
  const inspectedContent = inspected
    ? (editing ? editing.content : await api(`/api/knowledge-bases/${selected.id}/document?path=${encodeURIComponent(inspected.path)}`).then((doc) => doc.content).catch(() => ""))
    : "";

  const grouped = {};
  for (const page of pages) (grouped[page.page_type] ??= []).push(page);
  const pageTypeOrder = ["entity", "concept", "source", "comparison", "synthesis", "query", "note", "wiki", "index", "log", "purpose", "schema", "overview"];

  app.innerHTML = `
    <div class="section-header">
      <div><h2>Wiki 知识库</h2><p>${selected ? `${escapeHtml(selected.name)} · master v${selected.master_version} · ${pages.length} 页面 · ${graph.communities.length} 社区` : "未选择知识库"}</p></div>
      <div class="toolbar">
        <select id="wiki-kb" aria-label="知识库">${kbs.map((kb) => `<option value="${attr(kb.id)}" ${kb.id === state.kbId ? "selected" : ""}>${escapeHtml(kb.name)} · v${kb.master_version}</option>`).join("")}</select>
        <button class="button secondary" id="wiki-purp" title="查看 purpose.md / schema.md">公约与目的</button>
        <button class="button secondary" id="wiki-sync" title="把 Master 页面同步为磁盘 md 目录（Obsidian 可打开）">同步 md</button>
        <button class="button primary" id="wiki-export" title="导出 Obsidian 兼容的 Markdown 快照 zip">导出 zip</button>
      </div>
    </div>
    <div class="wiki-layout">
      <aside class="panel wiki-tree">
        <div class="panel-title"><h3>页面目录</h3><span class="badge neutral">${pages.length}</span></div>
        ${pageTypeOrder.filter((type) => grouped[type]?.length).map((type) => `<div class="wiki-group"><h4>${type} <span class="badge neutral">${grouped[type].length}</span></h4>${grouped[type].map((page) => `<button class="kb-item ${page.path === state.wikiPage ? "active" : ""}" data-wiki-page="${attr(page.path)}"><strong>${escapeHtml(page.title || page.path)}</strong><small>${escapeHtml(page.path)}${page.confidence ? ` · ${page.confidence}` : ""}</small></button>`).join("")}</div>`).join("") || '<div class="empty">暂无页面</div>'}
      </aside>
      <section class="panel wiki-reader">
        ${inspected ? (editing
          ? `<form id="wiki-edit-form" class="panel-body"><div class="field"><label>编辑 ${escapeHtml(inspected.path)}（保存将作为 Pending Change 提交）</label><textarea id="wiki-edit-content" rows="24" spellcheck="false">${escapeHtml(editing.content)}</textarea></div><div class="form-actions"><button class="button secondary" type="button" id="wiki-edit-cancel">取消</button><button class="button primary" type="submit">保存为 Change</button></div></form>`
          : `<div class="wiki-meta">${frontmatterBadges(inspected)}<button class="button secondary" id="wiki-edit">编辑此页</button></div><div class="markdown-body">${renderMarkdown(inspectedContent)}</div>`)
          : '<div class="empty">没有页面</div>'}
      </section>
      <aside class="panel wiki-graph-panel">
        <div class="panel-title"><h3>关系图谱</h3><span class="badge">${graph.nodes.length} NODES</span></div>
        ${graphToolbarButtons()}
        <div class="graph-wrap"><canvas id="knowledge-graph" aria-label="Wiki 关系图"></canvas><div class="graph-legend"><span><i class="node-document"></i>文档</span><span><i class="node-heading"></i>标题</span><span><i class="node-tag"></i>标签</span></div></div>
        <div class="panel-title"><h3>社区</h3></div>
        <div class="insight-list">${graph.communities.length ? graph.communities.map((c) => `<div class="insight-row"><i class="dot" style="background:${COMMUNITY_PALETTE[c.id % COMMUNITY_PALETTE.length]}"></i>社区 #${c.id} · ${c.members} 页 · 凝聚度 ${c.cohesion}</div>`).join("") : '<div class="empty">暂无社区</div>'}</div>
        <div class="panel-title"><h3>洞察</h3></div>
        <div class="insight-list">
          ${insightSection("孤立页", graph.insights.isolated)}
          ${insightSection("桥接节点", graph.insights.bridges)}
          ${graph.insights.sparse.length ? `<div class="insight-warn">稀疏社区：${graph.insights.sparse.map((s) => `#${s.community} 凝聚度 ${s.cohesion}`).join("、")}</div>` : ""}
        </div>
        <div class="panel-title"><h3>Deep Research</h3><span class="badge neutral">${researchJobs.length} 预留</span></div>
        <div class="insight-list"><div class="insight-row">摄入时生成的研究任务（D6 接口预留，暂不执行）：${researchJobs.length ? researchJobs.slice(0, 3).map((job) => `<div class="mono">${escapeHtml(job.topic.slice(0, 60))}</div>`).join("") : "无"}</div></div>
      </aside>
    </div>`;

  document.querySelector("#wiki-kb").addEventListener("change", (event) => {
    state.kbId = event.target.value;
    state.wikiPage = "";
    state.wikiEditDraft = null;
    render();
  });
  document.querySelectorAll("[data-wiki-page]").forEach((button) => button.addEventListener("click", () => {
    state.wikiPage = button.dataset.wikiPage;
    state.wikiEditDraft = null;
    render();
  }));
  document.querySelectorAll("[data-wiki-jump]").forEach((button) => button.addEventListener("click", () => {
    const target = String(button.dataset.wikiJump ?? "").trim();
    // Resolve [[short-name]] wikilinks by basename (e.g. [[向顶天]] ->
    // entities/向顶天.md) as well as full paths. Never fall back to the first
    // page: an unresolved target keeps the current page and shows a hint.
    const base = target.split("/").pop().replace(/\.md$/i, "");
    const exact = pages.find((page) => page.path === target || page.path === `${target}.md`
      || page.path.split("/").pop().replace(/\.md$/i, "") === base);
    if (exact) {
      state.wikiPage = exact.path;
      state.wikiEditDraft = null;
      render();
    } else {
      toast(`页面不存在：${target}`);
    }
  }));
  document.querySelector("#wiki-purp")?.addEventListener("click", () => {
    const text = `# purpose.md\n\n${purpose.content}\n\n# schema.md\n\n${schema.content}`;
    alert(text.slice(0, 4000));
  });
  document.querySelector("#wiki-export")?.addEventListener("click", async () => {
    try {
      const response = await fetch(`/api/knowledge-bases/${selected.id}/export`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`导出失败 (${response.status})`);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename="?([^";]+)"?/.exec(disposition);
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = match?.[1] ?? "wiki.zip";
      anchor.click();
      URL.revokeObjectURL(anchor.href);
      toast("Wiki 快照已导出（Obsidian 兼容 zip）");
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#wiki-sync")?.addEventListener("click", async () => {
    try {
      const result = await api(`/api/knowledge-bases/${selected.id}/sync`, { method: "POST" });
      toast(result.synced ? `已同步 ${result.files} 个文件 → ${result.kb_dir}` : `同步未启用：${result.reason}`);
    } catch (error) { toast(error.message); }
  });
  document.querySelector("#wiki-edit")?.addEventListener("click", () => {
    if (!inspected) return;
    state.wikiEditDraft = { path: inspected.path, content: inspectedContent };
    render();
  });
  document.querySelector("#wiki-edit-cancel")?.addEventListener("click", () => { state.wikiEditDraft = null; render(); });
  document.querySelector("#wiki-edit-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const content = document.querySelector("#wiki-edit-content").value;
      const result = await api(`/api/knowledge-bases/${selected.id}/changes`, { method: "POST", body: {
        path: state.wikiEditDraft.path, content, author: "local-user",
      } });
      state.wikiEditDraft = null;
      toast(result.auto_merged ? `已自动发布 v${result.auto_merged.version}` : "页面修改已进入待合并队列");
      render();
    } catch (error) { toast(error.message); }
  });
  const redrawGraph = () => drawKnowledgeGraph(graph, {
    onOpenPage: (node) => {
      const pagePath = node.document_path || node.label;
      if (pages.some((page) => page.path === pagePath)) {
        state.wikiPage = pagePath;
        state.wikiEditDraft = null;
        render();
      }
    },
  });
  if (graph.nodes.length) requestAnimationFrame(redrawGraph);
  wireGraphToolbar(redrawGraph);
}

function frontmatterBadges(page) {
  const badges = [];
  if (page.page_type) badges.push(`<span class="badge neutral">${escapeHtml(page.page_type)}</span>`);
  if (page.confidence) badges.push(`<span class="badge ${page.confidence === "EXTRACTED" ? "" : page.confidence === "INFERRED" ? "warn" : "error"}">${escapeHtml(page.confidence)}</span>`);
  for (const source of page.sources ?? []) badges.push(`<span class="badge" title="溯源">${escapeHtml(source)}</span>`);
  return badges.join(" ");
}

function insightSection(title, items) {
  if (!items?.length) return "";
  return `<div class="insight-row"><strong>${title}</strong></div>${items.slice(0, 8).map((item) => `<button class="link-button" data-wiki-jump="${attr(item.path ?? item.id)}">${escapeHtml(item.path ?? item.id)}</button>`).join("")}`;
}

function renderMarkdown(markdown) {
  const text = String(markdown ?? "");
  const body = stripFrontmatter(text);
  const lines = body.split("\n");
  const html = [];
  let list = null;
  let code = null;
  let codeBuffer = [];
  const flushList = () => { if (list) { html.push("</ul>"); list = null; } };
  for (const line of lines) {
    if (code !== null) {
      if (line.trim() === "```") { html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`); code = null; codeBuffer = []; }
      else codeBuffer.push(line);
      continue;
    }
    if (line.trim().startsWith("```")) { flushList(); code = line.trim().slice(3) || ""; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flushList(); html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); continue; }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      if (list !== "ul") { flushList(); list = "ul"; html.push("<ul>"); }
      html.push(`<li>${inlineMarkdown(item[1])}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  flushList();
  if (codeBuffer.length) html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  return html.join("");
}

function stripFrontmatter(markdown) {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(String(markdown ?? ""));
  return match ? String(markdown).slice(match[0].length) : String(markdown ?? "");
}

function inlineMarkdown(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, '<button class="link-button" data-wiki-jump="$1">[[$1]]</button>');
}

function nodeColor(node, communities) {
  const byKind = { document: "#087f6d", heading: "#3f6f93", tag: "#c28b16", reference: "#9b5c74" };
  if (node.kind === "document" && communities && communities.length) {
    return COMMUNITY_PALETTE[(node.community ?? 0) % COMMUNITY_PALETTE.length];
  }
  return byKind[node.kind] ?? "#66716e";
}

function drawKnowledgeGraph(graph, options = {}) {
  const canvas = document.querySelector("#knowledge-graph");
  if (!canvas) return;
  drawForceGraph(canvas, graph, { showHeadings: state.showHeadings, ...options });
}

function graphToolbarButtons() {
  const checked = state.showHeadings ? "checked" : "";
  return `<div class="graph-toolbar" role="group" aria-label="图谱控制">
    <input class="graph-search" data-graph-search type="search" placeholder="搜索节点（Enter 定位）" aria-label="图谱搜索">
    <button type="button" class="button secondary compact-button" data-graph-zoom="in" title="放大">+</button>
    <button type="button" class="button secondary compact-button" data-graph-zoom="out" title="缩小">-</button>
    <button type="button" class="button secondary compact-button" data-graph-fit title="适应窗口">适应</button>
    <label class="switch-row" title="显示/隐藏标题节点"><input type="checkbox" data-graph-headings ${checked}> 标题节点</label>
  </div>`;
}

function wireGraphToolbar(redraw) {
  const graphView = () => {
    const canvas = document.querySelector("#knowledge-graph");
    if (canvas?.__forceGraph) return canvas.__forceGraph;
    redraw(); // ensure the view exists (e.g. first paint raced the binding)
    return canvas?.__forceGraph ?? null;
  };
  document.querySelectorAll("[data-graph-zoom]").forEach((button) => button.addEventListener("click", () => {
    const canvas = document.querySelector("#knowledge-graph");
    const view = graphView();
    if (!view || !canvas) return;
    const box = canvas.getBoundingClientRect();
    view.zoomAround(box.width / 2, box.height / 2, button.dataset.graphZoom === "in" ? 1.25 : 0.8);
    view.draw();
  }));
  document.querySelectorAll("[data-graph-fit]").forEach((button) => button.addEventListener("click", () => {
    graphView()?.fit();
  }));
  document.querySelectorAll("[data-graph-headings]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    state.showHeadings = checkbox.checked;
    redraw();
  }));
  document.querySelectorAll("[data-graph-search]").forEach((input) => {
    input.addEventListener("input", () => {
      const view = document.querySelector("#knowledge-graph")?.__forceGraph;
      view?.search(input.value);
    });
    input.addEventListener("keydown", (event) => {
      const view = document.querySelector("#knowledge-graph")?.__forceGraph;
      if (event.key === "Enter") {
        const node = view?.selectFirstMatch();
        if (node) input.blur();
      } else if (event.key === "Escape") {
        view?.clearSearch();
        input.value = "";
      }
    });
  });
}

function shortTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"; }
function money(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "-";
  try { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: currency || "USD", maximumFractionDigits: 4 }).format(Number(value)); }
  catch { return `${Number(value).toFixed(4)} ${currency || ""}`.trim(); }
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]); }
function attr(value) { return escapeHtml(value); }
function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2400);
}

async function bootstrap() {
  try {
    const session = await api("/api/auth/session");
    if (session.authenticated) {
      setAdmin(session.user);
      await render();
    } else showAuthGate();
  } catch (error) {
    showAuthGate();
    document.querySelector("#login-error").textContent = error.message;
  }
}

bootstrap();
