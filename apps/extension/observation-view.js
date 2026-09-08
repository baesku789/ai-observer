function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function searchFrom(events = []) {
  const queries = uniqueStrings(events.flatMap((event) => event.event_type === "search_queries" ? event.queries || [] : []));
  const urls = new Set();
  for (const event of events) {
    if (event.event_type !== "search_results") continue;
    for (const group of event.result_groups || []) {
      for (const entry of group.entries || []) {
        const url = canonicalUrl(entry.url);
        if (url) urls.add(url);
      }
    }
  }
  return {
    status: queries.length || urls.size || events.some((event) => event.event_type === "search_started") ? "observed" : "not_observed",
    queries,
    result_count: urls.size
  };
}

function citationsFrom(response) {
  const citations = new Map();
  for (const group of response?.citation_groups || []) {
    const url = canonicalUrl(group.canonical_url);
    if (!url || citations.has(url)) continue;
    citations.set(url, {
      order: citations.size + 1,
      label: group.text || null,
      domain: new URL(url).hostname,
      url
    });
  }
  return [...citations.values()];
}

export function createExtensionObservationView(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.turn_candidates)) {
    throw new Error("올바른 측정 결과가 아닙니다.");
  }
  const conversations = new Map((raw.conversation_instances || []).map((item) => [item.conversation_instance_id, item]));
  const records = raw.turn_candidates.map((turn) => {
    const query = conversations.get(turn.conversation_instance_id)?.query || null;
    const response = (turn.response_candidates || []).find((candidate) => candidate.role === "assistant")
      || turn.response_candidates?.[0]
      || null;
    return {
      question: {
        id: query?.query_id || null,
        repetition: query?.repetition ?? null,
        text: turn.prompt?.text || ""
      },
      search: searchFrom(turn.search_events),
      answer: response ? { text: response.text || "" } : null,
      citations: citationsFrom(response)
    };
  });
  return {
    schema_version: "observation-view-0.1.0",
    measurement_id: raw.observation_id || null,
    captured_at: raw.captured_at || null,
    records,
    summary: {
      record_count: records.length,
      answer_count: records.filter((record) => record.answer).length,
      search_result_count: records.reduce((sum, record) => sum + record.search.result_count, 0),
      cited_source_count: new Set(records.flatMap((record) => record.citations.map((citation) => citation.url))).size
    }
  };
}
