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

export function querySetMetadata(definition, totalRuns) {
  return { query_set_id: definition.query_set_id, version: definition.version || null, total_runs: totalRuns, queries: definition.queries };
}
