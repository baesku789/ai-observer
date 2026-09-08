import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createObservationView, structureObservation } from "../src/structure-observation.js";

const execFileAsync = promisify(execFile);

function fixture() {
  return {
    schema_version: "0.8.0-draft",
    observation_id: "obs_test",
    run_id: "run_test",
    captured_at: "2026-09-08T01:00:00.000Z",
    collector: { name: "chatgpt-web", version: "0.8.0" },
    surface: "chatgpt_web",
    environment: {
      account_plan: "max",
      requested_model: "gpt-5-6-instant",
      displayed_model: "GPT-5.6 Sol"
    },
    chat_contexts: [{ context_id: "ctx_1", chat_mode: "temporary" }],
    measurement: {
      measurement_type: "independent_query",
      query_set: { query_set_id: "query_set_1", version: "1.0", total_runs: 1 }
    },
    conversation_instances: [{
      conversation_instance_id: "conversation_1",
      run_index: 0,
      query: {
        query_set_id: "query_set_1",
        query_id: "q_001",
        category: "clinic",
        repetition: 1,
        expected_prompt: "Find Potenza clinics in Seoul with English support",
        observed_prompt: "Find Potenza clinics in Seoul with English support",
        prompt_match: "exact"
      }
    }],
    turn_candidates: [{
      turn_id: "turn_1",
      context_id: "ctx_1",
      conversation_instance_id: "conversation_1",
      turn_index: 1,
      prompt: { text: "Find Potenza clinics in Seoul with English support" },
      search_events: [
        { event_type: "search_started", source: "network_stream" },
        { event_type: "search_queries", queries: ["Seoul Potenza English clinic", "Seoul Potenza English clinic"] },
        { event_type: "search_results", result_groups: [{
          domain: "clinic.example",
          entries: [
            { url: "https://clinic.example/potenza?utm_source=chatgpt.com", title: "Potenza Seoul", snippet: "English support" },
            { url: "https://other.example/potenza", title: "Other result", snippet: null }
          ]
        }] },
        { event_type: "search_tool", tool_name: "SonicBrowserTool", tool_invoked: true }
      ],
      response_candidates: [{
        candidate_id: "response_1",
        role: "assistant",
        text: "Clinic Example offers Potenza and English support.",
        completion_state: "quiet_candidate",
        citation_groups: [
          { group_id: "group_1", canonical_url: "https://clinic.example/potenza", text: "Clinic Example", evidence_types: ["pill", "link"] },
          { group_id: "group_1_duplicate", canonical_url: "https://clinic.example/potenza?utm_source=chatgpt.com", text: "Clinic Example duplicate", evidence_types: ["pill"] }
        ],
        citation_candidates: []
      }]
    }]
  };
}

test("관측된 질문, 검색, 답변을 손실 없이 구조화한다", () => {
  const result = structureObservation(fixture(), { sourcePath: "/tmp/raw.json" });
  const turn = result.turns[0];

  assert.equal(result.schema_version, "structured-observation-0.1.0");
  assert.equal(result.provenance.source_path, "/tmp/raw.json");
  assert.equal(turn.question.observed_text, "Find Potenza clinics in Seoul with English support");
  assert.deepEqual(turn.search.rewritten_queries, ["Seoul Potenza English clinic"]);
  assert.equal(turn.search.result_candidates.length, 2);
  assert.equal(turn.search.observed_result_count, 2);
  assert.equal(turn.search.unique_result_count, 2);
  assert.equal(turn.answer.observed_text, "Clinic Example offers Potenza and English support.");
  assert.equal(turn.answer.response_id, "response_1");
});

test("측정 결과에서 질문과 응답까지 원본 식별자와 JSON 경로로 연결한다", () => {
  const result = structureObservation(fixture());
  const turn = result.turns[0];

  assert.deepEqual(result.measurement, {
    measurement_type: "independent_query",
    query_set: { query_set_id: "query_set_1", version: "1.0", total_runs: 1 }
  });
  assert.equal(turn.mapping.observation_id, "obs_test");
  assert.equal(turn.mapping.run_id, "run_test");
  assert.equal(turn.mapping.conversation_instance_id, "conversation_1");
  assert.equal(turn.mapping.query_set_id, "query_set_1");
  assert.equal(turn.mapping.query_id, "q_001");
  assert.equal(turn.mapping.repetition, 1);
  assert.equal(turn.mapping.turn_id, "turn_1");
  assert.equal(turn.mapping.response_id, "response_1");
  assert.equal(turn.mapping.raw_turn_pointer, "$.turn_candidates[0]");
  assert.equal(turn.mapping.raw_response_pointer, "$.turn_candidates[0].response_candidates[0]");
  assert.equal(turn.citations[0].mapping.raw_citation_pointer, "$.turn_candidates[0].response_candidates[0].citation_groups[0]");
});

test("최종 인용을 canonical URL로 중복 제거하고 검색 후보와 연결한다", () => {
  const result = structureObservation(fixture());
  const citation = result.turns[0].citations[0];

  assert.equal(result.turns[0].citations.length, 1);
  assert.equal(citation.citation_order, 1);
  assert.equal(citation.canonical_url, "https://clinic.example/potenza");
  assert.equal(citation.domain, "clinic.example");
  assert.equal(citation.was_search_result, true);
  assert.equal(citation.search_result.title, "Potenza Seoul");
  assert.deepEqual(citation.observed_labels, ["Clinic Example", "Clinic Example duplicate"]);
});

test("추론을 실행하지 않았다는 사실을 명시한다", () => {
  const result = structureObservation(fixture());

  assert.deepEqual(result.turns[0].analysis, {
    status: "not_performed",
    question_conditions: [],
    citation_reasons: [],
    note: "No private reasoning is available; semantic inference requires a separate rules or model stage."
  });
});

test("검색 이벤트와 응답이 없어도 빈 관측값을 만든다", () => {
  const raw = fixture();
  delete raw.turn_candidates[0].search_events;
  raw.turn_candidates[0].response_candidates = [];
  const turn = structureObservation(raw).turns[0];

  assert.deepEqual(turn.search.rewritten_queries, []);
  assert.deepEqual(turn.search.result_candidates, []);
  assert.equal(turn.search.observed_result_count, 0);
  assert.equal(turn.search.unique_result_count, 0);
  assert.deepEqual(turn.citations, []);
  assert.equal(turn.answer, null);
});

test("잘못된 입력은 명확히 거부한다", () => {
  assert.throws(() => structureObservation({ schema_version: "0.8.0-draft" }), /turn_candidates must be an array/);
});

test("동일 입력은 동일 결과를 만든다", () => {
  assert.deepEqual(structureObservation(fixture()), structureObservation(fixture()));
});

test("사용자용 View에는 분석에 필요한 핵심 정보만 노출한다", () => {
  const view = createObservationView(structureObservation(fixture()));
  const record = view.records[0];

  assert.equal(view.schema_version, "observation-view-0.1.0");
  assert.equal(view.measurement_id, "obs_test");
  assert.deepEqual(record.question, {
    id: "q_001",
    repetition: 1,
    text: "Find Potenza clinics in Seoul with English support"
  });
  assert.deepEqual(record.search.queries, ["Seoul Potenza English clinic"]);
  assert.equal(record.search.result_count, 2);
  assert.deepEqual(record.answer, { text: "Clinic Example offers Potenza and English support." });
  assert.deepEqual(record.citations[0], {
    order: 1,
    label: "Clinic Example",
    domain: "clinic.example",
    url: "https://clinic.example/potenza"
  });
  assert.equal("mapping" in record, false);
  assert.equal("search_result" in record.citations[0], false);
});

test("응답이 없는 레코드도 사용자용 View로 안전하게 변환한다", () => {
  const raw = fixture();
  raw.turn_candidates[0].response_candidates = [];
  const record = createObservationView(structureObservation(raw)).records[0];

  assert.equal(record.answer, null);
  assert.deepEqual(record.citations, []);
});

test("CLI가 구조화 JSON 파일을 생성한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-observer-structured-"));
  const input = resolve("packages/structured-analysis/test/fixtures/basic.raw.json");
  const output = join(directory, "structured.json");

  await execFileAsync(process.execPath, ["scripts/structure-observation.js", input, "--output", output]);
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.schema_version, "structured-observation-0.1.0");
  assert.equal(result.turns[0].search.rewritten_queries[0], "Seoul Potenza English clinic");
});

test("CLI가 구조화 JSON과 사용자용 View를 함께 생성한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-observer-view-"));
  const input = resolve("packages/structured-analysis/test/fixtures/basic.raw.json");
  const output = join(directory, "structured.json");
  const viewOutput = join(directory, "view.json");

  await execFileAsync(process.execPath, [
    "scripts/structure-observation.js",
    input,
    "--output",
    output,
    "--view-output",
    viewOutput
  ]);
  const view = JSON.parse(await readFile(viewOutput, "utf8"));
  assert.equal(view.schema_version, "observation-view-0.1.0");
  assert.equal(view.records[0].question.id, null);
  assert.equal(view.records[0].question.text, "Find a clinic");
});
