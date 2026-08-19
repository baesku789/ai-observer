import auxiliaryLinkRules from "./registries/auxiliary-link-rules.json" with { type: "json" };

function containsAny(value, candidates = []) {
  if (!candidates.length) return true;
  const normalized = (value || "").toLocaleLowerCase();
  return candidates.some((candidate) => normalized.includes(candidate.toLocaleLowerCase()));
}

export function classifyAuxiliaryLink(link, rules = auxiliaryLinkRules.rules) {
  if (!link?.href) return null;
  let url;
  try { url = new URL(link.href); }
  catch (_) { return null; }

  for (const rule of rules) {
    if (rule.hosts?.length && !rule.hosts.includes(url.hostname.toLocaleLowerCase())) continue;
    if (rule.path_exact?.length && !rule.path_exact.includes(url.pathname)) continue;
    if (!containsAny(link.text, rule.text_contains)) continue;
    if (!containsAny(link.aria_label, rule.aria_label_contains)) continue;
    return { classification: rule.classification, rule_id: rule.rule_id };
  }
  return null;
}
