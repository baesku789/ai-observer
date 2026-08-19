#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { normalizeObservation } from "../packages/normalizers/src/index.js";

const inputs = process.argv.slice(2);
const MAP_ATTRIBUTION_HOSTS = new Set(["mapbox.com", "www.mapbox.com", "openstreetmap.org", "www.openstreetmap.org"]);
const SENSITIVE_NETWORK_KEYS = new Set(["authorization", "cookie", "request_body", "request_headers", "messages", "token"]);

function visitKeys(value, path = [], matches = []) {
  if (!value || typeof value !== "object") return matches;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (SENSITIVE_NETWORK_KEYS.has(key.toLocaleLowerCase())) matches.push(nextPath.join("."));
    visitKeys(child, nextPath, matches);
  }
  return matches;
}

export function validateRaw(raw) {
  const errors = [];
  const warnings = [];
  const contexts = new Map((raw.chat_contexts || []).map((context) => [context.context_id, context]));
  const conversations = new Map((raw.conversation_instances || []).map((conversation) => [conversation.conversation_instance_id, conversation]));
  const turns = raw.turn_candidates || [];

  if (!/^0\.8\./.test(raw.schema_version || "")) errors.push(`raw schema가 0.8.x가 아닙니다: ${raw.schema_version || "missing"}`);
  if (raw.collector?.version !== "0.8.0") errors.push(`Collector 버전이 0.8.0이 아닙니다: ${raw.collector?.version || "missing"}`);
  if (raw.measurement?.tab_scope !== "single_tab") errors.push("tab_scope가 single_tab이 아닙니다.");
  if (!["free", "plus", "max", "work", "unknown"].includes(raw.environment?.account_plan)) errors.push(`account_plan이 올바르지 않습니다: ${raw.environment?.account_plan || "missing"}`);
  if (raw.environment?.account_plan === "unknown") warnings.push("계정 플랜이 unknown이므로 플랜별 비교에서 제외될 수 있습니다.");
  if (!["default", "manually_selected"].includes(raw.environment?.model_selection)) errors.push(`model_selection이 올바르지 않습니다: ${raw.environment?.model_selection || "missing"}`);
  if ((raw.capture_warnings || []).length) errors.push(`Collector 경고가 ${(raw.capture_warnings || []).length}건 있습니다: ${(raw.capture_warnings || []).map((item) => item.code).join(", ")}`);

  const sensitivePaths = visitKeys(raw);
  if (sensitivePaths.length) errors.push(`저장하면 안 되는 네트워크 필드가 있습니다: ${sensitivePaths.join(", ")}`);

  if (raw.measurement?.measurement_type === "independent_query") {
    const expectedRuns = raw.measurement?.query_set?.total_runs;
    if (Number.isInteger(expectedRuns) && conversations.size !== expectedRuns) errors.push(`대화 수 ${conversations.size}개가 예정 실행 수 ${expectedRuns}개와 다릅니다.`);
  }

  for (const [index, turn] of turns.entries()) {
    const label = `turn ${turn.turn_index || index + 1}`;
    const conversation = conversations.get(turn.conversation_instance_id);
    const context = contexts.get(turn.context_id);
    if (!turn.prompt?.text) errors.push(`${label}: 질문이 없습니다.`);
    if (!turn.model_observation?.requested_model) errors.push(`${label}: requested_model이 없습니다.`);
    if (!turn.model_observation?.displayed_model) errors.push(`${label}: displayed_model이 없습니다.`);
    if (turn.model_observation?.detection_source !== "network_request") errors.push(`${label}: 모델 감지 출처가 network_request가 아닙니다.`);
    if (context?.chat_mode !== raw.measurement?.desired_chat_mode) errors.push(`${label}: 실제 채팅 모드 ${context?.chat_mode || "missing"}가 목표 모드 ${raw.measurement?.desired_chat_mode || "missing"}와 다릅니다.`);
    if (context?.chat_mode === "temporary" && turn.model_observation?.history_and_training_disabled !== true) errors.push(`${label}: 임시채팅 네트워크 신호가 true가 아닙니다.`);
    if (context?.chat_mode === "regular" && turn.model_observation?.history_and_training_disabled === true) errors.push(`${label}: 일반채팅인데 임시채팅 네트워크 신호가 true입니다.`);
    if (context?.chat_mode === "regular" && turn.model_observation?.history_and_training_disabled === null) warnings.push(`${label}: 일반채팅 네트워크 신호를 확인하지 못했습니다.`);
    if (conversation?.query && conversation.query.prompt_match !== "exact") errors.push(`${label}: 질문 일치 상태가 ${conversation.query.prompt_match || "missing"}입니다.`);
    if (!(turn.response_candidates || []).length) errors.push(`${label}: 답변이 없습니다.`);
    const responseComplete = Boolean(conversation?.manual_completion) || (turn.response_candidates || []).some((response) => response.completion_state === "quiet_candidate");
    if (!responseComplete) errors.push(`${label}: 완료된 답변 후보가 없습니다.`);

    for (const response of turn.response_candidates || []) {
      const groups = response.citation_groups || [];
      const groupIds = groups.map((group) => group.group_id);
      if (new Set(groupIds).size !== groupIds.length) errors.push(`${label}: citation_group ID가 중복됩니다.`);
      if (groups.length > (response.citation_candidates || []).length) errors.push(`${label}: 논리 인용 수가 인용 후보 수보다 많습니다.`);
    }
  }

  if (!turns.length) errors.push("수집된 turn이 없습니다.");
  const normalized = normalizeObservation(raw);
  const leakedMapSources = normalized.sources.filter((source) => {
    try { return MAP_ATTRIBUTION_HOSTS.has(new URL(source.canonical_url).hostname) && source.observations.citation_count === 0; }
    catch (_) { return false; }
  });
  if (leakedMapSources.length) errors.push(`지도 UI 링크가 출처에 남았습니다: ${leakedMapSources.map((source) => source.canonical_url).join(", ")}`);
  if (normalized.normalization_warnings.length) warnings.push(`Normalizer 정보/경고 ${normalized.normalization_warnings.length}건: ${[...new Set(normalized.normalization_warnings.map((item) => item.code))].join(", ")}`);

  return {
    errors,
    warnings,
    summary: {
      measurement_type: raw.measurement?.measurement_type || null,
      desired_chat_mode: raw.measurement?.desired_chat_mode || null,
      account_plan: raw.environment?.account_plan || null,
      model_selection: raw.environment?.model_selection || null,
      turns: turns.length,
      conversations: conversations.size,
      displayed_models: [...new Set(turns.map((turn) => turn.model_observation?.displayed_model).filter(Boolean))],
      sources: normalized.sources.length,
      excluded_auxiliary_links: normalized.turns.reduce((sum, turn) => sum + (turn.search_observation.excluded_auxiliary_link_count || 0), 0)
    }
  };
}

if (!inputs.length) {
  console.error("사용법: npm run validate:collector -- /path/to/raw-observation.json [...]");
  process.exitCode = 1;
} else {
  let failed = false;
  for (const input of inputs) {
    try {
      const path = resolve(input);
      const raw = JSON.parse(await readFile(path, "utf8"));
      const result = validateRaw(raw);
      failed ||= result.errors.length > 0;
      console.log(`${result.errors.length ? "✗" : "✓"} ${basename(path)}`);
      console.log(`  ${result.summary.measurement_type} · ${result.summary.desired_chat_mode} · 플랜 ${result.summary.account_plan || "없음"} · 선택 ${result.summary.model_selection || "없음"} · turn ${result.summary.turns} · 대화 ${result.summary.conversations} · 모델 ${result.summary.displayed_models.join(", ") || "없음"} · 출처 ${result.summary.sources} · 보조 링크 제외 ${result.summary.excluded_auxiliary_links}`);
      for (const error of result.errors) console.log(`  오류: ${error}`);
      for (const warning of result.warnings) console.log(`  참고: ${warning}`);
    } catch (error) {
      failed = true;
      console.log(`✗ ${input}`);
      console.log(`  오류: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}
