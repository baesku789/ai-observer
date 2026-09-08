(() => {
  if (globalThis.__aiObserverStreamInterceptorInstalled) return;
  globalThis.__aiObserverStreamInterceptorInstalled = true;

  const parserApi = globalThis.AIObserverStreamParser;
  if (!parserApi || typeof globalThis.fetch !== "function") return;
  const originalFetch = globalThis.fetch;
  let activeRunId = null;

  globalThis.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== globalThis || data?.source !== "ai-observer-content" || data?.type !== "capture-control") return;
    activeRunId = data.active && typeof data.run_id === "string" ? data.run_id : null;
  });

  function isConversationStream(input, response) {
    try {
      const rawUrl = response?.url || (typeof input === "string" ? input : input?.url);
      const url = new URL(rawUrl, location.href);
      return url.origin === location.origin && url.pathname === "/backend-api/f/conversation";
    } catch (_) {
      return false;
    }
  }

  function emit(runId, streamId, signal) {
    globalThis.postMessage({
      source: "ai-observer-main",
      type: "network-search-signal",
      run_id: runId,
      signal: { ...signal, signal_id: crypto.randomUUID(), stream_id: streamId, captured_at: new Date().toISOString(), source: "network_stream" }
    }, location.origin);
  }

  async function observeResponse(response, runId, streamId) {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    const fingerprints = new Set();
    const parser = parserApi.createSseParser((payload) => {
      for (const signal of parserApi.extractSearchSignals(payload)) {
        const fingerprint = JSON.stringify(signal);
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        emit(runId, streamId, signal);
      }
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.finish();
    } catch (_) {
      emit(runId, streamId, { event_type: "search_capture_error", error_code: "stream_read_failed" });
    }
  }

  globalThis.fetch = async function (...args) {
    const runId = activeRunId;
    const response = await Reflect.apply(originalFetch, this, args);
    if (runId && isConversationStream(args[0], response)) {
      const contentType = response.headers?.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        try { observeResponse(response.clone(), runId, crypto.randomUUID()); }
        catch (_) { emit(runId, crypto.randomUUID(), { event_type: "search_capture_error", error_code: "stream_clone_failed" }); }
      }
    }
    return response;
  };
})();
