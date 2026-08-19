import test from "node:test";
import assert from "node:assert/strict";
import { normalizeObservation } from "../src/index.js";

const raw = {
  schema_version: "0.3.0-draft",
  observation_id: "obs_test",
  run_id: "run_test",
  surface: "chatgpt_web",
  captured_at: "2026-08-14T00:00:00Z",
  environment: { displayed_model: null, displayed_mode: "즉시", locale: "ko-KR" },
  chat_contexts: [{ context_id: "context_1", chat_mode: "temporary" }],
  turn_candidates: [{
    turn_id: "turn_1",
    context_id: "context_1",
    turn_index: 1,
    prompt: { text: "마곡점 원장 이력은?" },
    response_candidates: [{
      candidate_id: "response_1",
      role: "assistant",
      text: "공식 페이지에서 확인됩니다.",
      completion_state: "quiet_candidate",
      citation_groups: [{ group_id: "group_1", canonical_url: "https://www.oganacell-magok.com/company/doctor.html?utm_source=chatgpt.com" }],
      link_candidates: [{ href: "https://www.oganacell-magok.com/company/doctor.html?utm_source=chatgpt.com" }]
    }]
  }]
};

test("citation pill과 link를 하나의 출처로 정규화한다", () => {
  const result = normalizeObservation(raw);
  assert.equal(result.schema_version, "normalized-0.4.0");
  assert.equal(result.sources.length, 1);
  assert.equal(result.source_summary.total_unique_sources, 1);
  assert.equal(result.source_summary.total_citation_occurrences, 1);
  assert.deepEqual(result.source_summary.citation_occurrences_by_ownership, { first_party: 1 });
  assert.deepEqual(result.source_summary.unique_sources_by_ownership, { first_party: 1 });
  assert.equal(result.turns[0].source_refs.length, 1);
  assert.equal(result.turns[0].source_refs[0].relationship, "citation_and_link");
  assert.equal(result.sources[0].ownership.owner_entity_id, "oganacell_magok");
  assert.equal(result.sources[0].classification.page_type, "doctor_profile");
});

test("같은 입력은 같은 source ID를 만든다", () => {
  const first = normalizeObservation(raw);
  const second = normalizeObservation(raw);
  assert.equal(first.sources[0].source_id, second.sources[0].source_id);
  assert.deepEqual(first, second);
});

test("Collector 0.2 실측 자료도 호환한다", () => {
  const legacy = structuredClone(raw);
  legacy.schema_version = "0.2.0-draft";
  legacy.turn_candidates[0].response_candidates[0].citation_groups = undefined;
  legacy.turn_candidates[0].response_candidates[0].citation_candidates = [
    { citation_id: "citation_1", group_id: "group_1", href: null },
    { citation_id: "citation_2", group_id: "group_1", href: "https://www.oganacell-magok.com/company/doctor.html?utm_source=chatgpt.com" }
  ];
  const result = normalizeObservation(legacy);
  assert.equal(result.provenance.raw_schema_version, "0.2.0-draft");
  assert.equal(result.sources.length, 1);
  assert.equal(result.source_summary.total_citation_occurrences, 1);
});

test("Collector 0.4 대화 경계를 보존하고 독립 질문을 검증한다", () => {
  const modern = structuredClone(raw);
  modern.schema_version = "0.4.0-draft";
  modern.measurement = { measurement_type: "independent_query", boundary_strategy: "user_confirmed" };
  modern.conversation_instances = [{ conversation_instance_id: "conversation_1", started_at: "2026-08-14T00:00:00Z", ended_at: "2026-08-14T00:01:00Z", boundary_source: "measurement_started", context_ids: ["context_1"], chat_modes: ["temporary"] }];
  modern.turn_candidates[0].conversation_instance_id = "conversation_1";
  const result = normalizeObservation(modern);
  assert.equal(result.measurement.measurement_type, "independent_query");
  assert.equal(result.conversations[0].turn_count, 1);
  assert.equal(result.conversations[0].effective_chat_mode, "temporary");
  assert.deepEqual(result.conversations[0].turn_chat_modes, ["temporary"]);
  assert.equal(result.turns[0].conversation_instance_id, "conversation_1");
  assert.equal(result.normalization_warnings.some((warning) => warning.code === "independent_query_turn_count"), false);
});

test("독립 질문 대화에 여러 turn이 있으면 경고한다", () => {
  const modern = structuredClone(raw);
  modern.schema_version = "0.4.0-draft";
  modern.measurement = { measurement_type: "independent_query", boundary_strategy: "user_confirmed" };
  modern.conversation_instances = [{ conversation_instance_id: "conversation_1", started_at: "2026-08-14T00:00:00Z", ended_at: null, boundary_source: "measurement_started", context_ids: ["context_1"], chat_modes: ["temporary"] }];
  modern.turn_candidates[0].conversation_instance_id = "conversation_1";
  modern.turn_candidates.push({ ...structuredClone(modern.turn_candidates[0]), turn_id: "turn_2", turn_index: 2 });
  const result = normalizeObservation(modern);
  const warning = result.normalization_warnings.find((item) => item.code === "independent_query_turn_count");
  assert.equal(warning.observed_turn_count, 2);
});

test("Collector 0.5 query metadata를 대화와 turn에 보존한다", () => {
  const modern = structuredClone(raw);
  modern.schema_version = "0.5.0-draft";
  modern.measurement = { measurement_type: "independent_query", boundary_strategy: "user_confirmed", query_set: { query_set_id: "magok_v1", total_runs: 2 } };
  const query = { query_set_id: "magok_v1", query_id: "q_001", category: "local", repetition: 1, expected_prompt: "마곡점 원장 이력은?", observed_prompt: "마곡점 원장 이력은?", prompt_match: "exact" };
  modern.conversation_instances = [{ conversation_instance_id: "conversation_1", started_at: "2026-08-14T00:00:00Z", ended_at: null, boundary_source: "measurement_started", query, context_ids: ["context_1"], chat_modes: ["temporary"] }];
  modern.turn_candidates[0].conversation_instance_id = "conversation_1";
  const result = normalizeObservation(modern);
  assert.equal(result.measurement.query_set.query_set_id, "magok_v1");
  assert.deepEqual(result.conversations[0].query, query);
  assert.deepEqual(result.turns[0].query, query);
});

test("질문 세트 예상 질문과 실제 질문의 불일치를 경고한다", () => {
  const modern = structuredClone(raw);
  modern.schema_version = "0.5.0-draft";
  modern.measurement = { measurement_type: "independent_query", boundary_strategy: "user_confirmed", query_set: { query_set_id: "magok_v1", total_runs: 1 } };
  modern.conversation_instances = [{ conversation_instance_id: "conversation_1", boundary_source: "measurement_started", query: { query_set_id: "magok_v1", query_id: "q_001", category: "local", repetition: 1, expected_prompt: "예상 질문", observed_prompt: "다른 질문", prompt_match: "mismatch" }, context_ids: ["context_1"], chat_modes: ["temporary"] }];
  modern.turn_candidates[0].conversation_instance_id = "conversation_1";
  const result = normalizeObservation(modern);
  assert.equal(result.normalization_warnings.find((warning) => warning.code === "query_prompt_mismatch")?.query_id, "q_001");
});

test("Collector 0.6 단일 탭과 목표 채팅 모드를 보존한다", () => {
  const modern = structuredClone(raw);
  modern.schema_version = "0.6.0-draft";
  modern.measurement = { measurement_type: "independent_query", boundary_strategy: "user_confirmed_new_chat", tab_scope: "single_tab", desired_chat_mode: "temporary", query_set: { query_set_id: "magok_v1", total_runs: 1 } };
  const result = normalizeObservation(modern);
  assert.equal(result.measurement.tab_scope, "single_tab");
  assert.equal(result.measurement.desired_chat_mode, "temporary");
  assert.equal(result.measurement.boundary_strategy, "user_confirmed_new_chat");
});

test("Collector 0.7 네트워크 모델 관측값을 환경과 턴에 보존한다", () => {
  const modern = structuredClone(raw);
  modern.schema_version = "0.7.0-draft";
  modern.environment = { ...modern.environment, requested_model: "gpt-5-6", displayed_model: "GPT-5.6 Sol", model_detection_source: "network_request" };
  modern.measurement = { measurement_type: "conversation_journey", boundary_strategy: "user_confirmed_new_chat", tab_scope: "single_tab", desired_chat_mode: "temporary", query_set: null };
  modern.conversation_instances = [{ conversation_instance_id: "conversation_1", started_at: "2026-08-14T00:00:00Z", ended_at: null, boundary_source: "measurement_started", query: null, context_ids: ["context_1"], chat_modes: ["temporary"] }];
  modern.turn_candidates[0].conversation_instance_id = "conversation_1";
  modern.turn_candidates[0].model_observation = { requested_model: "gpt-5-6", displayed_model: "GPT-5.6 Sol", detection_source: "network_request", captured_at: "2026-08-14T00:00:01Z", client_prepare_dispatch: "immediate", client_prepare_source: "context_change", history_and_training_disabled: true };
  const result = normalizeObservation(modern);
  assert.equal(result.environment.requested_model, "gpt-5-6");
  assert.equal(result.environment.model_detection_source, "network_request");
  assert.equal(result.turns[0].model_observation.displayed_model, "GPT-5.6 Sol");
  assert.deepEqual(result.conversations[0].requested_models, ["gpt-5-6"]);
});

test("지도 UI 보조 링크를 출처 집계에서 제외하되 표시 인용은 보존한다", () => {
  const modern = structuredClone(raw);
  const response = modern.turn_candidates[0].response_candidates[0];
  response.citation_groups = [
    { group_id: "group_clinic", canonical_url: "https://www.oganacell-magok.com/company/doctor.html" },
    { group_id: "group_mapbox_citation", canonical_url: "https://www.mapbox.com/blog/cited-map-article" }
  ];
  response.link_candidates = [
    { href: "https://www.mapbox.com/", aria_label: "Mapbox homepage" },
    { href: "https://www.mapbox.com/about/maps", text: "Mapbox" },
    { href: "https://www.mapbox.com/legal/end-user-terms", text: "약관" },
    { href: "http://www.openstreetmap.org/about", text: "OpenStreetMap" },
    { href: "https://www.mapbox.com/blog/cited-map-article", text: "인용된 지도 문서" }
  ];
  const result = normalizeObservation(modern);
  assert.equal(result.turns[0].search_observation.source_count, 2);
  assert.equal(result.turns[0].search_observation.excluded_auxiliary_link_count, 4);
  assert.equal(result.turns[0].excluded_link_candidates.every((link) => link.reason === "map_attribution"), true);
  assert.equal(result.sources.some((source) => source.canonical_url === "https://www.mapbox.com/blog/cited-map-article"), true);
  assert.equal(result.sources.some((source) => source.canonical_url === "https://www.mapbox.com/about/maps"), false);
});
