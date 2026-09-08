# Codex 측정 에이전트 인수인계

> 다음 세션 시작 명령: `docs/codex-measurement-agents.md를 읽고 준비된 질문 세트를 실행해.`

## 목적

This project is configured so that Codex can run a set of ChatGPT questions as
separate AI Observer measurements. Each question and repetition gets a fresh
subagent thread. Browser work is serialized because every measurement shares
one designated Chrome window and one installed AI Observer extension.

No measurement was started while creating this configuration.

## 생성된 설정

- `.codex/config.toml`: enables subagents, selects Luna low as the default, and
  allows only one subagent thread at a time.
- `.codex/agents/measurement-runner.toml`: performs one normal measurement with
  `gpt-5.6-luna` at low reasoning effort.
- `.codex/agents/measurement-recovery.toml`: retries one failed measurement once
  with `gpt-5.6-terra` at low reasoning effort.

The one-thread limit is intentional. Do not increase it while agents share a
browser; concurrent mouse and keyboard actions can corrupt both runs.

## 다음 세션 전 준비

1. Reload the VS Code window, then start a new Codex chat so project-scoped
   custom agents are loaded.
2. Open the dedicated Chrome window used for measurement.
3. Confirm that the unpacked AI Observer extension is enabled.
4. Open ChatGPT and leave unrelated Chrome windows and tabs out of the workflow.
5. Prepare the exact question list and repetition count. Give every question a
   stable `query_id`.

Suggested input:

```json
{
  "repetitions": 3,
  "questions": [
    { "query_id": "q001", "text": "Exact question text" },
    { "query_id": "q002", "text": "Another exact question" }
  ]
}
```

## 다음 Codex 세션용 프롬프트

Paste the prompt below together with the question set.

```text
Read docs/codex-measurement-agents.md and follow it as the runbook.

Build a queue containing every question × repetition. Process the queue in
order. For each queue item, spawn a fresh measurement_runner subagent and wait
for it to finish before starting another. Never operate more than one browser
agent at a time. Each subagent must execute exactly one measurement and must use
the question text verbatim.

After each subagent returns, record its JSON result and close its completed
thread before spawning the next one. If and only if an item fails, spawn one
fresh measurement_recovery subagent for that same item, using the exact original
question and the first failure reason. Do not retry more than once.

Continue until every queue item has a terminal result. Then show a table with
query_id, repetition, model/agent, run_id, status, search-query count,
search-result count, citation count, and failure reason. Also report total
successful, recovered, and failed runs. Do not modify project files unless I
explicitly ask.
```

## 실행 계약

For each item, the parent agent supplies:

- `query_id`
- repetition number
- exact question text
- first-attempt failure reason, for recovery only

Each worker returns one compact JSON object containing:

- `query_id`
- `repetition`
- `run_id`
- `status`
- `search_query_count`
- `search_result_count`
- `citation_count`
- `failure_reason`

The parent agent owns the queue and aggregate table. A worker owns only one
measurement. It must not rewrite a question, combine questions, or silently run
again. When a usage-limit or sign-in prompt blocks an anonymous session, the
worker refreshes once and then reports failure if the block remains.

## 비용 계산

The model prices supplied for this experiment use the short-context rates below
per one million tokens:

| Model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.6-luna | $0.20 | $0.02 | $0.25 | $1.20 |
| gpt-5.6-terra | $2.00 | $0.20 | $2.50 | $12.00 |

Per-run model cost is:

```text
(input_tokens × input_rate
 + cached_input_tokens × cached_input_rate
 + cache_write_tokens × cache_write_rate
 + output_tokens × output_rate) / 1,000,000
```

Any separate Computer Use or product charge is not included in this formula.
Record actual token usage before treating an estimate as a measured cost.

## 문제 해결

- If Codex does not recognize `measurement_runner`, reload the VS Code window
  and open a new chat from the repository root.
- If a second worker cannot start, make sure the previous subagent thread is
  finished and closed; the project intentionally permits only one.
- If browser control is unavailable, verify that the Computer Use capability is
  enabled in the parent session. Do not fall back to controlling a personal
  Chrome profile.
- If the extension captures no run, keep that item failed and use the single
  Terra recovery path. Do not repair or fabricate collected data.

## 참고 문서

The layout follows the official OpenAI documentation for project-scoped custom
agents: `.codex/agents/*.toml`, required `name`, `description`, and
`developer_instructions` fields, per-agent model settings, and the `[agents]`
section in `.codex/config.toml`.

- <https://learn.chatgpt.com/docs/agent-configuration/subagents.md>
