const PROTOCOL_VERSION = "1.3";
const attachedTabs = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const target = (tabId) => ({ tabId });

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach(target(tabId), PROTOCOL_VERSION);
  } catch (error) {
    if (!String(error).includes("already attached")) throw error;
  }
  attachedTabs.add(tabId);
  await chrome.debugger.sendCommand(target(tabId), "Accessibility.enable");
  await chrome.debugger.sendCommand(target(tabId), "DOM.enable");
}

async function command(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand(target(tabId), method, params);
}

function valueOf(property) {
  return String(property?.value ?? "").trim();
}

async function axNodes(tabId) {
  const result = await command(tabId, "Accessibility.getFullAXTree", { depth: -1 });
  return result.nodes || [];
}

function matchesName(node, names) {
  const name = valueOf(node.name).toLocaleLowerCase();
  return names.some((candidate) => name === candidate.toLocaleLowerCase() || name.includes(candidate.toLocaleLowerCase()));
}

async function findNode(tabId, { roles = [], names = [] }) {
  const nodes = await axNodes(tabId);
  return nodes.find((node) => {
    const role = valueOf(node.role);
    return node.backendDOMNodeId && (!roles.length || roles.includes(role)) && (!names.length || matchesName(node, names));
  }) || null;
}

async function centerOf(tabId, node) {
  const box = await command(tabId, "DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
  const quad = box.model?.border;
  if (!quad?.length) throw new Error("조작할 UI의 화면 위치를 확인하지 못했습니다.");
  return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
}

async function trustedClick(tabId, node) {
  const { x, y } = await centerOf(tabId, node);
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await command(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function clickNamed(tabId, spec, errorMessage) {
  const node = await findNode(tabId, spec);
  if (!node) throw new Error(errorMessage);
  await trustedClick(tabId, node);
  return { clicked: true, accessible_name: valueOf(node.name), role: valueOf(node.role) };
}

export async function attachAutomation(tabId) {
  await ensureAttached(tabId);
  return { attached: true };
}

export async function detachAutomation(tabId) {
  if (!attachedTabs.has(tabId)) return { detached: false };
  try { await chrome.debugger.detach(target(tabId)); } catch (_) {}
  attachedTabs.delete(tabId);
  return { detached: true };
}

export async function openNewChat(tabId) {
  return clickNamed(tabId, { roles: ["button", "link"], names: ["새 채팅", "New chat", "新增聊天", "新聊天"] }, "새 채팅 컨트롤을 찾지 못했습니다.");
}

export async function setChatMode(tabId, desiredMode) {
  const temporaryOn = await findNode(tabId, { roles: ["button"], names: ["임시 채팅 끄기", "Turn off temporary chat", "Disable temporary chat"] });
  if (desiredMode === "temporary" && temporaryOn) return { changed: false, chat_mode: "temporary" };
  if (desiredMode === "regular" && !temporaryOn) return { changed: false, chat_mode: "regular" };
  const names = desiredMode === "temporary"
    ? ["임시 채팅", "Temporary chat", "暫時聊天", "临时聊天"]
    : ["임시 채팅 끄기", "Turn off temporary chat", "Disable temporary chat"];
  const result = await clickNamed(tabId, { roles: ["button"], names }, `${desiredMode === "temporary" ? "임시" : "일반"} 채팅 컨트롤을 찾지 못했습니다.`);
  return { ...result, changed: true, chat_mode: desiredMode };
}

export async function submitPrompt(tabId, prompt) {
  const composer = await findNode(tabId, { roles: ["textbox"], names: ["ChatGPT와 채팅", "Message ChatGPT", "ChatGPT에게 물어보세요"] });
  if (!composer) throw new Error("ChatGPT 입력창을 접근성 트리에서 찾지 못했습니다.");
  await trustedClick(tabId, composer);
  await command(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4 });
  await command(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
  await command(tabId, "Input.insertText", { text: prompt });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(150);
    const send = await findNode(tabId, { roles: ["button"], names: ["프롬프트 보내기", "메시지 보내기", "Send message", "Send prompt"] });
    if (send && !nodeDisabled(send)) {
      await trustedClick(tabId, send);
      return { submitted: true };
    }
  }
  throw new Error("활성화된 전송 버튼을 접근성 트리에서 찾지 못했습니다.");
}

function nodeDisabled(node) {
  return (node.properties || []).some((property) => property.name === "disabled" && property.value?.value === true);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});
