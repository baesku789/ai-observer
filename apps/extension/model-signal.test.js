import test from "node:test";
import assert from "node:assert/strict";
import { displayedModelFor, modelSignalFromRequestBody } from "./model-signal.js";

function requestBody(value) {
  return { raw: [{ bytes: new TextEncoder().encode(JSON.stringify(value)).buffer }] };
}

test("ChatGPT 요청 본문에서 모델과 허용된 모드 신호만 추출한다", () => {
  const signal = modelSignalFromRequestBody(requestBody({
    model: "gpt-5-6",
    client_prepare_dispatch: "immediate",
    client_prepare_source: "context_change",
    history_and_training_disabled: true,
    messages: [{ content: { parts: ["저장하면 안 되는 질문"] } }],
    authorization: "저장하면 안 되는 토큰"
  }));

  assert.deepEqual(signal, {
    requested_model: "gpt-5-6",
    displayed_model: "GPT-5.6 Sol",
    client_prepare_dispatch: "immediate",
    client_prepare_source: "context_change",
    history_and_training_disabled: true
  });
  assert.equal(JSON.stringify(signal).includes("저장하면 안 되는"), false);
});

test("알려진 내부 모델 코드를 사용자 화면 이름으로 변환한다", () => {
  assert.equal(displayedModelFor("gpt-5-6-instant"), "GPT-5.6 Sol");
  assert.equal(displayedModelFor("gpt-5-5-instant"), "GPT-5.5");
  assert.equal(displayedModelFor("o3"), "o3");
  assert.equal(displayedModelFor("future-model"), null);
});

test("모델이 없거나 본문이 손상된 요청은 무시한다", () => {
  assert.equal(modelSignalFromRequestBody(requestBody({ messages: [] })), null);
  assert.equal(modelSignalFromRequestBody({ raw: [{ bytes: new TextEncoder().encode("not json").buffer }] }), null);
  assert.equal(modelSignalFromRequestBody({ error: "unavailable" }), null);
});
