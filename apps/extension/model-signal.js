const DISPLAY_MODEL_BY_REQUESTED_MODEL = Object.freeze({
  "gpt-5-6": "GPT-5.6 Sol",
  "gpt-5-6-instant": "GPT-5.6 Sol",
  "gpt-5-5": "GPT-5.5",
  "gpt-5-5-instant": "GPT-5.5",
  o3: "o3"
});

function decodeRawRequestBody(raw = []) {
  const decoder = new TextDecoder();
  return raw.map((item, index) => {
    if (!item?.bytes) return "";
    return decoder.decode(item.bytes, { stream: index < raw.length - 1 });
  }).join("");
}

export function displayedModelFor(requestedModel) {
  return DISPLAY_MODEL_BY_REQUESTED_MODEL[requestedModel] || null;
}

export function modelSignalFromRequestBody(requestBody) {
  if (!requestBody || requestBody.error) return null;
  try {
    const body = JSON.parse(decodeRawRequestBody(requestBody.raw));
    if (typeof body?.model !== "string" || !body.model.trim()) return null;
    const requestedModel = body.model.trim();
    return {
      requested_model: requestedModel,
      displayed_model: displayedModelFor(requestedModel),
      client_prepare_dispatch: typeof body.client_prepare_dispatch === "string" ? body.client_prepare_dispatch : null,
      client_prepare_source: typeof body.client_prepare_source === "string" ? body.client_prepare_source : null,
      history_and_training_disabled: typeof body.history_and_training_disabled === "boolean" ? body.history_and_training_disabled : null
    };
  } catch (_) {
    return null;
  }
}
