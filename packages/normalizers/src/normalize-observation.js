import { registry as defaultRegistry } from "./registry.js";
import { normalizeUrl } from "./normalize-url.js";
import { classifySource } from "./classify-source.js";
import { classifyAuxiliaryLink } from "./classify-auxiliary-link.js";
import { stableId } from "./stable-id.js";

function detectLanguage(text) {
  if (!text) return null;
  if (/[가-힣]/.test(text)) return "ko";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  return "und";
}

function validateRaw(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") errors.push("root must be an object");
  if (!/^0\.(2|3|4|5|6|7)\./.test(raw?.schema_version || "")) errors.push(`unsupported schema_version: ${raw?.schema_version ?? "missing"}`);
  if (!Array.isArray(raw?.turn_candidates)) errors.push("turn_candidates must be an array");
  if (errors.length) throw new Error(`Invalid raw observation: ${errors.join("; ")}`);
}

function logicalCitationGroups(response) {
  if (Array.isArray(response.citation_groups)) return response.citation_groups;
  const groups = new Map();
  for (const candidate of response.citation_candidates || []) {
    const groupId = candidate.group_id || candidate.citation_id;
    if (!groups.has(groupId)) groups.set(groupId, { group_id: groupId, canonical_url: null, candidate_ids: [] });
    const group = groups.get(groupId);
    group.candidate_ids.push(candidate.citation_id);
    if (!group.canonical_url && candidate.href) group.canonical_url = candidate.href;
  }
  return [...groups.values()];
}

export function normalizeObservation(raw, registry = defaultRegistry) {
  validateRaw(raw);
  const warnings = [];
  const contextById = new Map((raw.chat_contexts || []).map((context) => [context.context_id, context]));
  const conversationById = new Map((raw.conversation_instances || []).map((conversation) => [conversation.conversation_instance_id, conversation]));
  const sourceMap = new Map();
  const turns = [];

  function ensureSource(originalUrl, turnId, relationship, displayOrder) {
    let canonicalUrl;
    try { canonicalUrl = normalizeUrl(originalUrl, registry.hosts); }
    catch (_) {
      warnings.push({ code: "invalid_url", severity: "warning", turn_id: turnId, original_url: originalUrl });
      return null;
    }
    const sourceId = stableId("src", canonicalUrl);
    if (!sourceMap.has(sourceId)) {
      const classified = classifySource(canonicalUrl, registry);
      sourceMap.set(sourceId, {
        source_id: sourceId,
        original_urls: new Set(),
        canonical_url: canonicalUrl,
        domain: new URL(canonicalUrl).hostname,
        ...classified,
        observations: { turn_ids: new Set(), citation_count: 0, link_count: 0, first_display_order: displayOrder }
      });
      if (classified.ownership.type === "unknown") warnings.push({ code: "unknown_source_owner", severity: "info", source_id: sourceId, canonical_url: canonicalUrl });
      if (classified.classification.page_type === "unknown") warnings.push({ code: "unknown_page_type", severity: "info", source_id: sourceId, canonical_url: canonicalUrl });
    }
    const source = sourceMap.get(sourceId);
    source.original_urls.add(originalUrl);
    source.observations.turn_ids.add(turnId);
    if (relationship.includes("citation")) source.observations.citation_count += 1;
    if (relationship.includes("link")) source.observations.link_count += 1;
    source.observations.first_display_order = Math.min(source.observations.first_display_order, displayOrder);
    return { source_id: sourceId, relationship, display_order: displayOrder };
  }

  for (const rawTurn of raw.turn_candidates) {
    const context = contextById.get(rawTurn.context_id);
    if (!context) warnings.push({ code: "missing_context", severity: "warning", turn_id: rawTurn.turn_id, context_id: rawTurn.context_id });
    if (/^0\.(4|5|6|7)\./.test(raw.schema_version) && !conversationById.has(rawTurn.conversation_instance_id)) warnings.push({ code: "missing_conversation_instance", severity: "warning", turn_id: rawTurn.turn_id, conversation_instance_id: rawTurn.conversation_instance_id });
    if (!rawTurn.prompt) warnings.push({ code: "missing_prompt", severity: "warning", turn_id: rawTurn.turn_id });
    if ((rawTurn.response_candidates || []).length > 1) warnings.push({ code: "multiple_response_candidates", severity: "info", turn_id: rawTurn.turn_id, count: rawTurn.response_candidates.length });
    const sourceRefs = new Map();
    const excludedLinkCandidates = [];
    const responses = (rawTurn.response_candidates || []).map((response) => {
      const citationUrls = new Set();
      for (const [index, group] of logicalCitationGroups(response).entries()) {
        if (!group.canonical_url) {
          warnings.push({ code: "citation_group_without_url", severity: "info", turn_id: rawTurn.turn_id, citation_group_id: group.group_id });
          continue;
        }
        const ref = ensureSource(group.canonical_url, rawTurn.turn_id, "displayed_citation", index + 1);
        if (ref) { ref.citation_group_id = group.group_id; sourceRefs.set(ref.source_id, ref); citationUrls.add(normalizeUrl(group.canonical_url, registry.hosts)); }
      }
      for (const [index, link] of (response.link_candidates || []).entries()) {
        if (!link.href) continue;
        let normalized;
        try { normalized = normalizeUrl(link.href, registry.hosts); } catch (_) { normalized = null; }
        if (normalized && citationUrls.has(normalized)) {
          const existing = sourceRefs.get(stableId("src", normalized));
          if (existing) existing.relationship = "citation_and_link";
          continue;
        }
        const auxiliary = classifyAuxiliaryLink(link);
        if (auxiliary) {
          excludedLinkCandidates.push({ href: link.href, text: link.text || null, aria_label: link.aria_label || null, reason: auxiliary.classification, rule_id: auxiliary.rule_id });
          continue;
        }
        const ref = ensureSource(link.href, rawTurn.turn_id, "answer_link", index + 1);
        if (ref && !sourceRefs.has(ref.source_id)) sourceRefs.set(ref.source_id, ref);
      }
      return { response_id: response.candidate_id, role: response.role, text: response.text, language: detectLanguage(response.text), completion_state: response.completion_state, first_seen_at: response.first_seen_at, last_updated_at: response.last_updated_at };
    });
    const refs = [...sourceRefs.values()].sort((a, b) => a.display_order - b.display_order);
    turns.push({ turn_id: rawTurn.turn_id, context_id: rawTurn.context_id, conversation_instance_id: rawTurn.conversation_instance_id || null, turn_index: rawTurn.turn_index, chat_mode: context?.chat_mode || "unknown", model_observation: rawTurn.model_observation || null, question: rawTurn.prompt ? { text: rawTurn.prompt.text, language: detectLanguage(rawTurn.prompt.text) } : null, responses, search_observation: { status: refs.length ? "observed" : "not_observed", evidence: refs.length ? "displayed_citations_or_links" : "no_displayed_source", source_count: refs.length, excluded_auxiliary_link_count: excludedLinkCandidates.length }, source_refs: refs, excluded_link_candidates: excludedLinkCandidates });
  }

  const measurementType = raw.measurement?.measurement_type || "legacy_unspecified";
  const conversations = (raw.conversation_instances || []).map((conversation) => {
    const conversationTurns = turns.filter((turn) => turn.conversation_instance_id === conversation.conversation_instance_id);
    const turnChatModes = [...new Set(conversationTurns.map((turn) => turn.chat_mode).filter(Boolean))];
    const effectiveChatMode = turnChatModes.length === 1 ? turnChatModes[0] : turnChatModes.length > 1 ? "mixed" : null;
    if (measurementType === "independent_query" && conversationTurns.filter((turn) => turn.question).length !== 1) warnings.push({ code: "independent_query_turn_count", severity: "warning", conversation_instance_id: conversation.conversation_instance_id, observed_turn_count: conversationTurns.filter((turn) => turn.question).length });
    if (conversation.query?.prompt_match === "mismatch") warnings.push({ code: "query_prompt_mismatch", severity: "warning", conversation_instance_id: conversation.conversation_instance_id, query_id: conversation.query.query_id, expected_prompt: conversation.query.expected_prompt, observed_prompt: conversation.query.observed_prompt });
    const requestedModels = [...new Set(conversationTurns.map((turn) => turn.model_observation?.requested_model).filter(Boolean))];
    const displayedModels = [...new Set(conversationTurns.map((turn) => turn.model_observation?.displayed_model).filter(Boolean))];
    return { conversation_instance_id: conversation.conversation_instance_id, started_at: conversation.started_at, ended_at: conversation.ended_at, boundary_source: conversation.boundary_source, run_index: conversation.run_index ?? null, manual_completion: conversation.manual_completion || null, query: conversation.query || null, setup_chat_modes: conversation.chat_modes || [], effective_chat_mode: effectiveChatMode, turn_chat_modes: turnChatModes, requested_models: requestedModels, displayed_models: displayedModels, context_ids: conversation.context_ids || [], turn_ids: conversationTurns.map((turn) => turn.turn_id), turn_count: conversationTurns.length };
  });
  const queryByConversation = new Map(conversations.map((conversation) => [conversation.conversation_instance_id, conversation.query]));
  for (const turn of turns) turn.query = queryByConversation.get(turn.conversation_instance_id) || null;

  const sources = [...sourceMap.values()].map((source) => ({ ...source, original_urls: [...source.original_urls], observations: { ...source.observations, turn_ids: [...source.observations.turn_ids] } })).sort((a, b) => a.source_id.localeCompare(b.source_id));
  const byOwnership = {};
  const uniqueSourcesByOwnership = {};
  const byOwnerMap = new Map();
  for (const source of sources) {
    byOwnership[source.ownership.type] = (byOwnership[source.ownership.type] || 0) + source.observations.citation_count;
    uniqueSourcesByOwnership[source.ownership.type] = (uniqueSourcesByOwnership[source.ownership.type] || 0) + 1;
    const owner = source.ownership.owner_entity_id;
    if (!owner) continue;
    if (!byOwnerMap.has(owner)) byOwnerMap.set(owner, { entity_id: owner, source_ids: new Set(), turn_ids: new Set(), citation_count: 0, page_types: {} });
    const item = byOwnerMap.get(owner); item.source_ids.add(source.source_id); source.observations.turn_ids.forEach((id) => item.turn_ids.add(id)); item.citation_count += source.observations.citation_count; item.page_types[source.classification.page_type] = (item.page_types[source.classification.page_type] || 0) + source.observations.citation_count;
  }
  const byOwner = [...byOwnerMap.values()].map((item) => ({ entity_id: item.entity_id, unique_page_count: item.source_ids.size, citation_count: item.citation_count, turn_count: item.turn_ids.size, page_types: item.page_types }));

  return {
    schema_version: "normalized-0.4.0",
    normalizer: { name: "chatgpt-web-normalizer", version: "0.4.0" },
    provenance: { raw_schema_version: raw.schema_version, observation_id: raw.observation_id, run_id: raw.run_id, source_captured_at: raw.captured_at },
    measurement: { measurement_type: measurementType, boundary_strategy: raw.measurement?.boundary_strategy || "legacy_inferred", tab_scope: raw.measurement?.tab_scope || null, desired_chat_mode: raw.measurement?.desired_chat_mode || null, query_set: raw.measurement?.query_set || null },
    environment: { surface: raw.surface, chat_modes: [...new Set((raw.chat_contexts || []).map((context) => context.chat_mode))], requested_model: raw.environment?.requested_model ?? null, displayed_model: raw.environment?.displayed_model ?? null, model_detection_source: raw.environment?.model_detection_source ?? null, displayed_mode: raw.environment?.displayed_mode ?? null, locale: raw.environment?.locale ?? null },
    conversations,
    turns,
    sources,
    source_summary: { total_unique_sources: sources.length, total_citation_occurrences: sources.reduce((sum, source) => sum + source.observations.citation_count, 0), citation_occurrences_by_ownership: byOwnership, unique_sources_by_ownership: uniqueSourcesByOwnership, by_owner: byOwner },
    normalization_warnings: warnings
  };
}
