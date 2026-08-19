(() => {
  const SCHEMA_VERSION = "0.8.0-draft";
  const COLLECTOR_VERSION = "0.8.0";
  const QUIET_PERIOD_MS = 1500;
  const MODEL_SIGNAL_BEFORE_PROMPT_MS = 120_000;
  const MODEL_SIGNAL_AFTER_PROMPT_MS = 10_000;
  const state = { measuring: false, measurementType: "independent_query", querySet: null, queryRuns: [], activeRunIndex: null, desiredChatMode: "temporary", accountPlan: "unknown", modelSelection: "default", ownerTabId: null, revision: 0, runId: null, startedAt: null, endedAt: null, baselineKeys: new Set(), records: new Map(), warnings: [], contexts: [], contextEvents: [], currentContext: null, conversations: [], conversationEvents: [], currentConversation: null, modelSignals: [], observer: null, scanTimer: null, quietTimer: null, contextTimer: null };

  const now = () => new Date().toISOString();
  const touch = () => { state.revision += 1; };
  const makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const hashText = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  };

  function publicModelObservation(signal) {
    if (!signal) return null;
    return {
      requested_model: signal.requested_model,
      displayed_model: signal.displayed_model,
      detection_source: signal.source,
      captured_at: signal.captured_at,
      client_prepare_dispatch: signal.client_prepare_dispatch,
      client_prepare_source: signal.client_prepare_source,
      history_and_training_disabled: signal.history_and_training_disabled
    };
  }
  function receiveModelSignal(message) {
    if (!state.measuring || message.run_id !== state.runId || !message.signal?.requested_model) return;
    if (state.modelSignals.some((signal) => signal.request_id === message.signal.request_id)) return;
    state.modelSignals.push({
      ...message.signal,
      context_id: state.currentContext?.context_id || null,
      conversation_instance_id: state.currentConversation?.conversation_instance_id || null,
      run_index: state.activeRunIndex
    });
    if (state.modelSignals.length > 200) state.modelSignals.splice(0, state.modelSignals.length - 200);
    touch();
    scheduleScan();
  }
  function modelObservationForPrompt(firstSeenAt, conversationInstanceId) {
    const promptAt = Date.parse(firstSeenAt);
    if (!Number.isFinite(promptAt)) return null;
    const matches = state.modelSignals.filter((signal) => {
      if (conversationInstanceId && signal.conversation_instance_id !== conversationInstanceId) return false;
      const signalAt = Date.parse(signal.captured_at);
      return Number.isFinite(signalAt) && signalAt >= promptAt - MODEL_SIGNAL_BEFORE_PROMPT_MS && signalAt <= promptAt + MODEL_SIGNAL_AFTER_PROMPT_MS;
    });
    matches.sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at));
    return publicModelObservation(matches[0]);
  }
  function latestModelObservation() {
    return publicModelObservation(state.modelSignals.at(-1));
  }

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
  function citationGroupsFrom(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
      if (!groups.has(candidate.group_id)) groups.set(candidate.group_id, { group_id: candidate.group_id, canonical_url: null, text: null, candidate_ids: [], evidence_types: [] });
      const group = groups.get(candidate.group_id);
      group.candidate_ids.push(candidate.citation_id);
      if (!group.evidence_types.includes(candidate.element_type)) group.evidence_types.push(candidate.element_type);
      if (!group.canonical_url && candidate.href) {
        try { const url = new URL(candidate.href); url.searchParams.delete("utm_source"); group.canonical_url = url.href; } catch (_) { group.canonical_url = candidate.href; }
      }
      if (!group.text && candidate.text) group.text = candidate.text.replace(/\s*\+\d+$/, "").trim();
    }
    return [...groups.values()];
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
    const labelMeansActive = Boolean(visibleLabel && /(끄기|turn off|disable|종료)/i.test(visibleLabel));
    const chatMode = urlTemporary || labelMeansActive ? "temporary" : "regular";
    return { chat_mode: chatMode, evidence: { url_temporary_chat: urlTemporary, visible_label: visibleLabel, visible_label_semantics: labelMeansActive ? "disable_temporary_action" : visibleLabel ? "enable_temporary_action" : null, classification_source: urlTemporary && labelMeansActive ? "url_and_dom" : urlTemporary ? "url" : visibleLabel ? "dom_action" : "url_absence" } };
  }
  function uiLabelEvidence(selectors, patterns) {
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = textOf(node) || node.getAttribute("aria-label") || "";
        if (text && (!patterns.length || patterns.some((pattern) => pattern.test(text)))) return { value: text, selector, tag: node.tagName.toLowerCase(), aria_label: node.getAttribute("aria-label"), data_testid: node.getAttribute("data-testid"), html: safeHtml(node).slice(0, 4000) };
      }
    }
    return null;
  }
  function displayedModelEvidence() {
    return uiLabelEvidence(['button[data-testid="model-switcher-dropdown-button"]', '[data-testid*="model-switcher"]', 'header button[aria-haspopup="menu"]', 'header button[aria-label]'], [/gpt/i, /chatgpt/i, /모델/i, /model/i, /o\d/i]);
  }
  function displayedModeEvidence() {
    return uiLabelEvidence(['button[data-testid*="mode"]', '[data-testid*="reasoning"]', 'form button[aria-haspopup="menu"]', 'form button[aria-label]', 'form button'], [/instant/i, /thinking/i, /pro/i, /reason/i, /즉시/i, /빠른/i, /생각/i, /추론/i]);
  }
  function uiLabelCandidates() {
    return [...document.querySelectorAll('header button, header [aria-label], form button[aria-haspopup="menu"], form button[aria-label]')].slice(0, 40).map((node) => ({ text: textOf(node) || null, aria_label: node.getAttribute("aria-label"), data_testid: node.getAttribute("data-testid"), tag: node.tagName.toLowerCase() })).filter((item) => item.text || item.aria_label || item.data_testid);
  }
  function responseControls() {
    const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label*="stop generating" i], button[aria-label*="응답 중지" i]');
    return { stop_control_visible: Boolean(stop), stop_control_text: stop ? textOf(stop) || stop.getAttribute("aria-label") : null };
  }
  function contextSignature() {
    const url = new URL(location.href);
    return `${url.pathname.match(/^\/c\/([^/]+)/)?.[1] || url.pathname}|${chatModeEvidence().chat_mode}|${url.searchParams.get("temporary-chat") || ""}`;
  }
  function contextSnapshot() {
    const mode = chatModeEvidence();
    return { context_id: makeId("context"), first_seen_at: now(), last_seen_at: now(), chat_mode: mode.chat_mode, chat_mode_evidence: mode.evidence, conversation_url: location.href, conversation_title_candidate: document.title && document.title !== "ChatGPT" ? document.title : null, page_title: document.title || null, conversation_id_candidate: new URL(location.href).pathname.match(/^\/c\/([^/]+)/)?.[1] || null, signature: contextSignature() };
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
    if (previous) {
      previous.last_seen_at = now();
      for (const record of state.records.values()) {
        if (record.context_id !== previous.context_id || record.role !== "assistant") continue;
        const quietForMs = Date.now() - Date.parse(record.last_text_changed_at);
        if (quietForMs >= QUIET_PERIOD_MS) {
          record.completion_state = "quiet_candidate";
          record.completion_evidence = { ...record.completion_evidence, text_quiet_for_ms: quietForMs, stop_control_visible: false, stop_control_text: null, context_closed: true };
        }
      }
    }
    state.currentContext = next; state.contexts.push(next); state.baselineKeys = currentNodeKeys();
    if (state.currentConversation) {
      if (!state.currentConversation.context_ids.includes(next.context_id)) state.currentConversation.context_ids.push(next.context_id);
      if (!state.currentConversation.chat_modes.includes(next.chat_mode)) state.currentConversation.chat_modes.push(next.chat_mode);
    }
    if (previous) state.contextEvents.push({ event_id: makeId("event"), event_type: "chat_context_changed", captured_at: now(), from_context_id: previous.context_id, to_context_id: next.context_id, evidence: { reason, url_changed: previous.conversation_url !== next.conversation_url, mode_changed: previous.chat_mode !== next.chat_mode } });
  }
  function addWarning(code, message) {
    const contextId = state.currentContext?.context_id || null;
    if (!state.warnings.some((warning) => warning.code === code && warning.context_id === contextId)) state.warnings.push({ warning_id: makeId("warning"), code, message, captured_at: now(), context_id: contextId });
  }

  function openConversation(boundarySource, queryMetadata = null, runIndex = null) {
    if (!state.measuring) return status();
    const capturedAt = now();
    const previous = state.currentConversation;
    if (previous) previous.ended_at = capturedAt;
    const conversation = {
      conversation_instance_id: makeId("conversation"),
      started_at: capturedAt,
      ended_at: null,
      boundary_source: boundarySource,
      query: queryMetadata,
      run_index: runIndex,
      manual_completion: null,
      context_ids: state.currentContext ? [state.currentContext.context_id] : [],
      chat_modes: state.currentContext ? [state.currentContext.chat_mode] : []
    };
    state.currentConversation = conversation;
    if (Number.isInteger(runIndex)) state.activeRunIndex = runIndex;
    state.conversations.push(conversation);
    state.baselineKeys = currentNodeKeys();
    if (previous) state.conversationEvents.push({ event_id: makeId("event"), event_type: "conversation_boundary_confirmed", captured_at: capturedAt, from_conversation_instance_id: previous.conversation_instance_id, to_conversation_instance_id: conversation.conversation_instance_id, boundary_source: boundarySource });
    touch();
    return status();
  }

  function confirmNewChat() {
    if (!state.measuring) throw new Error("먼저 측정을 시작하세요.");
    if (state.measurementType !== "independent_query") return openConversation("user_confirmed_new_chat");
    const currentStatus = status();
    if (currentStatus.phase !== "awaiting_new_chat") throw new Error("지금은 새 채팅을 확인할 단계가 아닙니다.");
    if (messageNodes().some((node) => textOf(node))) throw new Error("현재 탭에서 새 채팅을 먼저 열어 대화 화면을 비워 주세요.");
    const nextIndex = state.activeRunIndex === null ? 0 : state.activeRunIndex + 1;
    if (nextIndex >= state.queryRuns.length) throw new Error("모든 질문 측정이 완료되었습니다.");
    return openConversation("user_confirmed_new_chat", state.queryRuns[nextIndex], nextIndex);
  }

  function scan() {
    if (!state.measuring) return;
    if (!state.currentContext || state.currentContext.signature !== contextSignature()) openContext("url_or_mode_changed");
    if (state.currentContext) state.currentContext.last_seen_at = now();
    if (state.measurementType === "independent_query" && !state.currentConversation) return;
    const nodes = messageNodes();
    const latestAssistant = [...nodes].reverse().find((node) => roleOf(node) === "assistant") || null;
    let changed = false;
    for (const [index, node] of nodes.entries()) {
      const key = nodeKey(node, index); if (state.baselineKeys.has(key)) continue;
      const text = textOf(node); if (!text) continue;
      const recordKey = `${state.currentContext.context_id}:${key}`;
      const existing = state.records.get(recordKey); const role = roleOf(node); const capturedAt = now();
      const textChanged = !existing || existing.text !== text;
      const lastTextChangedAt = textChanged ? capturedAt : existing.last_text_changed_at;
      const quietForMs = Date.now() - Date.parse(lastTextChangedAt);
      const controls = role === "assistant" && node === latestAssistant ? responseControls() : { stop_control_visible: false, stop_control_text: null };
      const citationCandidates = citationsFrom(node);
      const completionState = role !== "assistant" ? null : quietForMs >= QUIET_PERIOD_MS && !controls.stop_control_visible ? "quiet_candidate" : "streaming_or_unsettled";
      const conversationInstanceId = existing?.conversation_instance_id || state.currentConversation?.conversation_instance_id || null;
      const firstSeenAt = existing?.first_seen_at || capturedAt;
      const modelObservation = role === "user" ? modelObservationForPrompt(firstSeenAt, conversationInstanceId) : null;
      state.records.set(recordKey, { candidate_id: existing?.candidate_id || makeId("candidate"), context_id: state.currentContext.context_id, conversation_instance_id: conversationInstanceId, role, text, html: safeHtml(node), first_seen_at: firstSeenAt, last_updated_at: textChanged ? capturedAt : existing.last_updated_at, last_text_changed_at: lastTextChangedAt, completion_state: completionState, completion_evidence: role === "assistant" ? { text_quiet_for_ms: quietForMs, required_quiet_period_ms: QUIET_PERIOD_MS, ...controls } : null, model_observation: modelObservation, link_candidates: linksFrom(node), citation_candidates: citationCandidates, citation_groups: citationGroupsFrom(citationCandidates) });
      if (!existing || textChanged || existing.completion_state !== completionState || existing.model_observation?.requested_model !== modelObservation?.requested_model) changed = true;
    }
    if (changed) touch();
  }
  function scheduleScan() {
    clearTimeout(state.scanTimer); clearTimeout(state.quietTimer);
    state.scanTimer = setTimeout(scan, 250); state.quietTimer = setTimeout(scan, QUIET_PERIOD_MS + 50);
  }
  function start(measurementType = "independent_query", querySet = null, queryRuns = [], desiredChatMode = "temporary", accountPlan = "unknown", modelSelection = "default", ownerTabId = null) {
    if (state.measuring) return status();
    if (!["independent_query", "conversation_journey"].includes(measurementType)) throw new Error("지원하지 않는 측정 유형입니다.");
    if (measurementType === "independent_query" && !queryRuns.length) throw new Error("측정할 질문을 한 개 이상 입력하세요.");
    if (!["temporary", "regular"].includes(desiredChatMode)) throw new Error("지원하지 않는 채팅 모드입니다.");
    if (!["free", "plus", "max", "work", "unknown"].includes(accountPlan)) throw new Error("지원하지 않는 계정 플랜입니다.");
    if (!["default", "manually_selected"].includes(modelSelection)) throw new Error("지원하지 않는 모델 선택 방식입니다.");
    Object.assign(state, { measuring: true, measurementType, querySet, queryRuns, activeRunIndex: null, desiredChatMode, accountPlan, modelSelection, ownerTabId, revision: state.revision + 1, runId: makeId("run"), startedAt: now(), endedAt: null, baselineKeys: new Set(), warnings: [], contexts: [], contextEvents: [], currentContext: null, conversations: [], conversationEvents: [], currentConversation: null, modelSignals: [] });
    state.records.clear(); openContext("measurement_started", true);
    if (measurementType === "conversation_journey") openConversation("measurement_started");
    state.observer = new MutationObserver(scheduleScan);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "aria-label", "data-testid", "data-citation"] });
    state.contextTimer = setInterval(scan, 1000);
    return status();
  }
  function stop() {
    scan(); state.measuring = false; state.endedAt = now(); if (state.currentContext) state.currentContext.last_seen_at = state.endedAt;
    if (state.currentConversation) state.currentConversation.ended_at = state.endedAt;
    state.observer?.disconnect(); state.observer = null; clearTimeout(state.scanTimer); clearTimeout(state.quietTimer); clearInterval(state.contextTimer); state.contextTimer = null; touch(); return status();
  }
  function markResponseComplete() {
    if (!state.measuring || !state.currentConversation) throw new Error("완료로 표시할 답변이 없습니다.");
    const conversationId = state.currentConversation.conversation_instance_id;
    const currentRecords = [...state.records.values()].filter((record) => record.conversation_instance_id === conversationId);
    if (!currentRecords.some((record) => record.role === "user")) throw new Error("먼저 질문을 입력하세요.");
    state.currentConversation.manual_completion = { completed_at: now(), source: "user_confirmed" };
    touch();
    return status();
  }
  function status() {
    const conversationId = state.currentConversation?.conversation_instance_id || null;
    const currentRecords = [...state.records.values()].filter((record) => record.conversation_instance_id === conversationId);
    const promptCount = currentRecords.filter((record) => record.role === "user").length;
    const latestResponse = currentRecords.filter((record) => record.role === "assistant").at(-1) || null;
    const manuallyComplete = Boolean(state.currentConversation?.manual_completion);
    const responseComplete = manuallyComplete || latestResponse?.completion_state === "quiet_candidate";
    const currentModel = latestModelObservation();
    let phase = "idle";
    if (!state.measuring && state.runId) phase = "stopped";
    else if (state.measuring && state.measurementType === "conversation_journey") phase = responseComplete ? "response_complete" : promptCount ? "collecting_response" : "ready_to_send";
    else if (state.measuring && !state.currentConversation) phase = "awaiting_new_chat";
    else if (state.measuring && promptCount === 0 && state.currentContext?.chat_mode !== state.desiredChatMode) phase = "awaiting_chat_mode";
    else if (state.measuring && promptCount === 0) phase = "ready_to_send";
    else if (state.measuring && !responseComplete) phase = "collecting_response";
    else if (state.measuring && state.activeRunIndex >= state.queryRuns.length - 1) phase = "completed";
    else if (state.measuring) phase = "awaiting_new_chat";
    const nextRunIndex = state.activeRunIndex === null ? 0 : responseComplete ? state.activeRunIndex + 1 : null;
    const allRecords = [...state.records.values()];
    return {
      measuring: state.measuring,
      phase,
      revision: state.revision,
      collector_version: COLLECTOR_VERSION,
      measurement_type: state.measurementType,
      run_id: state.runId,
      started_at: state.startedAt,
      owner_tab_id: state.ownerTabId,
      tab_scope: "single_tab",
      desired_chat_mode: state.desiredChatMode,
      account_plan: state.accountPlan,
      model_selection: state.modelSelection,
      chat_mode: state.currentContext?.chat_mode || null,
      active_run_index: state.activeRunIndex,
      next_run_index: nextRunIndex < state.queryRuns.length ? nextRunIndex : null,
      total_runs: state.queryRuns.length,
      active_query: Number.isInteger(state.activeRunIndex) ? state.queryRuns[state.activeRunIndex] : null,
      next_query: Number.isInteger(nextRunIndex) && nextRunIndex < state.queryRuns.length ? state.queryRuns[nextRunIndex] : null,
      question_count: allRecords.filter((record) => record.role === "user").length,
      answer_count: allRecords.filter((record) => record.role === "assistant").length,
      conversation_count: state.conversations.length,
      conversation_instance_id: conversationId,
      current_query: state.currentConversation?.query || null,
      current_conversation_prompt_count: promptCount,
      current_conversation_response_state: latestResponse?.completion_state || null,
      current_conversation_complete: responseComplete,
      completion_source: manuallyComplete ? "user_confirmed" : responseComplete ? "collector_quiet_period" : null,
      assistant_response_seen: Boolean(latestResponse),
      current_requested_model: currentModel?.requested_model || null,
      current_displayed_model: currentModel?.displayed_model || null,
      model_detection_source: currentModel ? "network_request" : null,
      warning_count: state.warnings.length
    };
  }
  function buildTurns() {
    const turns = []; const currentByConversation = new Map();
    for (const candidate of state.records.values()) {
      const groupingId = candidate.conversation_instance_id || candidate.context_id;
      let current = currentByConversation.get(groupingId);
      if (candidate.role === "user") {
        const { model_observation: modelObservation, ...prompt } = candidate;
        current = { turn_id: makeId("turn"), context_id: candidate.context_id, conversation_instance_id: candidate.conversation_instance_id, turn_index: turns.filter((turn) => (turn.conversation_instance_id || turn.context_id) === groupingId).length + 1, first_seen_at: candidate.first_seen_at, model_observation: modelObservation || null, prompt, response_candidates: [] };
        turns.push(current); currentByConversation.set(groupingId, current);
      } else if (current) current.response_candidates.push(candidate);
      else { current = { turn_id: makeId("turn"), context_id: candidate.context_id, conversation_instance_id: candidate.conversation_instance_id, turn_index: turns.filter((turn) => (turn.conversation_instance_id || turn.context_id) === groupingId).length + 1, first_seen_at: candidate.first_seen_at, model_observation: null, prompt: null, response_candidates: [candidate] }; turns.push(current); currentByConversation.set(groupingId, current); }
    }
    return turns;
  }
  function observation() {
    scan(); const capturedAt = now(); const model = displayedModelEvidence(); const mode = displayedModeEvidence(); const networkModel = latestModelObservation();
    if (!model && !networkModel?.displayed_model) addWarning("displayed_model_not_found", "표시된 모델을 네트워크 요청이나 UI에서 확인하지 못했습니다.");
    if (networkModel?.requested_model && !networkModel.displayed_model) addWarning("displayed_model_mapping_not_found", `요청 모델 ${networkModel.requested_model}의 화면 표시명 매핑이 없습니다.`);
    if (!mode) addWarning("displayed_mode_not_found", "표시된 응답 모드를 확인하지 못했습니다. UI 후보 증거를 확인하세요.");
    const turns = buildTurns();
    const normalizedPrompt = (value) => (value || "").replace(/\s+/g, " ").trim();
    const serializedConversations = state.conversations.map((conversation) => {
      const firstPrompt = turns.find((turn) => turn.conversation_instance_id === conversation.conversation_instance_id && turn.prompt)?.prompt?.text || null;
      const expectedPrompt = conversation.query?.expected_prompt || null;
      const promptMatch = !expectedPrompt || !firstPrompt ? "unavailable" : firstPrompt === expectedPrompt ? "exact" : normalizedPrompt(firstPrompt) === normalizedPrompt(expectedPrompt) ? "normalized" : "mismatch";
      return { ...conversation, query: conversation.query ? { ...conversation.query, observed_prompt: firstPrompt, prompt_match: promptMatch } : null };
    });
    if (state.measurementType === "independent_query") {
      for (const conversation of serializedConversations) {
        const count = turns.filter((turn) => turn.conversation_instance_id === conversation.conversation_instance_id && turn.prompt).length;
        if (count !== 1 && !state.warnings.some((warning) => warning.code === "independent_query_turn_count" && warning.conversation_instance_id === conversation.conversation_instance_id)) state.warnings.push({ warning_id: makeId("warning"), code: "independent_query_turn_count", message: `독립 질문 대화에는 질문이 1개여야 하지만 ${count}개가 수집됐습니다.`, captured_at: capturedAt, conversation_instance_id: conversation.conversation_instance_id, observed_turn_count: count });
        if (conversation.query?.prompt_match === "mismatch" && !state.warnings.some((warning) => warning.code === "query_prompt_mismatch" && warning.conversation_instance_id === conversation.conversation_instance_id)) state.warnings.push({ warning_id: makeId("warning"), code: "query_prompt_mismatch", message: "질문 세트의 예상 질문과 실제 질문이 다릅니다.", captured_at: capturedAt, conversation_instance_id: conversation.conversation_instance_id, query_id: conversation.query.query_id, expected_prompt: conversation.query.expected_prompt, observed_prompt: conversation.query.observed_prompt });
      }
    }
    return { schema_version: SCHEMA_VERSION, observation_id: makeId("obs"), run_id: state.runId, surface: "chatgpt_web", captured_at: capturedAt, measurement_started_at: state.startedAt, measurement_ended_at: state.endedAt || capturedAt, measurement: { measurement_type: state.measurementType, boundary_strategy: "user_confirmed_new_chat", tab_scope: "single_tab", desired_chat_mode: state.desiredChatMode, query_set: state.querySet }, environment: { page_url: location.href, page_title: document.title, locale: document.documentElement.lang || navigator.language || null, account_plan: state.accountPlan, model_selection: state.modelSelection, requested_model: networkModel?.requested_model || null, displayed_model: networkModel?.displayed_model || model?.value || null, model_detection_source: networkModel ? "network_request" : model ? "dom" : null, displayed_model_evidence: networkModel || model, displayed_mode: mode?.value || null, displayed_mode_evidence: mode, ui_label_candidates: uiLabelCandidates() }, conversation_instances: serializedConversations, conversation_events: state.conversationEvents, chat_contexts: state.contexts.map(({ signature, ...context }) => context), context_events: state.contextEvents, turn_candidates: turns, capture_warnings: state.warnings, collector: { name: "chatgpt-web", version: COLLECTOR_VERSION } };
  }

  window.addEventListener("popstate", () => { if (state.measuring) setTimeout(scan, 100); });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "observer:network-model-signal") { receiveModelSignal(message); sendResponse({ ok: true }); }
      else if (message?.type === "observer:start") {
        const data = start(message.measurement_type, message.query_set, message.query_runs, message.desired_chat_mode, message.account_plan, message.model_selection, message.owner_tab_id);
        chrome.runtime.sendMessage({ type: "observer:network-capture-start", run_id: state.runId }).then((response) => {
          if (!response?.ok) throw new Error(response?.error || "모델 수집기를 시작하지 못했습니다.");
          sendResponse({ ok: true, data });
        }).catch((error) => { stop(); sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }); });
      }
      else if (message?.type === "observer:confirm-new-chat" || message?.type === "observer:new-conversation") sendResponse({ ok: true, data: confirmNewChat() });
      else if (message?.type === "observer:mark-response-complete") sendResponse({ ok: true, data: markResponseComplete() });
      else if (message?.type === "observer:stop") {
        const data = stop();
        chrome.runtime.sendMessage({ type: "observer:network-capture-stop", run_id: state.runId }).then(() => sendResponse({ ok: true, data })).catch(() => sendResponse({ ok: true, data }));
      }
      else if (message?.type === "observer:status") sendResponse({ ok: true, data: status() });
      else if (message?.type === "observer:export") sendResponse({ ok: true, data: observation() });
      else sendResponse({ ok: false, error: "알 수 없는 요청입니다." });
    } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    return true;
  });
})();
