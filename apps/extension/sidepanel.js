import { createQuerySetFromPrompts, expandQuerySet, querySetMetadata } from "./query-set.js";
import { createExtensionObservationView } from "./observation-view.js";

const COLLECTOR_VERSION = "0.8.0";
const PRIVACY_CONSENT_VERSION = "2026-09-01";

const elements = Object.fromEntries([
  "start", "auto-start", "auto-pause", "automation-controls", "automation-status", "stop", "export", "export-view", "measurement-type", "account-plan", "model-selection", "desired-chat-mode", "query-repetitions", "query-list", "add-query",
  "query-set-input", "load-query-set", "status-dot", "status-label", "status-detail", "message", "setup", "independent-settings",
  "workflow", "workflow-step", "workflow-title", "workflow-instruction", "workflow-query", "query-progress", "query-text", "copy-query",
  "confirm-new-chat", "mark-complete", "finish-measurement", "tab-warning", "return-to-tab", "results", "result-time", "result-summary", "result-records", "privacy-consent"
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.querySelector(`#${id}`)]));

let runner = null;
let runnerDirty = false;
let measurementSession = null;
let activeTabId = null;
let refreshGeneration = 0;
let actionInProgress = false;
let resultRunId = null;
let resultObservation = null;
let resultView = null;
let automation = { enabled: false, paused: false, running: false, checkpointIndex: -1 };
let measurementProgress = null;
const buttonTimers = new WeakMap();

async function activeChatGptTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;
  if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) throw new Error("ChatGPT 탭을 선택해 주세요.");
  return tab;
}

async function ownerTab() {
  if (!measurementSession?.ownerTabId) return activeChatGptTab();
  try {
    const tab = await chrome.tabs.get(measurementSession.ownerTabId);
    if (!tab?.url?.startsWith("https://chatgpt.com/")) throw new Error();
    return tab;
  } catch (_) {
    await saveSession(null);
    throw new Error("이전 측정 탭이 닫혀 세션을 정리했습니다. ChatGPT 탭에서 새 측정을 시작해 주세요.");
  }
}

async function send(tab, type, payload = {}) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type, ...payload });
    if (!response?.ok) throw new Error(response?.error || "수집기 요청에 실패했습니다.");
    return response.data;
  } catch (error) {
    if (String(error).includes("Receiving end does not exist")) throw new Error("ChatGPT 탭을 새로고침해 주세요.");
    throw error;
  }
}

async function request(type, payload = {}) {
  return send(await ownerTab(), type, payload);
}

async function control(type, payload = {}) {
  const tab = await ownerTab();
  const response = await chrome.runtime.sendMessage({ type, tab_id: tab.id, ...payload });
  if (!response?.ok) throw new Error(response?.error || "브라우저 자동화 요청에 실패했습니다.");
  return response.data;
}

async function saveSession(session) {
  measurementSession = session;
  if (session) await chrome.storage.session.set({ measurementSession: session });
  else await chrome.storage.session.remove("measurementSession");
}

async function saveRunner() {
  if (runner) await chrome.storage.local.set({ queryRunner: runner });
}

async function saveMeasurementProfile() {
  await chrome.storage.local.set({
    measurementProfile: {
      accountPlan: elements.accountPlan.value,
      modelSelection: elements.modelSelection.value
    }
  });
}

function showMessage(message = "", success = false) {
  elements.message.style.color = success ? "#2d6a4f" : "#a33a2b";
  elements.message.textContent = message;
}

function setAutomationStatus(message) {
  elements.automationControls.hidden = !automation.enabled;
  elements.automationStatus.textContent = message;
  elements.autoPause.textContent = automation.paused ? "계속" : "일시정지";
}

async function saveCheckpoint(status) {
  if (!Number.isInteger(status.active_run_index) || status.active_run_index <= automation.checkpointIndex) return;
  const observation = await request("observer:export");
  const conversation = observation.conversation_instances?.find((item) => item.run_index === status.active_run_index);
  if (!conversation?.query || conversation.query.prompt_match !== "exact") throw new Error("현재 질문 원문이 일치하지 않아 자동 측정을 멈췄습니다.");
  if (!conversation.manual_completion && status.current_conversation_complete !== true) throw new Error("답변 완료를 확인하지 못했습니다.");
  if ((observation.capture_warnings || []).length) throw new Error(`Collector 경고가 있습니다: ${observation.capture_warnings.map((item) => item.code).join(", ")}`);
  const blob = new Blob([JSON.stringify(observation, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const query = conversation.query;
  const filename = `ai-observer/checkpoints/${observation.run_id}/${String(status.active_run_index + 1).padStart(3, "0")}-${query.query_id}-r${query.repetition}.json`;
  await chrome.downloads.download({ url, filename, saveAs: false });
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  const runKey = `${query.query_id}::${query.repetition}`;
  const completedRunKeys = new Set(measurementProgress?.query_set_id === query.query_set_id ? measurementProgress.completed_run_keys || [] : []);
  completedRunKeys.add(runKey);
  measurementProgress = { query_set_id: query.query_set_id, completed_run_keys: [...completedRunKeys], updated_at: new Date().toISOString() };
  await chrome.storage.local.set({ measurementProgress });
  automation.checkpointIndex = status.active_run_index;
}

async function downloadFinalResults() {
  const observation = await request("observer:export");
  const view = createExtensionObservationView(observation);
  const files = [
    [`ai-observer/${observation.run_id}/raw-observation.json`, observation],
    [`ai-observer/${observation.run_id}/observation-view.json`, view]
  ];
  for (const [filename, value] of files) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

async function automationLoop() {
  if (!automation.enabled || automation.paused || automation.running) return;
  automation.running = true;
  try {
    while (automation.enabled && !automation.paused) {
      const status = await request("observer:status");
      setAutomationStatus(`자동 측정 · ${status.question_count}/${status.total_runs}`);
      if (!status.measuring) throw new Error("측정 세션이 종료되어 자동 실행을 멈췄습니다.");
      if (status.phase === "collecting_response") { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
      if (status.phase === "awaiting_chat_mode") {
        await control("observer:cdp-set-chat-mode", { desired_chat_mode: status.desired_chat_mode });
        let changed = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const next = await request("observer:status");
          if (next.chat_mode === next.desired_chat_mode) { changed = true; break; }
        }
        if (!changed) throw new Error("요청한 채팅 모드로 전환되지 않았습니다.");
        continue;
      }
      if (status.phase === "ready_to_send") {
        await control("observer:cdp-submit-prompt", { prompt: status.active_query.expected_prompt });
        let submitted = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const next = await request("observer:status");
          if (next.phase !== "ready_to_send") { submitted = true; break; }
        }
        if (!submitted) throw new Error("질문 전송 상태를 확인하지 못했습니다.");
        continue;
      }
      if (status.phase === "awaiting_new_chat") {
        if (Number.isInteger(status.active_run_index)) await saveCheckpoint(status);
        const previousContextId = status.current_context_id;
        const previousUrl = status.current_conversation_url;
        await control("observer:cdp-open-new-chat");
        let blank = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const next = await request("observer:status");
          const contextChanged = next.current_context_id !== previousContextId || next.current_conversation_url !== previousUrl;
          if (contextChanged && next.page_message_count === 0) { blank = true; break; }
          if (attempt === 9 || attempt === 19) await control("observer:cdp-open-new-chat");
        }
        if (!blank) throw new Error("새 채팅 화면 전환을 확인하지 못했습니다.");
        let nextStatus = await request("observer:status");
        if (nextStatus.chat_mode !== nextStatus.desired_chat_mode) {
          await control("observer:cdp-set-chat-mode", { desired_chat_mode: nextStatus.desired_chat_mode });
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            nextStatus = await request("observer:status");
            if (nextStatus.chat_mode === nextStatus.desired_chat_mode) break;
          }
          if (nextStatus.chat_mode !== nextStatus.desired_chat_mode) throw new Error("요청한 채팅 모드로 전환되지 않았습니다.");
        }
        await request("observer:confirm-new-chat");
        continue;
      }
      if (status.phase === "completed") {
        await saveCheckpoint(status);
        await stopMeasurement();
        await downloadFinalResults();
        automation.enabled = false;
        setAutomationStatus("자동 측정 완료");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    automation.paused = true;
    setAutomationStatus("자동 측정 일시정지");
    showMessage(error.message);
  } finally { automation.running = false; }
}

function flashButton(button, label, duration = 1400) {
  clearTimeout(buttonTimers.get(button));
  const original = button.dataset.defaultLabel || button.textContent;
  button.dataset.defaultLabel = original;
  button.textContent = label;
  button.classList.add("confirmed");
  buttonTimers.set(button, setTimeout(() => {
    button.textContent = original;
    button.classList.remove("confirmed");
  }, duration));
}

function queryInputs() {
  return [...elements.queryList.querySelectorAll("input")];
}

function renumberQueries() {
  [...elements.queryList.children].forEach((row, index) => {
    row.querySelector(".query-number").textContent = String(index + 1);
    row.querySelector("input").placeholder = index ? "다음 질문을 입력하세요" : "예: 마곡 피부과 추천해줘";
    row.querySelector(".remove-query").hidden = elements.queryList.children.length === 1;
  });
}

function addQueryRow(value = "") {
  const row = document.createElement("div");
  row.className = "query-row";
  row.innerHTML = '<span class="query-number"></span><input type="text"><button class="remove-query" aria-label="질문 삭제">×</button>';
  row.querySelector("input").value = value;
  row.querySelector("input").addEventListener("input", saveDraftRunner);
  row.querySelector(".remove-query").addEventListener("click", () => {
    row.remove();
    renumberQueries();
    saveDraftRunner();
  });
  elements.queryList.append(row);
  renumberQueries();
  return row.querySelector("input");
}

function setQueryRows(prompts) {
  elements.queryList.replaceChildren();
  (prompts.length ? prompts : [""]).forEach(addQueryRow);
}

function buildRunner() {
  const definition = createQuerySetFromPrompts(queryInputs().map((input) => input.value), elements.queryRepetitions.value);
  return { definition, runs: expandQuerySet(definition) };
}

async function saveDraftRunner() {
  runnerDirty = true;
  try {
    runner = buildRunner();
    await saveRunner();
  } catch (_) {
    // 빈 입력 중에는 마지막으로 유효했던 질문 세트를 유지한다.
  }
}

function setWorkflow({ step = "", title = "", instruction = "", query = null, queryIndex = null, total = 0, canCopy = false, confirm = false, manual = false, finish = false }) {
  elements.workflowStep.textContent = step;
  elements.workflowTitle.textContent = title;
  elements.workflowInstruction.textContent = instruction;
  elements.workflowQuery.hidden = !query;
  elements.copyQuery.hidden = !canCopy;
  elements.confirmNewChat.hidden = !confirm;
  elements.markComplete.hidden = !manual;
  elements.finishMeasurement.hidden = !finish;
  if (query) {
    elements.queryProgress.textContent = Number.isInteger(queryIndex) ? `${queryIndex + 1} / ${total}` : "현재 질문";
    elements.queryText.textContent = query.expected_prompt;
    elements.copyQuery.dataset.prompt = query.expected_prompt;
  }
}

function renderWorkflow(status) {
  const progress = Number.isInteger(status.active_run_index) ? `${status.active_run_index + 1}/${status.total_runs}` : `0/${status.total_runs}`;
  if (status.phase === "awaiting_new_chat") {
    const first = status.active_run_index === null;
    setWorkflow({
      step: first ? "1단계" : `질문 ${progress} 완료`,
      title: first ? "현재 탭에서 새 채팅을 여세요" : "답변 수집 완료",
      instruction: first ? "새 탭을 열지 말고, 지금 측정 중인 ChatGPT 탭에서 새 채팅을 연 뒤 아래 버튼을 누르세요." : "다음 질문을 복사한 뒤, 지금 탭에서 새 채팅을 열고 아래 버튼을 누르세요.",
      query: status.next_query,
      queryIndex: status.next_run_index,
      total: status.total_runs,
      canCopy: !first,
      confirm: true
    });
  } else if (status.phase === "awaiting_chat_mode") {
    const temporary = status.desired_chat_mode === "temporary";
    setWorkflow({
      step: `질문 ${status.active_run_index + 1}/${status.total_runs}`,
      title: temporary ? "임시 채팅을 켜세요" : "일반 채팅으로 전환하세요",
      instruction: temporary ? "ChatGPT에서 임시 채팅을 켜면 질문 복사 단계로 자동 전환됩니다." : "임시 채팅을 끄면 질문 복사 단계로 자동 전환됩니다.",
      query: status.active_query,
      queryIndex: status.active_run_index,
      total: status.total_runs
    });
  } else if (status.phase === "ready_to_send") {
    const journey = status.measurement_type === "conversation_journey";
    setWorkflow({
      step: journey ? "측정 중" : `질문 ${status.active_run_index + 1}/${status.total_runs}`,
      title: journey ? "ChatGPT에 질문을 입력하세요" : "질문을 복사해 전송하세요",
      instruction: journey ? "이 채팅에서 이어지는 질문과 답변을 자동으로 수집합니다." : "복사한 질문을 ChatGPT 입력창에 붙여넣고 전송하세요.",
      query: status.active_query,
      queryIndex: status.active_run_index,
      total: status.total_runs,
      canCopy: !journey
    });
  } else if (status.phase === "collecting_response") {
    setWorkflow({
      step: status.measurement_type === "conversation_journey" ? "측정 중" : `질문 ${status.active_run_index + 1}/${status.total_runs}`,
      title: status.assistant_response_seen ? "GPT 답변을 수집하고 있어요" : "질문을 확인했어요",
      instruction: status.assistant_response_seen ? "답변 생성이 끝나면 다음 단계로 자동 전환됩니다." : "GPT 답변이 시작되기를 기다리고 있습니다.",
      query: status.active_query,
      queryIndex: status.active_run_index,
      total: status.total_runs,
      manual: status.assistant_response_seen
    });
  } else if (status.phase === "response_complete") {
    setWorkflow({ step: "답변 수집 완료", title: "다음 질문을 입력하세요", instruction: "같은 채팅에서 계속 질문하면 이어서 수집합니다." });
  } else if (status.phase === "completed") {
    setWorkflow({ step: "측정 완료", title: "모든 질문을 수집했습니다", instruction: `질문 ${status.total_runs}회의 답변 수집이 끝났습니다.`, finish: true });
  } else {
    setWorkflow({ step: "측정 중", title: "상태를 확인하고 있습니다", instruction: "잠시만 기다려 주세요." });
  }
}

function render(status, tabMismatch = false) {
  const active = Boolean(status?.measuring);
  elements.statusDot.classList.toggle("active", active);
  elements.statusLabel.textContent = active ? "측정 중" : status?.run_id ? "측정 종료" : "측정 준비";
  const modelStatus = status?.current_displayed_model || status?.current_requested_model || "모델 대기";
  const planStatus = status?.account_plan === "unknown" ? "플랜 미지정" : status?.account_plan?.toUpperCase();
  elements.statusDetail.textContent = active
    ? `${status.question_count}/${status.total_runs || "-"} 질문 수집 · ${status.chat_mode === "temporary" ? "임시 채팅" : status.chat_mode === "regular" ? "일반 채팅" : "모드 확인 중"} · ${planStatus} · ${modelStatus}`
    : status?.run_id ? `질문 ${status.question_count}개 · 답변 ${status.answer_count}개` : "질문을 입력하고 측정을 시작하세요.";
  elements.tabWarning.hidden = !tabMismatch;
  elements.setup.hidden = active;
  elements.workflow.hidden = !active || tabMismatch;
  elements.stop.hidden = !active || tabMismatch;
  elements.results.hidden = !status?.run_id || active;
  if (active && !tabMismatch) renderWorkflow(status);
  if (automation.enabled && active && !tabMismatch) automationLoop();
}

function resultMetric(label, value) {
  const item = document.createElement("div");
  item.className = "result-metric";
  const count = document.createElement("strong");
  count.textContent = String(value);
  const name = document.createElement("span");
  name.textContent = label;
  item.append(count, name);
  return item;
}

function renderResultView(view) {
  const capturedAt = view.captured_at ? new Date(view.captured_at) : null;
  elements.resultTime.textContent = capturedAt && !Number.isNaN(capturedAt.valueOf())
    ? capturedAt.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  elements.resultSummary.replaceChildren(
    resultMetric("질문", view.summary.record_count),
    resultMetric("검색어", view.summary.query_count),
    resultMetric("검색 결과", view.summary.search_result_count),
    resultMetric("인용 출처", view.summary.cited_source_count)
  );
  elements.resultRecords.replaceChildren();

  view.records.forEach((record, index) => {
    const details = document.createElement("details");
    details.className = "result-record";
    if (index === 0) details.open = true;
    const summary = document.createElement("summary");
    const number = document.createElement("span");
    number.className = "record-number";
    number.textContent = record.question.repetition ? `${index + 1} · ${record.question.repetition}회차` : String(index + 1);
    const question = document.createElement("strong");
    question.textContent = record.question.text || "질문을 찾지 못했습니다";
    summary.append(number, question);

    const content = document.createElement("div");
    content.className = "record-content";
    if (record.search.searches.length) {
      const searchSection = document.createElement("details");
      searchSection.className = "search-section";
      const searchSummary = document.createElement("summary");
      searchSummary.textContent = `검색어 ${record.search.query_count}개 · 고유 결과 ${record.search.result_count}개`;
      const list = document.createElement("ul");
      list.className = "search-list";
      record.search.searches.forEach((search) => {
        const item = document.createElement("li");
        const queryDetails = document.createElement("details");
        queryDetails.className = "search-query";
        const query = document.createElement("span");
        query.textContent = search.query;
        const querySummary = document.createElement("summary");
        querySummary.append(query);
        if (search.result_count !== null) {
          const count = document.createElement("strong");
          count.textContent = `${search.result_count}개 결과`;
          querySummary.append(count);
        }
        queryDetails.append(querySummary);
        if (search.results?.length) {
          const resultList = document.createElement("ol");
          resultList.className = "search-results";
          search.results.forEach((result) => {
            const resultItem = document.createElement("li");
            const link = document.createElement("a");
            link.href = result.url;
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = result.title || result.domain;
            const domain = document.createElement("span");
            domain.textContent = result.domain;
            resultItem.append(link, domain);
            if (result.snippet) {
              const snippet = document.createElement("p");
              snippet.textContent = result.snippet;
              resultItem.append(snippet);
            }
            resultList.append(resultItem);
          });
          queryDetails.append(resultList);
        } else {
          const empty = document.createElement("p");
          empty.className = "result-empty";
          empty.textContent = "검색어별 결과 연결 정보가 없습니다.";
          queryDetails.append(empty);
        }
        item.append(queryDetails);
        list.append(item);
      });
      searchSection.append(searchSummary, list);
      content.append(searchSection);
    }

    const answerSection = document.createElement("details");
    answerSection.className = "answer-details";
    const answerSummary = document.createElement("summary");
    answerSummary.textContent = record.answer ? "답변 보기" : "답변 없음";
    const answer = document.createElement("p");
    answer.className = "result-answer";
    answer.textContent = record.answer?.text || "수집된 답변이 없습니다.";
    answerSection.append(answerSummary, answer);
    content.append(answerSection);

    const citationSection = document.createElement("section");
    citationSection.innerHTML = `<h3>인용 출처 <span>${record.citations.length}개</span></h3>`;
    const citationList = document.createElement("ol");
    citationList.className = "citation-list";
    record.citations.forEach((citation) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = citation.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = citation.label || citation.domain;
      const domain = document.createElement("span");
      domain.textContent = citation.domain;
      item.append(link, domain);
      citationList.append(item);
    });
    if (!record.citations.length) {
      const empty = document.createElement("p");
      empty.className = "result-empty";
      empty.textContent = "수집된 인용 출처가 없습니다.";
      citationSection.append(empty);
    } else citationSection.append(citationList);
    content.append(citationSection);
    details.append(summary, content);
    elements.resultRecords.append(details);
  });
}

async function loadResults(runId) {
  if (!runId || resultRunId === runId) return;
  const observation = await request("observer:export");
  if (observation.run_id !== runId) return;
  resultObservation = observation;
  resultView = createExtensionObservationView(observation);
  resultRunId = runId;
  renderResultView(resultView);
}

async function refresh() {
  if (actionInProgress) return;
  const generation = ++refreshGeneration;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = active?.id || null;
    const status = await request("observer:status");
    if (generation !== refreshGeneration || actionInProgress) return;
    if (status.collector_version !== COLLECTOR_VERSION) throw new Error("익스텐션을 다시 로드한 뒤 ChatGPT 탭도 새로고침해 주세요.");
    if (measurementSession?.runId && status.run_id !== measurementSession.runId) {
      await saveSession(null);
      throw new Error("측정 세션이 초기화되었습니다. 다시 시작해 주세요.");
    }
    render(status, Boolean(status.measuring && measurementSession?.ownerTabId && activeTabId !== measurementSession.ownerTabId));
    if (!status.measuring && status.run_id) await loadResults(status.run_id);
  } catch (error) {
    if (generation !== refreshGeneration || actionInProgress) return;
    elements.statusDot.classList.remove("active");
    elements.statusLabel.textContent = "ChatGPT 연결 필요";
    elements.statusDetail.textContent = error.message;
    elements.workflow.hidden = true;
    elements.tabWarning.hidden = true;
    elements.setup.hidden = false;
    elements.stop.hidden = true;
    showMessage(error.message);
  }
}

elements.addQuery.addEventListener("click", () => {
  runnerDirty = true;
  addQueryRow("").focus();
});
elements.measurementType.addEventListener("change", () => {
  elements.independentSettings.hidden = elements.measurementType.value !== "independent_query";
});
elements.queryRepetitions.addEventListener("change", saveDraftRunner);
elements.accountPlan.addEventListener("change", saveMeasurementProfile);
elements.modelSelection.addEventListener("change", saveMeasurementProfile);
elements.privacyConsent.addEventListener("change", async () => {
  if (elements.privacyConsent.checked) {
    await chrome.storage.local.set({ privacyConsent: { version: PRIVACY_CONSENT_VERSION, acceptedAt: new Date().toISOString() } });
  } else await chrome.storage.local.remove("privacyConsent");
});

elements.loadQuerySet.addEventListener("click", async () => {
  try {
    const definition = JSON.parse(elements.querySetInput.value);
    runner = { definition, runs: expandQuerySet(definition) };
    runnerDirty = false;
    setQueryRows(definition.queries.map((query) => query.text));
    const repetitions = new Set(definition.queries.map((query) => query.repetitions ?? 1));
    if (repetitions.size === 1) elements.queryRepetitions.value = String([...repetitions][0]);
    elements.measurementType.value = "independent_query";
    elements.independentSettings.hidden = false;
    await saveRunner();
    showMessage(`질문 ${definition.queries.length}개를 불러왔습니다.`, true);
  } catch (error) { showMessage(`JSON을 확인해 주세요: ${error.message}`); }
});

async function startMeasurement(automatic = false) {
  actionInProgress = true;
  refreshGeneration += 1;
  elements.start.disabled = true;
  try {
    if (!elements.privacyConsent.checked) throw new Error("측정 데이터 안내를 확인하고 동의해 주세요.");
    const tab = await activeChatGptTab();
    const collectorStatus = await send(tab, "observer:status");
    if (collectorStatus.collector_version !== COLLECTOR_VERSION) throw new Error("익스텐션을 다시 로드한 뒤 ChatGPT 탭도 새로고침해 주세요.");
    const measurementType = elements.measurementType.value;
    if (measurementType === "independent_query") {
      if (!runner || runnerDirty) runner = buildRunner();
      runnerDirty = false;
      await saveRunner();
    }
    const completedRunKeys = new Set(measurementProgress?.query_set_id === runner?.definition?.query_set_id ? measurementProgress.completed_run_keys || [] : []);
    const pendingRuns = measurementType === "independent_query"
      ? runner.runs.filter((run) => !completedRunKeys.has(`${run.query_id}::${run.repetition}`))
      : [];
    if (measurementType === "independent_query" && !pendingRuns.length) throw new Error("이 질문 세트의 모든 측정이 이미 완료됐습니다.");
    if (automatic) {
      const attached = await chrome.runtime.sendMessage({ type: "observer:cdp-attach", tab_id: tab.id });
      if (!attached?.ok) throw new Error(attached?.error || "브라우저 자동화 연결에 실패했습니다.");
    }
    const status = await send(tab, "observer:start", {
      measurement_type: measurementType,
      query_set: measurementType === "independent_query" ? querySetMetadata(runner.definition, runner.runs.length) : null,
      query_runs: pendingRuns,
      desired_chat_mode: elements.desiredChatMode.value,
      account_plan: elements.accountPlan.value,
      model_selection: elements.modelSelection.value,
      owner_tab_id: tab.id
    });
    await saveSession({ ownerTabId: tab.id, runId: status.run_id });
    automation = { enabled: automatic, paused: false, running: false, checkpointIndex: -1 };
    setAutomationStatus(automatic ? "자동 측정 시작" : "");
    render(status);
    showMessage(completedRunKeys.size ? `완료된 ${completedRunKeys.size}회를 건너뛰고 이어서 측정합니다.` : "", true);
  } catch (error) { showMessage(error.message); }
  finally {
    actionInProgress = false;
    elements.start.disabled = false;
    await refresh();
  }
}
elements.start.addEventListener("click", () => startMeasurement(false));
elements.autoStart.addEventListener("click", () => startMeasurement(true));
elements.autoPause.addEventListener("click", () => {
  automation.paused = !automation.paused;
  setAutomationStatus(automation.paused ? "자동 측정 일시정지" : "자동 측정 재개");
  if (!automation.paused) automationLoop();
});

elements.confirmNewChat.addEventListener("click", async () => {
  try {
    render(await request("observer:confirm-new-chat"));
    showMessage("");
  } catch (error) { showMessage(error.message); }
});

elements.copyQuery.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.copyQuery.dataset.prompt || "");
    flashButton(elements.copyQuery, "✓ 복사됨");
    showMessage("ChatGPT 입력창에 붙여넣고 전송하세요.", true);
  } catch (error) { showMessage(`복사하지 못했습니다: ${error.message}`); }
});

elements.markComplete.addEventListener("click", async () => {
  try {
    render(await request("observer:mark-response-complete"));
    showMessage("답변 완료로 표시했습니다.", true);
  } catch (error) { showMessage(error.message); }
});

async function stopMeasurement() {
  actionInProgress = true;
  refreshGeneration += 1;
  try {
    const tab = await ownerTab();
    render(await send(tab, "observer:stop"));
    await chrome.runtime.sendMessage({ type: "observer:cdp-detach", tab_id: tab.id }).catch(() => {});
    showMessage("측정을 종료했습니다. 결과를 내려받을 수 있습니다.", true);
  } catch (error) { showMessage(error.message); }
  finally {
    actionInProgress = false;
    await refresh();
  }
}
elements.stop.addEventListener("click", stopMeasurement);
elements.finishMeasurement.addEventListener("click", stopMeasurement);

elements.returnToTab.addEventListener("click", async () => {
  if (!measurementSession?.ownerTabId) return;
  try { await chrome.tabs.update(measurementSession.ownerTabId, { active: true }); }
  catch (_) { showMessage("측정을 시작한 탭을 찾지 못했습니다."); }
});

elements.export.addEventListener("click", async () => {
  try {
    const observation = resultObservation || await request("observer:export");
    const blob = new Blob([JSON.stringify(observation, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await chrome.downloads.download({ url, filename: `ai-observer/raw-observation-${stamp}.json`, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showMessage("JSON 파일을 만들었습니다.", true);
  } catch (error) { showMessage(error.message); }
});

elements.exportView.addEventListener("click", async () => {
  try {
    const view = resultView || createExtensionObservationView(await request("observer:export"));
    const blob = new Blob([JSON.stringify(view, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await chrome.downloads.download({ url, filename: `ai-observer/observation-view-${stamp}.json`, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showMessage("결과 JSON 파일을 만들었습니다.", true);
  } catch (error) { showMessage(error.message); }
});

async function initialize() {
  const [local, session] = await Promise.all([chrome.storage.local.get(["queryRunner", "measurementProfile", "privacyConsent", "measurementProgress"]), chrome.storage.session.get("measurementSession")]);
  measurementSession = session.measurementSession || null;
  measurementProgress = local.measurementProgress || null;
  elements.privacyConsent.checked = local.privacyConsent?.version === PRIVACY_CONSENT_VERSION;
  if (local.measurementProfile) {
    elements.accountPlan.value = local.measurementProfile.accountPlan || "unknown";
    elements.modelSelection.value = local.measurementProfile.modelSelection || "default";
  }
  if (local.queryRunner) {
    try {
      runner = local.queryRunner;
      runnerDirty = false;
      runner.runs = expandQuerySet(runner.definition);
      setQueryRows(runner.definition.queries.map((query) => query.text));
      const repetitions = new Set(runner.definition.queries.map((query) => query.repetitions ?? 1));
      if (repetitions.size === 1) elements.queryRepetitions.value = String([...repetitions][0]);
      elements.querySetInput.value = JSON.stringify(runner.definition, null, 2);
    } catch (_) { runner = null; setQueryRows([""]); }
  } else setQueryRows([""]);
  await refresh();
  setInterval(refresh, 750);
}

initialize();
