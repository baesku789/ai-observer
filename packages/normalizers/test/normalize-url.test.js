import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, registry } from "../src/index.js";

test("추적 파라미터를 제거하고 공식 호스트를 통합한다", () => {
  assert.equal(normalizeUrl("https://www.oganamagokworld.com/ko/?utm_source=chatgpt.com&gclid=x#top", registry.hosts), "https://oganamagokworld.com/ko");
});

test("페이지 의미를 가진 query parameter는 보존하고 정렬한다", () => {
  assert.equal(normalizeUrl("https://example.com/price?utm_medium=x&categorycode=1042&b=2", registry.hosts), "https://example.com/price?b=2&categorycode=1042");
});

