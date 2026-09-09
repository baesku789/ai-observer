import { modelSignalFromRequestBody } from "./model-signal.js";
import { attachAutomation, detachAutomation, openNewChat, setChatMode, submitPrompt } from "./automation-controller.js";

const CAPTURE_STORAGE_KEY = "networkCaptureSessions";
let captureSessionsPromise = chrome.storage.session.get(CAPTURE_STORAGE_KEY).then((stored) => stored[CAPTURE_STORAGE_KEY] || {});

async function updateCaptureSessions(update) {
  const sessions = await captureSessionsPromise;
  const next = update({ ...sessions });
  captureSessionsPromise = Promise.resolve(next);
  await chrome.storage.session.set({ [CAPTURE_STORAGE_KEY]: next });
  return next;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type?.startsWith("observer:cdp-") && Number.isInteger(message.tab_id)) {
    const actions = {
      "observer:cdp-attach": () => attachAutomation(message.tab_id),
      "observer:cdp-detach": () => detachAutomation(message.tab_id),
      "observer:cdp-open-new-chat": () => openNewChat(message.tab_id),
      "observer:cdp-set-chat-mode": () => setChatMode(message.tab_id, message.desired_chat_mode),
      "observer:cdp-submit-prompt": () => submitPrompt(message.tab_id, message.prompt)
    };
    const action = actions[message.type];
    if (!action) { sendResponse({ ok: false, error: "알 수 없는 CDP 자동화 요청입니다." }); return false; }
    action().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "observer:network-capture-start" && sender.tab?.id) {
    updateCaptureSessions((sessions) => {
      sessions[sender.tab.id] = { run_id: message.run_id, started_at: new Date().toISOString() };
      return sessions;
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "observer:network-capture-stop" && sender.tab?.id) {
    updateCaptureSessions((sessions) => {
      delete sessions[sender.tab.id];
      return sessions;
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateCaptureSessions((sessions) => {
    delete sessions[tabId];
    return sessions;
  }).catch(() => {});
  chrome.storage.session.get("measurementSession").then(({ measurementSession }) => {
    if (measurementSession?.ownerTabId === tabId) return chrome.storage.session.remove("measurementSession");
  }).catch(() => {});
});

chrome.webRequest.onBeforeRequest.addListener((details) => {
  captureSessionsPromise.then((sessions) => {
    const session = sessions[details.tabId];
    if (!session) return;
    const signal = modelSignalFromRequestBody(details.requestBody);
    if (!signal) return;
    chrome.tabs.sendMessage(details.tabId, {
      type: "observer:network-model-signal",
      run_id: session.run_id,
      signal: {
        ...signal,
        request_id: details.requestId,
        captured_at: new Date(details.timeStamp).toISOString(),
        source: "network_request"
      }
    }).catch(() => {});
  }).catch(() => {});
}, {
  urls: ["https://chatgpt.com/backend-api/*conversation*"],
  types: ["xmlhttprequest"]
}, ["requestBody"]);
