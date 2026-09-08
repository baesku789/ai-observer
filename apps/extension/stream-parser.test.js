import test from "node:test";
import assert from "node:assert/strict";

await import("./stream-parser.js");
const { createSseParser, extractSearchSignals } = globalThis.AIObserverStreamParser;

test("SSE 청크 경계를 넘어 검색어와 검색 결과를 추출한다", () => {
  const payloads = [];
  const parser = createSseParser((payload) => payloads.push(payload));
  const event = JSON.stringify({ v: { message: { metadata: {
    search_model_queries: { type: "search_model_queries", queries: ["서울 포텐자 영어 피부과", "서울 포텐자 영어 피부과"] },
    search_result_groups: [{ type: "search_result_group", domain: "example.com", entries: [{ url: "https://example.com/potenza?x=1", title: "Potenza", snippet: "English support" }] }]
  } } } });
  parser.push(`event: delta\ndata: ${event.slice(0, 40)}`);
  parser.push(`${event.slice(40)}\n\n`);

  assert.equal(payloads.length, 1);
  assert.deepEqual(extractSearchSignals(payloads[0]), [
    { event_type: "search_queries", queries: ["서울 포텐자 영어 피부과"] },
    { event_type: "search_results", result_groups: [{ domain: "example.com", entries: [{ url: "https://example.com/potenza?x=1", title: "Potenza", snippet: "English support", attribution: null }] }] }
  ]);
});

test("검색 시작과 도구 메타데이터만 화이트리스트로 남긴다", () => {
  const signals = extractSearchSignals({
    items: [
      { type: "message_marker", marker: "search_start", conversation_id: "private" },
      { type: "server_ste_metadata", metadata: { tool_name: "SonicBrowserTool", tool_invoked: true, user_agent: "private" } }
    ],
    authorization: "secret"
  });

  assert.deepEqual(signals, [
    { event_type: "search_started" },
    { event_type: "search_tool", tool_name: "SonicBrowserTool", tool_invoked: true }
  ]);
  assert.equal(JSON.stringify(signals).includes("secret"), false);
  assert.equal(JSON.stringify(signals).includes("private"), false);
});

test("HTTP가 아닌 결과 URL은 버린다", () => {
  const signals = extractSearchSignals({ type: "search_result_group", entries: [
    { url: "javascript:alert(1)", title: "bad" },
    { url: "https://safe.example/result", title: "safe" }
  ] });
  assert.equal(signals[0].result_groups[0].entries.length, 1);
  assert.equal(signals[0].result_groups[0].entries[0].url, "https://safe.example/result");
});
