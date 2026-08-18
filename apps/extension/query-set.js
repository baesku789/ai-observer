export function expandQuerySet(definition) {
  if (!definition || typeof definition !== "object") throw new Error("질문 세트는 JSON 객체여야 합니다.");
  if (!definition.query_set_id || typeof definition.query_set_id !== "string") throw new Error("query_set_id가 필요합니다.");
  if (!Array.isArray(definition.queries) || !definition.queries.length) throw new Error("queries 배열에 질문이 하나 이상 필요합니다.");
  const ids = new Set();
  const runs = [];
  definition.queries.forEach((query, index) => {
    if (!query.query_id || !query.text) throw new Error(`${index + 1}번째 질문에 query_id와 text가 필요합니다.`);
    if (ids.has(query.query_id)) throw new Error(`중복 query_id: ${query.query_id}`);
    ids.add(query.query_id);
    const repetitions = Number(query.repetitions ?? 1);
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error(`${query.query_id}의 repetitions는 1~20 정수여야 합니다.`);
    for (let repetition = 1; repetition <= repetitions; repetition += 1) runs.push({ query_set_id: definition.query_set_id, query_id: query.query_id, category: query.category || "uncategorized", repetition, expected_prompt: query.text });
  });
  return runs;
}

export function createQuerySetFromText(text, repetitions = 1, querySetId = `manual_${Date.now()}`) {
  const prompts = String(text || "").split(/\r?\n/).map((prompt) => prompt.trim()).filter(Boolean);
  if (!prompts.length) throw new Error("질문을 한 줄에 하나씩 입력해 주세요.");
  const repeatCount = Number(repetitions);
  if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 20) throw new Error("반복 횟수는 1~20 사이여야 합니다.");
  return {
    query_set_id: querySetId,
    version: "manual-1",
    queries: prompts.map((prompt, index) => ({ query_id: `q_${String(index + 1).padStart(3, "0")}`, text: prompt, category: "uncategorized", repetitions: repeatCount }))
  };
}

export function visibleRunIndex(currentIndex, totalRuns, promptCaptured) {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= totalRuns) return null;
  return promptCaptured && currentIndex < totalRuns - 1 ? currentIndex + 1 : currentIndex;
}

export function querySetMetadata(definition, totalRuns) {
  return { query_set_id: definition.query_set_id, version: definition.version || null, total_runs: totalRuns, queries: definition.queries };
}
