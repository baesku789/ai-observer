(() => {
  const COLLECTOR_VERSION = "0.1.0";
  const QUIET_PERIOD_MS = 1500;
  const state = {
    measuring: false,
    runId: null,
    startedAt: null,
    baselineKeys: new Set(),
    records: new Map(),
    warnings: [],
    observer: null,
    scanTimer: null,
    lastMutationAt: null
  };

  const now = () => new Date().toISOString();
  const makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const normalizedText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const hashText = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  function messageNodes() {
    const explicit = [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
    if (explicit.length) return explicit;
    return [...document.querySelectorAll("main article")].filter((node) => normalizedText(node));
  }

  function roleOf(node) {
    const explicit = node.getAttribute("data-message-author-role");
    if (explicit === "user" || explicit === "assistant") return explicit;
    const label = (node.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("you said") || label.includes("사용자")) return "user";
    if (label.includes("chatgpt") || node.querySelector('[data-message-author-role="assistant"]')) return "assistant";
    return "unknown";
  }

  function nodeKey(node, index) {
    const messageId = node.closest("[data-message-id]")?.getAttribute("data-message-id");
    if (messageId) return `message:${messageId}`;
    return `${roleOf(node)}:${index}:${hashText(normalizedText(node).slice(0, 500))}`;
  }

  function linksFrom(node) {
    return [...node.querySelectorAll("a[href]")].map((anchor, index) => ({
      link_id: `link_${index + 1}`,
      text: normalizedText(anchor) || null,
      href: anchor.href,
      title: anchor.getAttribute("title"),
      aria_label: anchor.getAttribute("aria-label"),
      rel: anchor.getAttribute("rel")
    }));
  }

  function citationsFrom(node) {
    const candidates = [...node.querySelectorAll("a[href], [data-citation], [data-testid*=citation], button[aria-label*=source i], button[aria-label*=citation i]")];
    return [...new Set(candidates)].map((item, index) => ({
      citation_id: `citation_${index + 1}`,
      tag: item.tagName.toLowerCase(),
      text: normalizedText(item) || null,
      href: item.href || null,
      aria_label: item.getAttribute("aria-label"),
      data_citation: item.getAttribute("data-citation"),
      data_testid: item.getAttribute("data-testid")
    }));
  }

  function safeHtml(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("script, style, input, textarea, [contenteditable=true]").forEach((element) => element.remove());
    clone.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || ["nonce", "value", "srcset"].includes(name)) element.removeAttribute(attribute.name);
      });
    });
    return clone.outerHTML;
  }

  function displayedMode() {
    const selectors = [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[aria-label*="model" i]',
      'button[aria-label*="모델" i]'
    ];
    for (const selector of selectors) {
      const text = normalizedText(document.querySelector(selector));
      if (text) return text;
    }
    return null;
  }

  function addWarning(code, message) {
    if (state.warnings.some((warning) => warning.code === code)) return;
    state.warnings.push({ code, message, captured_at: now() });
  }

  function scan() {
    if (!state.measuring) return;
    const nodes = messageNodes();
    if (!nodes.length) addWarning("message_nodes_not_found", "질문/답변 후보 노드를 찾지 못했습니다. ChatGPT DOM 변경 가능성을 확인하세요.");
    nodes.forEach((node, index) => {
      const key = nodeKey(node, index);
      if (state.baselineKeys.has(key)) return;
      const text = normalizedText(node);
      if (!text) return;
      const existing = state.records.get(key);
      state.records.set(key, {
        candidate_id: existing?.candidate_id || makeId("candidate"),
        role: roleOf(node),
        text,
        html: safeHtml(node),
        first_seen_at: existing?.first_seen_at || now(),
        last_updated_at: now(),
        completion_state: roleOf(node) === "assistant" && Date.now() - (state.lastMutationAt || Date.now()) >= QUIET_PERIOD_MS ? "quiet_candidate" : "unknown",
        link_candidates: linksFrom(node),
        citation_candidates: citationsFrom(node)
      });
    });
  }

  function scheduleScan() {
    state.lastMutationAt = Date.now();
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      scan();
      setTimeout(scan, QUIET_PERIOD_MS + 50);
    }, 250);
  }

  function start() {
    if (state.measuring) return status();
    state.measuring = true;
    state.runId = makeId("run");
    state.startedAt = now();
    state.records.clear();
    state.warnings = [];
    state.baselineKeys = new Set(messageNodes().map(nodeKey));
    state.observer = new MutationObserver(scheduleScan);
    state.observer.observe(document.querySelector("main") || document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "aria-label", "data-testid", "data-citation"] });
    return status();
  }

  function stop() {
    scan();
    state.measuring = false;
    state.observer?.disconnect();
    state.observer = null;
    clearTimeout(state.scanTimer);
    return status();
  }

  function status() {
    return {
      measuring: state.measuring,
      run_id: state.runId,
      started_at: state.startedAt,
      candidate_count: state.records.size,
      warning_count: state.warnings.length
    };
  }

  function observation() {
    scan();
    const candidates = [...state.records.values()];
    const turns = [];
    let currentTurn = null;
    candidates.forEach((candidate) => {
      if (candidate.role === "user") {
        currentTurn = {
          turn_id: makeId("turn"),
          prompt: candidate,
          response_candidates: []
        };
        turns.push(currentTurn);
      } else if (currentTurn) {
        currentTurn.response_candidates.push(candidate);
      } else {
        turns.push({ turn_id: makeId("turn"), prompt: null, response_candidates: [candidate] });
      }
    });
    return {
      schema_status: "draft",
      observation_id: makeId("obs"),
      run_id: state.runId,
      surface: "chatgpt_web",
      captured_at: now(),
      measurement_started_at: state.startedAt,
      page: { url: location.href, title: document.title, displayed_mode: displayedMode() },
      turn_candidates: turns,
      capture_warnings: state.warnings,
      collector: { name: "chatgpt-web", version: COLLECTOR_VERSION }
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "observer:start") sendResponse({ ok: true, data: start() });
      else if (message?.type === "observer:stop") sendResponse({ ok: true, data: stop() });
      else if (message?.type === "observer:status") sendResponse({ ok: true, data: status() });
      else if (message?.type === "observer:export") sendResponse({ ok: true, data: observation() });
      else sendResponse({ ok: false, error: "알 수 없는 요청입니다." });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });
})();

