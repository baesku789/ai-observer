import { normalizeUrl } from "../../normalizers/src/normalize-url.js";

function validateRaw(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("raw observation must be an object");
  if (!Array.isArray(raw.turn_candidates)) throw new Error("turn_candidates must be an array");
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function canonicalize(url) {
  if (!url) return null;
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

function collectSearch(events) {
  const rewrittenQueries = uniqueStrings(events.flatMap((event) => event.event_type === "search_queries" ? event.queries || [] : []));
  const toolNames = uniqueStrings(events.filter((event) => event.event_type === "search_tool").map((event) => event.tool_name));
  const results = new Map();
  let observedResultCount = 0;

  for (const event of events.filter((item) => item.event_type === "search_results")) {
    for (const group of event.result_groups || []) {
      for (const entry of group.entries || []) {
        observedResultCount += 1;
        const canonicalUrl = canonicalize(entry.url);
        if (!canonicalUrl || results.has(canonicalUrl)) continue;
        results.set(canonicalUrl, {
          canonical_url: canonicalUrl,
          observed_url: entry.url,
          domain: new URL(canonicalUrl).hostname,
          reported_domain: group.domain || null,
          title: entry.title || null,
          snippet: entry.snippet || null,
          attribution: entry.attribution || null
        });
      }
    }
  }

  return {
    status: rewrittenQueries.length || results.size || events.some((event) => event.event_type === "search_started") ? "observed" : "not_observed",
    evidence: events.length ? "network_search_events" : "none",
    rewritten_queries: rewrittenQueries,
    query_count: rewrittenQueries.length,
    result_candidates: [...results.values()],
    observed_result_count: observedResultCount,
    unique_result_count: results.size,
    tool_names: toolNames,
    tool_invoked: events.some((event) => event.event_type === "search_tool" && event.tool_invoked === true)
  };
}

function collectCitations(response, searchResults, turnIndex, responseIndex) {
  if (!response) return [];
  const citations = new Map();

  for (const [groupIndex, group] of (response.citation_groups || []).entries()) {
    const canonicalUrl = canonicalize(group.canonical_url);
    if (!canonicalUrl) continue;
    if (!citations.has(canonicalUrl)) {
      const searchResult = searchResults.get(canonicalUrl) || null;
      citations.set(canonicalUrl, {
        citation_order: citations.size + 1,
        canonical_url: canonicalUrl,
        domain: new URL(canonicalUrl).hostname,
        observed_labels: [],
        citation_group_ids: [],
        evidence_types: [],
        was_search_result: Boolean(searchResult),
        search_result: searchResult,
        mapping: {
          citation_group_id: group.group_id || null,
          raw_citation_pointer: `$.turn_candidates[${turnIndex}].response_candidates[${responseIndex}].citation_groups[${groupIndex}]`
        }
      });
    }
    const citation = citations.get(canonicalUrl);
    citation.observed_labels = uniqueStrings([...citation.observed_labels, group.text]);
    citation.citation_group_ids = uniqueStrings([...citation.citation_group_ids, group.group_id]);
    citation.evidence_types = uniqueStrings([...citation.evidence_types, ...(group.evidence_types || [])]);
  }

  return [...citations.values()];
}

function structureTurn(rawTurn, turnIndex, contexts, conversations, raw) {
  const events = Array.isArray(rawTurn.search_events) ? rawTurn.search_events : [];
  const search = collectSearch(events);
  const searchResults = new Map(search.result_candidates.map((result) => [result.canonical_url, result]));
  const responseCandidates = rawTurn.response_candidates || [];
  const responseIndex = Math.max(0, responseCandidates.findIndex((candidate) => candidate.role === "assistant"));
  const response = responseCandidates[responseIndex] || null;
  const conversation = conversations.get(rawTurn.conversation_instance_id) || null;
  const query = conversation?.query || null;

  return {
    turn_id: rawTurn.turn_id || null,
    turn_index: rawTurn.turn_index ?? null,
    context_id: rawTurn.context_id || null,
    conversation_instance_id: rawTurn.conversation_instance_id || null,
    chat_mode: contexts.get(rawTurn.context_id)?.chat_mode || "unknown",
    question: rawTurn.prompt ? {
      observed_text: rawTurn.prompt.text || "",
      provenance: "raw_turn_prompt"
    } : null,
    search,
    answer: response ? {
      response_id: response.candidate_id || null,
      observed_text: response.text || "",
      completion_state: response.completion_state || null,
      provenance: "raw_response_candidate"
    } : null,
    citations: collectCitations(response, searchResults, turnIndex, responseIndex),
    mapping: {
      observation_id: raw.observation_id || null,
      run_id: raw.run_id || null,
      conversation_instance_id: rawTurn.conversation_instance_id || null,
      run_index: conversation?.run_index ?? null,
      query_set_id: query?.query_set_id || raw.measurement?.query_set?.query_set_id || null,
      query_id: query?.query_id || null,
      category: query?.category || null,
      repetition: query?.repetition ?? null,
      prompt_match: query?.prompt_match || null,
      turn_id: rawTurn.turn_id || null,
      response_id: response?.candidate_id || null,
      raw_turn_pointer: `$.turn_candidates[${turnIndex}]`,
      raw_prompt_pointer: rawTurn.prompt ? `$.turn_candidates[${turnIndex}].prompt` : null,
      raw_response_pointer: response ? `$.turn_candidates[${turnIndex}].response_candidates[${responseIndex}]` : null
    },
    analysis: {
      status: "not_performed",
      question_conditions: [],
      citation_reasons: [],
      note: "No private reasoning is available; semantic inference requires a separate rules or model stage."
    }
  };
}

export function structureObservation(raw, options = {}) {
  validateRaw(raw);
  const contexts = new Map((raw.chat_contexts || []).map((context) => [context.context_id, context]));
  const conversations = new Map((raw.conversation_instances || []).map((conversation) => [conversation.conversation_instance_id, conversation]));
  const turns = raw.turn_candidates.map((turn, index) => structureTurn(turn, index, contexts, conversations, raw));

  return {
    schema_version: "structured-observation-0.1.0",
    provenance: {
      source_path: options.sourcePath || null,
      raw_schema_version: raw.schema_version || null,
      observation_id: raw.observation_id || null,
      run_id: raw.run_id || null,
      captured_at: raw.captured_at || null,
      collector: raw.collector || null
    },
    environment: {
      surface: raw.surface || null,
      account_plan: raw.environment?.account_plan || null,
      requested_model: raw.environment?.requested_model || null,
      displayed_model: raw.environment?.displayed_model || null
    },
    measurement: {
      measurement_type: raw.measurement?.measurement_type || null,
      query_set: raw.measurement?.query_set || null
    },
    turns,
    summary: {
      turn_count: turns.length,
      query_count: turns.reduce((sum, turn) => sum + turn.search.query_count, 0),
      observed_search_result_count: turns.reduce((sum, turn) => sum + turn.search.observed_result_count, 0),
      unique_search_result_count: turns.reduce((sum, turn) => sum + turn.search.unique_result_count, 0),
      final_cited_source_count: new Set(turns.flatMap((turn) => turn.citations.map((citation) => citation.canonical_url))).size
    }
  };
}

export function createObservationView(structured) {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("structured observation must be an object");
  }
  if (!Array.isArray(structured.turns)) throw new Error("structured turns must be an array");

  return {
    schema_version: "observation-view-0.1.0",
    measurement_id: structured.provenance?.observation_id || null,
    captured_at: structured.provenance?.captured_at || null,
    records: structured.turns.map((turn) => ({
      question: {
        id: turn.mapping?.query_id || null,
        repetition: turn.mapping?.repetition ?? null,
        text: turn.question?.observed_text || ""
      },
      search: {
        status: turn.search?.status || "not_observed",
        queries: turn.search?.rewritten_queries || [],
        result_count: turn.search?.unique_result_count ?? 0
      },
      answer: turn.answer ? { text: turn.answer.observed_text || "" } : null,
      citations: (turn.citations || []).map((citation) => ({
        order: citation.citation_order,
        label: citation.observed_labels?.[0] || citation.search_result?.title || null,
        domain: citation.domain,
        url: citation.canonical_url
      }))
    })),
    summary: {
      record_count: structured.turns.length,
      cited_source_count: structured.summary?.final_cited_source_count
        ?? new Set(structured.turns.flatMap((turn) => (turn.citations || []).map((citation) => citation.canonical_url))).size
    }
  };
}
