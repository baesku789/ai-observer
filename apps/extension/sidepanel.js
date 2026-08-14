const elements = {
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  export: document.querySelector("#export"),
  dot: document.querySelector("#status-dot"),
  label: document.querySelector("#status-label"),
  detail: document.querySelector("#status-detail"),
  message: document.querySelector("#message")
};

async function activeChatGptTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) throw new Error("현재 창에서 chatgpt.com 탭을 선택해 주세요.");
  return tab;
}

async function request(type) {
  const tab = await activeChatGptTab();
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type });
    if (!response?.ok) throw new Error(response?.error || "수집기 요청에 실패했습니다.");
    return response.data;
  } catch (error) {
    if (String(error).includes("Receiving end does not exist")) throw new Error("확장 프로그램 설치 전에 열린 ChatGPT 탭입니다. 탭을 새로고침해 주세요.");
    throw error;
  }
}

function render(status) {
  const active = Boolean(status?.measuring);
  elements.dot.classList.toggle("active", active);
  elements.label.textContent = active ? "측정 중" : "측정 준비됨";
  elements.detail.textContent = active
    ? `${status.chat_mode === "temporary" ? "임시 채팅" : status.chat_mode === "regular" ? "일반 채팅" : "모드 확인 중"} · 컨텍스트 ${status.context_count}개 · 후보 ${status.candidate_count}개`
    : status?.run_id ? `컨텍스트 ${status.context_count}개 · 수집 후보 ${status.candidate_count}개 · 내려받을 수 있습니다.` : "측정 시작 이후의 새 대화만 기록합니다.";
  elements.start.disabled = active;
  elements.stop.disabled = !active;
  elements.export.disabled = !status?.run_id;
}

async function refresh() {
  try {
    elements.message.textContent = "";
    render(await request("observer:status"));
  } catch (error) {
    elements.label.textContent = "ChatGPT 연결 필요";
    elements.detail.textContent = "ChatGPT 탭을 선택하거나 새로고침하세요.";
    elements.message.textContent = error.message;
    elements.start.disabled = true;
    elements.stop.disabled = true;
    elements.export.disabled = true;
  }
}

async function perform(type) {
  try {
    elements.message.textContent = "";
    render(await request(type));
  } catch (error) {
    elements.message.textContent = error.message;
  }
}

elements.start.addEventListener("click", () => perform("observer:start"));
elements.stop.addEventListener("click", () => perform("observer:stop"));
elements.export.addEventListener("click", async () => {
  try {
    const observation = await request("observer:export");
    const blob = new Blob([JSON.stringify(observation, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await chrome.downloads.download({ url, filename: `ai-observer/raw-observation-${stamp}.json`, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    elements.message.style.color = "#2d6a4f";
    elements.message.textContent = "JSON 파일을 만들었습니다.";
  } catch (error) {
    elements.message.style.color = "#a33a2b";
    elements.message.textContent = error.message;
  }
});

refresh();
setInterval(refresh, 1500);
