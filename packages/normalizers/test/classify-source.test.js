import test from "node:test";
import assert from "node:assert/strict";
import { classifySource, registry } from "../src/index.js";

test("마곡 공식 의료진 페이지를 결정적으로 분류한다", () => {
  const result = classifySource("https://oganacell-magok.com/company/doctor.html", registry);
  assert.deepEqual(result.ownership, { type: "first_party", owner_entity_id: "oganacell_magok", method: "verified_registry" });
  assert.equal(result.classification.source_type, "official_branch_site");
  assert.equal(result.classification.page_type, "doctor_profile");
});

test("잡코리아는 외부 채용 출처로 분류한다", () => {
  const result = classifySource("https://jobkorea.co.kr/Recruit/GI_Read/123", registry);
  assert.equal(result.ownership.type, "third_party");
  assert.equal(result.classification.source_type, "recruitment");
  assert.equal(result.classification.page_type, "recruitment");
});

test("미등록 출처는 추측하지 않는다", () => {
  const result = classifySource("https://unknown.example/something", registry);
  assert.equal(result.ownership.type, "unknown");
  assert.equal(result.classification.page_type, "unknown");
});

