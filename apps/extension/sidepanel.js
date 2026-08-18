import { createQuerySetFromText, expandQuerySet, querySetMetadata as buildQuerySetMetadata, visibleRunIndex } from "./query-set.js";

const elements = {
  start: document.querySelector("#start"),
  newConversation: document.querySelector("#new-conversation"),
  stop: document.querySelector("#stop"),
  export: document.querySelector("#export"),
  measurementType: document.querySelector("#measurement-type"),
  dot: document.querySelector("#status-dot"),
  label: document.querySelector("#status-label"),
  detail: document.querySelector("#status-detail"),
  message: document.querySelector("#message"),
  runnerFeedback: document.querySelector("#runner-feedback"),
  queryListInput: document.querySelector("#query-list-input"),
  queryRepetitions: document.querySelector("#query-repetitions"),
  prepareQueryList: document.querySelector("#prepare-query-list"),
  querySetInput: document.querySelector("#query-set-input"),
  loadQuerySet: document.querySelector("#load-query-set"),
  clearQuerySet: document.querySelector("#clear-query-set"),
  queryCard: document.querySelector("#query-card"),
  queryProgress: document.querySelector("#query-progress"),
  queryText: document.querySelector("#query-text"),
  queryMeta: document.querySelector("#query-meta"),
  copyQuery: document.querySelector("#copy-query"),
  nextQuery: document.querySelector("#next-query")
};

let runner = null;
let latestStatus = null;
let lastAnnouncedVisibleIndex = null;
const buttonTimers = new WeakMap();

async function activeChatGptTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) throw new Error("현재 창에서 chatgpt.com 탭을 선택해 주세요.");
  return tab;
}

async function request(type, payload = {}) {
  const tab = await activeChatGptTab();
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type, ...payload });
    if (!response?.ok) throw new Error(response?.error || "수집기 요청에 실패했습니다.");
    return response.data;
  } catch (error) {
    if (String(error).includes("Receiving end does not exist")) throw new Error("확장 프로그램 설치 전에 열린 ChatGPT 탭입니다. 탭을 새로고침해 주세요.");
    throw error;
  }
}

function currentQuery() {
  return runner?.runs[runner.index] || null;
}

function visibleQueryState() {
  if (!runner) return { query: null, index: null, isNext: false, isLastSent: false };
  const promptCaptured = Boolean(latestStatus?.current_conversation_prompt_count);
  const index = visibleRunIndex(runner.index, runner.runs.length, promptCaptured);
  return { query: index === null ? null : runner.runs[index], index, isNext: index !== runner.index, isLastSent: promptCaptured && runner.index === runner.runs.length - 1 };
}

function querySetMetadata() {
  if (!runner) return null;
  return buildQuerySetMetadata(runner.definition, runner.runs.length);
}

async function saveRunner() {
  if (runner) await chrome.storage.local.set({ queryRunner: runner });
  else await chrome.storage.local.remove("queryRunner");
}

function showRunnerFeedback(message, type = "neutral") {
  elements.runnerFeedback.classList.toggle("success", type === "success");
  elements.runnerFeedback.classList.toggle("error", type === "error");
  elements.runnerFeedback.textContent = message;
}

function flashButton(button, label, duration = 1600) {
  clearTimeout(buttonTimers.get(button));
  const originalLabel = button.dataset.defaultLabel || button.textContent;
  button.dataset.defaultLabel = originalLabel;
  button.textContent = label;
  button.classList.add("confirmed");
  const timer = setTimeout(() => {
    button.textContent = originalLabel;
    button.classList.remove("confirmed");
    buttonTimers.delete(button);
  }, duration);
  buttonTimers.set(button, timer);
}

async function setRunner(definition, sourceButton = elements.prepareQueryList) {
  runner = { definition, runs: expandQuerySet(definition), index: 0 };
  lastAnnouncedVisibleIndex = 0;
  elements.measurementType.value = "independent_query";
  await saveRunner();
  renderRunner();
  flashButton(sourceButton, "✓ 준비 완료");
  showRunnerFeedback(`질문 ${definition.queries.length}개 · 총 ${runner.runs.length}회 준비됨. 아래 첫 질문을 복사하세요.`, "success");
  requestAnimationFrame(() => elements.queryCard.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  showMessage(`질문 ${definition.queries.length}개, 총 ${runner.runs.length}회 측정을 준비했습니다.`, true);
}

function renderRunner() {
  const visible = visibleQueryState();
  const query = visible.query;
  elements.queryCard.hidden = !query;
  if (!query) return;
  elements.queryProgress.textContent = visible.isLastSent ? "마지막 질문 전송됨" : visible.isNext ? `다음 질문 ${visible.index + 1} / ${runner.runs.length}` : `진행 ${visible.index + 1} / ${runner.runs.length}`;
  elements.queryText.textContent = query.expected_prompt;
  elements.queryMeta.textContent = visible.isNext ? `바로 복사할 수 있습니다 · 반복 ${query.repetition}회차` : `반복 ${query.repetition}회차`;
  if (visible.isNext && lastAnnouncedVisibleIndex !== visible.index) {
    showRunnerFeedback("현재 질문이 수집됐습니다. 다음 질문을 바로 복사할 수 있습니다.", "success");
  }
  lastAnnouncedVisibleIndex = visible.index;
  const active = Boolean(latestStatus?.measuring);
  elements.nextQuery.disabled = !active || runner.index >= runner.runs.length - 1 || !latestStatus?.current_conversation_prompt_count;
  elements.copyQuery.disabled = visible.isLastSent;
  elements.prepareQueryList.disabled = active;
  elements.loadQuerySet.disabled = active;
  elements.clearQuerySet.disabled = active;
  elements.queryListInput.disabled = active;
  elements.queryRepetitions.disabled = active;
  elements.querySetInput.disabled = active;
}

function render(status) {
  latestStatus = status;
  const active = Boolean(status?.measuring);
  const runnerActive = Boolean(currentQuery()) && elements.measurementType.value === "independent_query";
  elements.dot.classList.toggle("active", active);
  elements.label.textContent = active ? "측정 중" : "측정 준비됨";
  elements.detail.textContent = active
    ? `${status.chat_mode === "temporary" ? "임시 채팅" : status.chat_mode === "regular" ? "일반 채팅" : "모드 확인 중"} · 대화 ${status.conversation_count}개 · 후보 ${status.candidate_count}개`
    : status?.run_id ? `대화 ${status.conversation_count}개 · 수집 후보 ${status.candidate_count}개 · 내려받을 수 있습니다.` : "측정 시작 이후의 새 대화만 기록합니다.";
  elements.start.disabled = active;
  elements.newConversation.disabled = !active || runnerActive;
  elements.stop.disabled = !active;
  elements.export.disabled = !status?.run_id;
  elements.measurementType.disabled = active;
  elements.prepareQueryList.disabled = active;
  elements.loadQuerySet.disabled = active;
  elements.clearQuerySet.disabled = active;
  elements.queryListInput.disabled = active;
  elements.queryRepetitions.disabled = active;
  elements.querySetInput.disabled = active;
  renderRunner();
}

function showMessage(message, success = false) {
  elements.message.style.color = success ? "#2d6a4f" : "#a33a2b";
  elements.message.textContent = message;
}

async function refresh() {
  try { render(await request("observer:status")); }
  catch (error) {
    elements.label.textContent = "ChatGPT 연결 필요";
    elements.detail.textContent = "ChatGPT 탭을 선택하거나 새로고침하세요.";
    showMessage(error.message);
    elements.start.disabled = true;
    elements.newConversation.disabled = true;
    elements.stop.disabled = true;
    elements.export.disabled = true;
  }
}

async function perform(type) {
  try { render(await request(type)); }
  catch (error) { showMessage(error.message); }
}

elements.prepareQueryList.addEventListener("click", async () => {
  try {
    await setRunner(createQuerySetFromText(elements.queryListInput.value, elements.queryRepetitions.value));
  } catch (error) { showRunnerFeedback(error.message, "error"); showMessage(error.message); }
});

elements.loadQuerySet.addEventListener("click", async () => {
  try {
    await setRunner(JSON.parse(elements.querySetInput.value), elements.loadQuerySet);
  } catch (error) { showRunnerFeedback(`JSON을 확인해 주세요: ${error.message}`, "error"); showMessage(error.message); }
});

elements.clearQuerySet.addEventListener("click", async () => {
  runner = null;
  lastAnnouncedVisibleIndex = null;
  elements.queryListInput.value = "";
  elements.queryRepetitions.value = "1";
  elements.querySetInput.value = "";
  await saveRunner();
  renderRunner();
  showRunnerFeedback("초기화했습니다. 새 질문을 입력해 주세요.");
  showMessage("질문 세트를 초기화했습니다.", true);
});

elements.copyQuery.addEventListener("click", async () => {
  const query = visibleQueryState().query;
  if (!query) return;
  try {
    await navigator.clipboard.writeText(query.expected_prompt);
    flashButton(elements.copyQuery, "✓ 복사됨");
    showRunnerFeedback("클립보드에 복사했습니다. ChatGPT 입력창에 붙여넣으세요.", "success");
    showMessage("질문을 복사했습니다.", true);
  } catch (error) { showRunnerFeedback(`복사에 실패했습니다: ${error.message}`, "error"); showMessage(`질문 복사에 실패했습니다: ${error.message}`); }
});

elements.start.addEventListener("click", async () => {
  try {
    const measurementType = elements.measurementType.value;
    if (measurementType === "independent_query" && runner && !currentQuery()) throw new Error("실행할 질문이 없습니다.");
    render(await request("observer:start", { measurement_type: measurementType, query_metadata: measurementType === "independent_query" ? currentQuery() : null, query_set: measurementType === "independent_query" ? querySetMetadata() : null }));
    showMessage("측정을 시작했습니다.", true);
  } catch (error) { showMessage(error.message); }
});

elements.nextQuery.addEventListener("click", async () => {
  if (!runner || runner.index >= runner.runs.length - 1) return;
  if (!latestStatus?.current_conversation_prompt_count) {
    showRunnerFeedback("현재 질문을 ChatGPT에 먼저 전송해 주세요.", "error");
    showMessage("현재 질문을 ChatGPT에 먼저 전송해 주세요.");
    return;
  }
  const previousIndex = runner.index;
  runner.index += 1;
  try {
    render(await request("observer:new-conversation", { query_metadata: currentQuery() }));
    await saveRunner();
    renderRunner();
    flashButton(elements.nextQuery, "✓ 전환 완료");
    showRunnerFeedback("다음 질문 측정으로 전환했습니다. 임시 채팅을 켠 뒤 복사한 질문을 전송하세요.", "success");
    showMessage("다음 질문을 새 대화에 연결했습니다. 임시 채팅으로 전환한 뒤 복사한 질문을 전송하세요.", true);
  } catch (error) {
    runner.index = previousIndex;
    renderRunner();
    showRunnerFeedback(`다음 질문 전환에 실패했습니다: ${error.message}`, "error");
    showMessage(error.message);
  }
});

elements.newConversation.addEventListener("click", async () => {
  try {
    render(await request("observer:new-conversation"));
    showMessage("새 대화 경계를 기록했습니다. 이제 질문을 입력하세요.", true);
  } catch (error) { showMessage(error.message); }
});

elements.stop.addEventListener("click", () => perform("observer:stop"));
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
  const stored = await chrome.storage.local.get("queryRunner");
  if (stored.queryRunner) {
    try {
      runner = stored.queryRunner;
      runner.runs = expandQuerySet(runner.definition);
      if (runner.index >= runner.runs.length) runner.index = 0;
      elements.queryListInput.value = runner.definition.queries.map((query) => query.text).join("\n");
      const repetitions = new Set(runner.definition.queries.map((query) => query.repetitions ?? 1));
      if (repetitions.size === 1) elements.queryRepetitions.value = String([...repetitions][0]);
      elements.querySetInput.value = JSON.stringify(runner.definition, null, 2);
    } catch (_) { runner = null; }
  }
  renderRunner();
  refresh();
  setInterval(refresh, 750);
}

initialize();
