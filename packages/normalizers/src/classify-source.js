export function classifySource(canonicalUrl, registry) {
  const url = new URL(canonicalUrl);
  const hostRule = registry.hosts[url.hostname];
  const pageRule = registry.pageRules.find((rule) => url.pathname.toLowerCase().includes(rule.path_contains.toLowerCase()));
  const homepage = url.pathname === "/" || /^\/(ko|en|ja|zh-tw)?\/?$/i.test(url.pathname);
  const sourceTypeFallbacks = { medical_directory: "medical_directory", social_platform: "social_profile", recruitment: "recruitment" };
  const pageType = pageRule?.page_type || (homepage ? "homepage" : sourceTypeFallbacks[hostRule?.source_type]) || "unknown";
  return {
    ownership: {
      type: hostRule?.ownership_type || "unknown",
      owner_entity_id: hostRule?.owner_entity_id || null,
      method: hostRule ? "verified_registry" : "unmatched"
    },
    classification: {
      source_type: hostRule?.source_type || "unknown",
      page_type: pageType,
      method: pageRule ? "path_rule" : homepage ? "homepage_rule" : sourceTypeFallbacks[hostRule?.source_type] ? "source_type_fallback" : "unmatched"
    }
  };
}
