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
        { event_type: "search_queries", queries: ["서울 포텐자", "서울 포텐자"] },
        { event_type: "search_results", result_groups: [{ entries: [{ url: "https://clinic.example/a?utm_source=x" }] }] }
      ],
      response_candidates: [{ role: "assistant", text: "찾았습니다.", citation_groups: [
        { canonical_url: "https://clinic.example/a", text: "Clinic" },
        { canonical_url: "https://clinic.example/a?utm_source=x", text: "Duplicate" }
      ] }]
    }]
  });

  assert.deepEqual(view.summary, { record_count: 1, answer_count: 1, search_result_count: 1, cited_source_count: 1 });
  assert.deepEqual(view.records[0].question, { id: "q_001", repetition: 2, text: "서울 포텐자 병원 찾아줘" });
  assert.deepEqual(view.records[0].search, { status: "observed", queries: ["서울 포텐자"], result_count: 1 });
  assert.equal(view.records[0].citations.length, 1);
});

test("응답과 검색이 없는 측정 결과도 표시할 수 있다", () => {
  const view = createExtensionObservationView({ turn_candidates: [{ prompt: { text: "질문" } }] });
  assert.equal(view.records[0].answer, null);
  assert.deepEqual(view.records[0].citations, []);
  assert.equal(view.records[0].search.status, "not_observed");
});
