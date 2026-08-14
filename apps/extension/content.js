(() => {
  const SCHEMA_VERSION = "0.2.0-draft";
  const COLLECTOR_VERSION = "0.2.0";
  const QUIET_PERIOD_MS = 1500;
  const state = { measuring: false, runId: null, startedAt: null, endedAt: null, baselineKeys: new Set(), records: new Map(), warnings: [], contexts: [], contextEvents: [], currentContext: null, observer: null, scanTimer: null, quietTimer: null, lastMutationAt: null };

  const now = () => new Date().toISOString();
  const makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const hashText = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  };

  function messageNodes() {
    const explicit = [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
    return explicit.length ? explicit : [...document.querySelectorAll("main article")].filter((node) => textOf(node));
  }
  function roleOf(node) {
    const role = node.getAttribute("data-message-author-role");
    if (["user", "assistant"].includes(role)) return role;
    const label = (node.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("you said") || label.includes("사용자")) return "user";
    if (label.includes("chatgpt") || node.querySelector('[data-message-author-role="assistant"]')) return "assistant";
    return "unknown";
  }
  function nodeKey(node, index) {
    const id = node.closest("[data-message-id]")?.getAttribute("data-message-id");
    return id ? `message:${id}` : `${roleOf(node)}:${index}:${hashText(textOf(node).slice(0, 500))}`;
  }
  const currentNodeKeys = () => new Set(messageNodes().map(nodeKey));

  function linksFrom(node) {
    return [...node.querySelectorAll("a[href]")].map((anchor, index) => ({ link_id: `link_${index + 1}`, text: textOf(anchor) || null, href: anchor.href, title: anchor.getAttribute("title"), aria_label: anchor.getAttribute("aria-label"), rel: anchor.getAttribute("rel") }));
  }
  function citationGroupKey(item) {
    const href = item.href || item.querySelector?.("a[href]")?.href;
    if (href) {
      try { const url = new URL(href); url.searchParams.delete("utm_source"); return `url:${url.href}`; } catch (_) { return `url:${href}`; }
    }
    return `text:${textOf(item).replace(/\s*\+\d+$/, "").trim() || "unknown"}`;
  }
  function citationsFrom(node) {
    const selector = '[data-citation], [data-testid*=citation], button[aria-label*=source i], button[aria-label*=citation i]';
    const explicit = [...node.querySelectorAll(selector)];
    const links = [...node.querySelectorAll("a[href]")].filter((link) => link.closest(selector) || explicit.some((item) => textOf(item) && textOf(item) === textOf(link)));
    const groups = new Map();
    return [...new Set([...explicit, ...links])].map((item, index) => {
      const key = citationGroupKey(item);
      if (!groups.has(key)) groups.set(key, `citation_group_${groups.size + 1}`);
      return { citation_id: `citation_${index + 1}`, group_id: groups.get(key), element_type: item.matches('[data-testid*=citation]') ? "pill" : item.matches("a[href]") ? "link" : "control", tag: item.tagName.toLowerCase(), text: textOf(item) || null, href: item.href || item.querySelector?.("a[href]")?.href || null, aria_label: item.getAttribute("aria-label"), data_citation: item.getAttribute("data-citation"), data_testid: item.getAttribute("data-testid") };
    });
  }
  function safeHtml(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("script, style, input, textarea, [contenteditable=true]").forEach((element) => element.remove());
    clone.querySelectorAll("*").forEach((element) => [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || ["nonce", "value", "srcset"].includes(name)) element.removeAttribute(attribute.name);
    }));
    return clone.outerHTML;
  }

  function visibleTemporaryLabel() {
    const patterns = ["임시 채팅", "temporary chat", "暫時聊天", "临时聊天"];
    const nodes = [...document.querySelectorAll("header button, header [aria-label], main button, nav button")];
    return nodes.map((node) => textOf(node) || node.getAttribute("aria-label") || "").find((text) => patterns.some((pattern) => text.toLowerCase().includes(pattern))) || null;
  }
  function chatModeEvidence() {
    const urlTemporary = new URL(location.href).searchParams.get("temporary-chat") === "true";
    const visibleLabel = visibleTemporaryLabel();
    return { chat_mode: urlTemporary || visibleLabel ? "temporary" : "regular", evidence: { url_temporary_chat: urlTemporary, visible_label: visibleLabel, classification_source: urlTemporary && visibleLabel ? "url_and_dom" : urlTemporary ? "url" : visibleLabel ? "dom" : "url_absence" } };
  }
  function displayedModel() {
    for (const selector of ['button[data-testid="model-switcher-dropdown-button"]', 'button[aria-label*="model" i]', 'button[aria-label*="모델" i]']) {
      const text = textOf(document.querySelector(selector)); if (text) return text;
    }
    return null;
  }
  function contextSignature() {
    const url = new URL(location.href);
    return `${url.pathname.match(/^\/c\/([^/]+)/)?.[1] || url.pathname}|${chatModeEvidence().chat_mode}|${url.searchParams.get("temporary-chat") || ""}`;
  }
  function contextSnapshot() {
    const mode = chatModeEvidence();
    return { context_id: makeId("context"), first_seen_at: now(), last_seen_at: now(), chat_mode: mode.chat_mode, chat_mode_evidence: mode.evidence, conversation_url: location.href, conversation_id_candidate: new URL(location.href).pathname.match(/^\/c\/([^/]+)/)?.[1] || null, signature: contextSignature() };
  }
  function openContext(reason, force = false) {
    if (!state.measuring) return;
    const next = contextSnapshot();
    if (!force && state.currentContext?.signature === next.signature) { state.currentContext.last_seen_at = now(); return; }
    const previous = state.currentContext;
    if (!force && previous && previous.chat_mode === next.chat_mode && !previous.conversation_id_candidate && next.conversation_id_candidate) {
      previous.last_seen_at = now();
      previous.conversation_url = next.conversation_url;
      previous.conversation_id_candidate = next.conversation_id_candidate;
      previous.signature = next.signature;
      return;
    }
    if (previous) previous.last_seen_at = now();
    state.currentContext = next; state.contexts.push(next); state.baselineKeys = currentNodeKeys();
    if (previous) state.contextEvents.push({ event_id: makeId("event"), event_type: "chat_context_changed", captured_at: now(), from_context_id: previous.context_id, to_context_id: next.context_id, evidence: { reason, url_changed: previous.conversation_url !== next.conversation_url, mode_changed: previous.chat_mode !== next.chat_mode } });
  }
  function addWarning(code, message) {
    const contextId = state.currentContext?.context_id || null;
    if (!state.warnings.some((warning) => warning.code === code && warning.context_id === contextId)) state.warnings.push({ warning_id: makeId("warning"), code, message, captured_at: now(), context_id: contextId });
  }

  function scan() {
    if (!state.measuring) return;
    if (!state.currentContext || state.currentContext.signature !== contextSignature()) openContext("url_or_mode_changed");
    if (state.currentContext) state.currentContext.last_seen_at = now();
    for (const [index, node] of messageNodes().entries()) {
      const key = nodeKey(node, index); if (state.baselineKeys.has(key)) continue;
      const text = textOf(node); if (!text) continue;
      const recordKey = `${state.currentContext.context_id}:${key}`;
      const existing = state.records.get(recordKey); const role = roleOf(node);
      state.records.set(recordKey, { candidate_id: existing?.candidate_id || makeId("candidate"), context_id: state.currentContext.context_id, role, text, html: safeHtml(node), first_seen_at: existing?.first_seen_at || now(), last_updated_at: now(), completion_state: role === "assistant" && Date.now() - (state.lastMutationAt || Date.now()) >= QUIET_PERIOD_MS ? "quiet_candidate" : "unknown", completion_evidence: role === "assistant" ? { quiet_period_ms: QUIET_PERIOD_MS } : null, link_candidates: linksFrom(node), citation_candidates: citationsFrom(node) });
    }
  }
  function scheduleScan() {
    state.lastMutationAt = Date.now(); clearTimeout(state.scanTimer); clearTimeout(state.quietTimer);
    state.scanTimer = setTimeout(scan, 250); state.quietTimer = setTimeout(scan, QUIET_PERIOD_MS + 50);
  }
  function start() {
    if (state.measuring) return status();
    Object.assign(state, { measuring: true, runId: makeId("run"), startedAt: now(), endedAt: null, baselineKeys: new Set(), warnings: [], contexts: [], contextEvents: [], currentContext: null });
    state.records.clear(); openContext("measurement_started", true);
    state.observer = new MutationObserver(scheduleScan);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "aria-label", "data-testid", "data-citation"] });
    return status();
  }
  function stop() {
    scan(); state.measuring = false; state.endedAt = now(); if (state.currentContext) state.currentContext.last_seen_at = state.endedAt;
    state.observer?.disconnect(); state.observer = null; clearTimeout(state.scanTimer); clearTimeout(state.quietTimer); return status();
  }
  function status() {
    return { measuring: state.measuring, run_id: state.runId, started_at: state.startedAt, candidate_count: state.records.size, context_count: state.contexts.length, chat_mode: state.currentContext?.chat_mode || null, warning_count: state.warnings.length };
  }
  function buildTurns() {
    const turns = []; const currentByContext = new Map();
    for (const candidate of state.records.values()) {
      let current = currentByContext.get(candidate.context_id);
      if (candidate.role === "user") {
        current = { turn_id: makeId("turn"), context_id: candidate.context_id, turn_index: turns.filter((turn) => turn.context_id === candidate.context_id).length + 1, first_seen_at: candidate.first_seen_at, prompt: candidate, response_candidates: [] };
        turns.push(current); currentByContext.set(candidate.context_id, current);
      } else if (current) current.response_candidates.push(candidate);
      else { current = { turn_id: makeId("turn"), context_id: candidate.context_id, turn_index: turns.filter((turn) => turn.context_id === candidate.context_id).length + 1, first_seen_at: candidate.first_seen_at, prompt: null, response_candidates: [candidate] }; turns.push(current); currentByContext.set(candidate.context_id, current); }
    }
    return turns;
  }
  function observation() {
    scan(); const capturedAt = now(); const model = displayedModel();
    if (!model) addWarning("displayed_model_not_found", "표시된 모델을 확인하지 못했습니다.");
    return { schema_version: SCHEMA_VERSION, observation_id: makeId("obs"), run_id: state.runId, surface: "chatgpt_web", captured_at: capturedAt, measurement_started_at: state.startedAt, measurement_ended_at: state.endedAt || capturedAt, environment: { page_url: location.href, page_title: document.title, locale: document.documentElement.lang || navigator.language || null, displayed_model: model, displayed_mode: model }, chat_contexts: state.contexts.map(({ signature, ...context }) => context), context_events: state.contextEvents, turn_candidates: buildTurns(), capture_warnings: state.warnings, collector: { name: "chatgpt-web", version: COLLECTOR_VERSION } };
  }

  window.addEventListener("popstate", () => { if (state.measuring) setTimeout(scan, 100); });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "observer:start") sendResponse({ ok: true, data: start() });
      else if (message?.type === "observer:stop") sendResponse({ ok: true, data: stop() });
      else if (message?.type === "observer:status") sendResponse({ ok: true, data: status() });
      else if (message?.type === "observer:export") sendResponse({ ok: true, data: observation() });
      else sendResponse({ ok: false, error: "알 수 없는 요청입니다." });
    } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    return true;
  });
})();
