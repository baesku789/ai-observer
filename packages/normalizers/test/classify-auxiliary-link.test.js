import test from "node:test";
import assert from "node:assert/strict";
import { classifyAuxiliaryLink } from "../src/classify-auxiliary-link.js";

test("지도 저작권과 약관 링크를 UI 보조 링크로 분류한다", () => {
  const links = [
    { href: "https://www.mapbox.com/", aria_label: "Mapbox homepage" },
    { href: "https://www.mapbox.com/about/maps", text: "Mapbox" },
    { href: "https://www.mapbox.com/legal/end-user-terms", text: "약관" },
    { href: "http://www.openstreetmap.org/about", text: "OpenStreetMap" }
  ];
  assert.deepEqual(links.map((link) => classifyAuxiliaryLink(link)?.classification), ["map_attribution", "map_attribution", "map_attribution", "map_attribution"]);
});

test("일반 지도 관련 문서와 다른 사이트 링크는 제외하지 않는다", () => {
  assert.equal(classifyAuxiliaryLink({ href: "https://www.mapbox.com/blog/example", text: "Mapbox 기술 문서" }), null);
  assert.equal(classifyAuxiliaryLink({ href: "https://example.com/about", text: "OpenStreetMap" }), null);
  assert.equal(classifyAuxiliaryLink({ href: "https://www.mapbox.com/", text: "Mapbox" }), null);
});
