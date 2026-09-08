import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionObservationView } from "./observation-view.js";

test("익스텐션 측정 결과를 사용자용 View로 만든다", () => {
  const view = createExtensionObservationView({
    observation_id: "obs_1",
    captured_at: "2026-09-08T01:00:00.000Z",
    conversation_instances: [{ conversation_instance_id: "conversation_1", query: { query_id: "q_001", repetition: 2 } }],
    turn_candidates: [{
      conversation_instance_id: "conversation_1",
      prompt: { text: "서울 포텐자 병원 찾아줘" },
      search_events: [
        { event_type: "search_queries", queries: ["서울 포텐자", "영어 포텐자"] },
        { event_type: "search_results", result_groups: [{ entries: [{ url: "https://clinic.example/a?utm_source=x" }, { url: "https://other.example/a" }] }] },
        { event_type: "search_results", result_groups: [{ entries: [{ url: "https://clinic.example/a" }] }] }
      ],
      response_candidates: [{ role: "assistant", text: "찾았습니다.", citation_groups: [
        { canonical_url: "https://clinic.example/a", text: "Clinic" },
        { canonical_url: "https://clinic.example/a?utm_source=x", text: "Duplicate" }
      ] }]
    }]
  });

  assert.deepEqual(view.summary, { record_count: 1, answer_count: 1, query_count: 2, search_result_count: 2, cited_source_count: 1 });
  assert.deepEqual(view.records[0].question, { id: "q_001", repetition: 2, text: "서울 포텐자 병원 찾아줘" });
  assert.deepEqual(view.records[0].search.searches, [
    { query: "서울 포텐자", result_count: 2, results: [
      { title: null, domain: "clinic.example", url: "https://clinic.example/a", snippet: null },
      { title: null, domain: "other.example", url: "https://other.example/a", snippet: null }
    ] },
    { query: "영어 포텐자", result_count: 1, results: [
      { title: null, domain: "clinic.example", url: "https://clinic.example/a", snippet: null }
    ] }
  ]);
  assert.equal(view.records[0].search.result_count, 2);
  assert.equal(view.records[0].citations.length, 1);
});

test("응답과 검색이 없는 측정 결과도 표시할 수 있다", () => {
  const view = createExtensionObservationView({ turn_candidates: [{ prompt: { text: "질문" } }] });
  assert.equal(view.records[0].answer, null);
  assert.deepEqual(view.records[0].citations, []);
  assert.equal(view.records[0].search.status, "not_observed");
});

test("검색어와 결과 묶음 수가 다르면 검색어별 결과 수를 추측하지 않는다", () => {
  const view = createExtensionObservationView({ turn_candidates: [{
    prompt: { text: "질문" },
    search_events: [
      { event_type: "search_queries", queries: ["검색어 1", "검색어 2"] },
      { event_type: "search_results", result_groups: [{ entries: [{ url: "https://example.com" }] }] }
    ]
  }] });
  assert.equal(view.records[0].search.result_count_by_query_available, false);
  assert.deepEqual(view.records[0].search.searches.map((search) => search.result_count), [null, null]);
  assert.deepEqual(view.records[0].search.searches.map((search) => search.results), [null, null]);
});
