(() => {
  const MAX_QUERIES = 50;
  const MAX_RESULTS = 100;
  const MAX_TEXT_LENGTH = 2000;

  function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text ? text.slice(0, maxLength) : null;
  }

  function cleanUrl(value) {
    const text = cleanText(value, 8000);
    if (!text) return null;
    try {
      const url = new URL(text);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function sanitizeResult(entry) {
    if (!entry || typeof entry !== "object") return null;
    const url = cleanUrl(entry.url || entry.href);
    if (!url) return null;
    return {
      url,
      title: cleanText(entry.title, 1000),
      snippet: cleanText(entry.snippet || entry.text || entry.description),
      attribution: cleanText(entry.attribution || entry.site_name || entry.source, 500)
    };
  }

  function sanitizeGroup(group) {
    if (!group || typeof group !== "object") return null;
    const entries = (Array.isArray(group.entries) ? group.entries : Array.isArray(group.results) ? group.results : [])
      .map(sanitizeResult).filter(Boolean).slice(0, MAX_RESULTS);
    if (!entries.length) return null;
    return { domain: cleanText(group.domain || group.name, 500), entries };
  }

  function extractSearchSignals(payload) {
    const queries = [];
    const resultGroups = [];
    const tools = [];
    let searchStarted = false;
    const seen = new Set();

    function visit(value) {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (value.type === "message_marker" && value.marker === "search_start") searchStarted = true;
      if (value.type === "search_model_queries" && Array.isArray(value.queries)) {
        for (const query of value.queries) {
          const cleaned = cleanText(query);
          if (cleaned && !queries.includes(cleaned) && queries.length < MAX_QUERIES) queries.push(cleaned);
        }
      }
      if (value.type === "search_result_group") {
        const group = sanitizeGroup(value);
        if (group && resultGroups.length < MAX_RESULTS) resultGroups.push(group);
      }
      if (value.type === "server_ste_metadata" && value.metadata && typeof value.metadata === "object") {
        const toolName = cleanText(value.metadata.tool_name, 500);
        if (toolName || value.metadata.tool_invoked === true) tools.push({ tool_name: toolName, tool_invoked: value.metadata.tool_invoked === true });
      }
      for (const child of Object.values(value)) visit(child);
    }

    visit(payload);
    const signals = [];
    if (searchStarted) signals.push({ event_type: "search_started" });
    if (queries.length) signals.push({ event_type: "search_queries", queries });
    if (resultGroups.length) signals.push({ event_type: "search_results", result_groups: resultGroups });
    for (const tool of tools) signals.push({ event_type: "search_tool", ...tool });
    return signals;
  }

  function createSseParser(onPayload) {
    let buffer = "";
    function parseBlock(block) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      try { onPayload(JSON.parse(data)); } catch (_) {}
    }
    return {
      push(chunk) {
        buffer += chunk;
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) parseBlock(block);
      },
      finish() { if (buffer.trim()) parseBlock(buffer); buffer = ""; }
    };
  }

  globalThis.AIObserverStreamParser = { createSseParser, extractSearchSignals };
})();
