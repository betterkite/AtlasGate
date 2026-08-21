export const KNOWLEDGE_TABS = ["changes", "versions", "documents", "import", "graph", "conflicts", "wiki", "ingest", "reviews", "lint"];

export function activateKnowledgeTab(root, tab) {
  const selected = KNOWLEDGE_TABS.includes(tab) ? tab : "changes";
  root.querySelectorAll("[data-knowledge-tab]").forEach((button) => {
    const active = button.dataset.knowledgeTab === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll("[data-knowledge-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.knowledgePanel !== selected;
  });
  return selected;
}
