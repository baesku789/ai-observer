import { createQuerySetFromPrompts, expandQuerySet, querySetMetadata } from "./query-set.js";

const COLLECTOR_VERSION = "0.7.0";

const elements = Object.fromEntries([
  "start", "stop", "export", "measurement-type", "desired-chat-mode", "query-repetitions", "query-list", "add-query",
  "query-set-input", "load-query-set", "status-dot", "status-label", "status-detail", "message", "setup", "independent-settings",
  "workflow", "workflow-step", "workflow-title", "workflow-instruction", "workflow-query", "query-progress", "query-text", "copy-query",
  "confirm-new-chat", "mark-complete", "finish-measurement", "tab-warning", "return-to-tab", "results"
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.querySelector(`#${id}`)]));

let runner = null;
let runnerDirty = false;
let measurementSession = null;
let activeTabId = null;
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
    throw new Error("측정을 시작한 ChatGPT 탭이 닫혔습니다.");
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

async function saveSession(session) {
  measurementSession = session;
  if (session) await chrome.storage.session.set({ measurementSession: session });
  else await chrome.storage.session.remove("measurementSession");
}

async function saveRunner() {
  if (runner) await chrome.storage.local.set({ queryRunner: runner });
}

function showMessage(message = "", success = false) {
  elements.message.style.color = success ? "#2d6a4f" : "#a33a2b";
  elements.message.textContent = message;
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
  elements.statusDetail.textContent = active
    ? `${status.question_count}/${status.total_runs || "-"} 질문 수집 · ${status.chat_mode === "temporary" ? "임시 채팅" : status.chat_mode === "regular" ? "일반 채팅" : "모드 확인 중"} · ${modelStatus}`
    : status?.run_id ? `질문 ${status.question_count}개 · 답변 ${status.answer_count}개` : "질문을 입력하고 측정을 시작하세요.";
  elements.tabWarning.hidden = !tabMismatch;
  elements.setup.hidden = active;
  elements.workflow.hidden = !active || tabMismatch;
  elements.stop.hidden = !active || tabMismatch;
  elements.results.hidden = !status?.run_id || active;
  if (active && !tabMismatch) renderWorkflow(status);
}

async function refresh() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = active?.id || null;
    const status = await request("observer:status");
    if (status.collector_version !== COLLECTOR_VERSION) throw new Error("익스텐션을 다시 로드한 뒤 ChatGPT 탭도 새로고침해 주세요.");
    if (measurementSession?.runId && status.run_id !== measurementSession.runId) {
      await saveSession(null);
      throw new Error("측정 세션이 초기화되었습니다. 다시 시작해 주세요.");
    }
    render(status, Boolean(status.measuring && measurementSession?.ownerTabId && activeTabId !== measurementSession.ownerTabId));
  } catch (error) {
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

elements.start.addEventListener("click", async () => {
  try {
    const tab = await activeChatGptTab();
    const collectorStatus = await send(tab, "observer:status");
    if (collectorStatus.collector_version !== COLLECTOR_VERSION) throw new Error("익스텐션을 다시 로드한 뒤 ChatGPT 탭도 새로고침해 주세요.");
    const measurementType = elements.measurementType.value;
    if (measurementType === "independent_query") {
      if (!runner || runnerDirty) runner = buildRunner();
      runnerDirty = false;
      await saveRunner();
    }
    const status = await send(tab, "observer:start", {
      measurement_type: measurementType,
      query_set: measurementType === "independent_query" ? querySetMetadata(runner.definition, runner.runs.length) : null,
      query_runs: measurementType === "independent_query" ? runner.runs : [],
      desired_chat_mode: elements.desiredChatMode.value,
      owner_tab_id: tab.id
    });
    await saveSession({ ownerTabId: tab.id, runId: status.run_id });
    render(status);
    showMessage("");
  } catch (error) { showMessage(error.message); }
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
  try {
    render(await request("observer:stop"));
    showMessage("측정을 종료했습니다. 결과를 내려받을 수 있습니다.", true);
  } catch (error) { showMessage(error.message); }
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
    const observation = await request("observer:export");
    const blob = new Blob([JSON.stringify(observation, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await chrome.downloads.download({ url, filename: `ai-observer/raw-observation-${stamp}.json`, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showMessage("JSON 파일을 만들었습니다.", true);
  } catch (error) { showMessage(error.message); }
});

async function initialize() {
  const [local, session] = await Promise.all([chrome.storage.local.get("queryRunner"), chrome.storage.session.get("measurementSession")]);
  measurementSession = session.measurementSession || null;
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
