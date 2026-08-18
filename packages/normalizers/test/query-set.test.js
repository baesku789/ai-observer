import test from "node:test";
import assert from "node:assert/strict";
import { expandQuerySet, querySetMetadata } from "../../../apps/extension/query-set.js";

test("질문 세트를 반복 실행 큐로 펼친다", () => {
  const definition = { query_set_id: "magok_v1", version: "1", queries: [{ query_id: "q1", text: "마곡 피부과?", category: "local", repetitions: 2 }, { query_id: "q2", text: "김포공항 피부과?" }] };
  const runs = expandQuerySet(definition);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((run) => [run.query_id, run.repetition]), [["q1", 1], ["q1", 2], ["q2", 1]]);
  assert.equal(querySetMetadata(definition, runs.length).total_runs, 3);
});

test("중복 query_id를 거부한다", () => {
  assert.throws(() => expandQuerySet({ query_set_id: "x", queries: [{ query_id: "q1", text: "a" }, { query_id: "q1", text: "b" }] }), /중복 query_id/);
});
