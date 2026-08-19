# 데이터 계약 초안

상태: `0.8.0-draft / 계정 플랜·모델 선택 방식 반영`

이 문서는 구현 방향을 맞추기 위한 가설 계약이다. ChatGPT 웹 탐사 결과에 따라 필드가 추가·삭제·변경될 수 있다.

## 데이터 흐름

```text
UserInput
→ RawObservation
→ NormalizedObservation
→ Analysis
→ Report
```

## 사용자 입력

사용자가 진단 목적과 중요도를 결정하는 값이다.

```json
{
  "target": {
    "name": "오가나셀피부과 마곡점",
    "urls": ["https://www.oganamagokworld.com"],
    "aliases": ["오가나셀 마곡"]
  },
  "competitors": [],
  "measurement": {
    "enabled": true,
    "importance": 5
  }
}
```

- `target`: 필수
- `competitors`: 선택
- `measurement.importance`: 선택, 기본값 3
- 독립 질문 측정에서는 실행 순서와 일치 검증을 위해 질문 세트를 사전 입력하고, 실제 전송된 질문도 ChatGPT 화면에서 별도로 수집한다.

## 시스템 자동수집 원본

```json
{
  "schema_version": "0.8.0-draft",
  "observation_id": "obs_example",
  "run_id": "run_example",
  "surface": "chatgpt_web",
  "captured_at": "2026-08-14T00:00:00+09:00",
  "measurement": {
    "measurement_type": "independent_query",
    "boundary_strategy": "user_confirmed_new_chat",
    "tab_scope": "single_tab",
    "desired_chat_mode": "temporary",
    "query_set": {
      "query_set_id": "clinic-discovery-ko-v1",
      "version": "1.0.0",
      "total_runs": 3,
      "queries": []
    }
  },
  "environment": {
    "page_url": null,
    "account_plan": "max",
    "model_selection": "default",
    "requested_model": "gpt-5-6-instant",
    "displayed_model": "GPT-5.6 Sol",
    "model_detection_source": "network_request",
    "displayed_model_evidence": {
      "requested_model": "gpt-5-6-instant",
      "displayed_model": "GPT-5.6 Sol",
      "detection_source": "network_request"
    },
    "displayed_mode": null,
    "displayed_mode_evidence": null,
    "locale": "ko-KR"
  },
  "chat_contexts": [],
  "context_events": [],
  "conversation_instances": [
    {
      "conversation_instance_id": "conversation_example",
      "boundary_source": "user_confirmed_new_chat",
      "run_index": 0,
      "manual_completion": null,
      "query": {
        "query_set_id": "clinic-discovery-ko-v1",
        "query_id": "recommend-local-clinic",
        "category": "recommendation",
        "repetition": 1,
        "expected_prompt": "마곡에서 피부과 추천해줘",
        "observed_prompt": "마곡에서 피부과 추천해줘",
        "prompt_match": "exact"
      },
      "context_ids": ["context_example"],
      "chat_modes": ["temporary"]
    }
  ],
  "conversation_events": [],
  "turn_candidates": [
    {
      "turn_id": "turn_example",
      "context_id": "context_example",
      "conversation_instance_id": "conversation_example",
      "model_observation": {
        "requested_model": "gpt-5-6-instant",
        "displayed_model": "GPT-5.6 Sol",
        "detection_source": "network_request",
        "captured_at": "2026-08-14T00:00:05+09:00",
        "history_and_training_disabled": true
      },
      "prompt": {
        "text": "마곡에서 피부과 추천해줘",
        "html": null
      },
      "response": {
        "text": "...",
        "html": null,
        "completion_state": "unknown"
      },
      "link_candidates": [],
      "citation_candidates": []
    }
  ],
  "capture_warnings": [],
  "collector": {
    "name": "chatgpt-web",
    "version": "0.8.0"
  }
}
```

`candidate`라는 이름은 아직 DOM 의미가 확정되지 않았음을 나타낸다. 실측 전에는 링크가 인용인지, 답변 노드가 완결된 turn인지 단정하지 않는다.

각 `chat_context`는 `chat_mode: regular | temporary | unknown`과 URL·화면 라벨 기반 판정 근거를 가진다. 측정 중 컨텍스트가 바뀌면 `context_events`에 기록하고 모든 turn 후보를 당시 `context_id`에 연결한다. 하나의 인용을 구성하는 pill과 링크 후보는 동일한 `group_id`로 묶는다.

응답의 `citation_candidates`는 DOM 증거를 보존하므로 pill과 link가 함께 들어갈 수 있다. 정량 집계에는 정규 URL과 후보 ID를 묶은 `citation_groups`를 사용한다. 완료 후보는 페이지 전체가 아니라 응답별 `last_text_changed_at`, 텍스트 휴지 시간, 중지 버튼 표시 여부로 판정한다.

`account_plan`과 `model_selection`은 측정 시작 전 사용자가 선언한다. 전자는 `free | plus | max | work | unknown`, 후자는 `default | manually_selected`다. `default`는 이번 측정에서 모델을 직접 선택하지 않았다는 뜻이며 모든 플랜에 같은 모델이 제공된다는 뜻이 아니다. 플랜과 선택 방식이 다른 결과는 별도 코호트로 비교한다.

질문별 모델은 측정 탭에서 발생한 ChatGPT 요청 본문의 `model`만 선별해 `model_observation`으로 연결한다. 요청 원문, 질문, 헤더, 토큰은 저장하지 않는다. `requested_model`은 요청 내부 코드이고 `displayed_model`은 사용자 화면 이름 매핑이다. 이는 사용자에게 표면적으로 제공된 요청 모델을 뜻하며 서버 내부의 최종 실행 모델을 증명하지 않는다. 네트워크 관측이 없으면 기존 DOM 모델 증거를 환경 단위 보조값으로 사용한다.

Normalizer는 답변에 포함된 지도 UI의 Mapbox·OpenStreetMap 저작권 및 약관 링크를 실제 출처 집계에서 제외한다. 단, 동일 URL이 명시적 인용 그룹에 포함되어 있으면 인용을 우선해 보존한다. 제외한 링크는 삭제하지 않고 각 turn의 `excluded_link_candidates`에 규칙 ID와 함께 남긴다.

임시 채팅은 안정적인 대화 ID가 노출되지 않으므로 사용자가 같은 탭에서 새 채팅을 연 뒤 사이드패널의 `새 채팅 열었어요`를 눌러 경계를 확정한다. Collector는 각 경계에 `conversation_instance_id`를 만들고 모든 turn을 연결한다. `tab_scope: single_tab`은 측정 중 다른 탭의 데이터를 섞지 않는다는 뜻이다. `independent_query`에서는 대화당 질문 1개를 요구하고, `conversation_journey`에서는 여러 turn을 허용한다.

질문 세트는 `query_set_id`와 고유한 `query_id`를 가지며 `repetitions`를 실행 단위로 펼친다. Collector는 사용자가 현재 실행으로 선택한 질문 메타데이터를 대화 경계에 고정하고, 첫 실제 prompt를 `observed_prompt`로 보존한다. `prompt_match`는 `exact | normalized | mismatch | unavailable`이며, 불일치는 원본과 정규화 경고에 모두 남긴다. Normalizer는 이 메타데이터를 대화와 각 turn에 그대로 전달하며 질문의 의미를 추론하거나 재분류하지 않는다.

## 정규화 데이터 후보

```json
{
  "schema_version": "normalized-0.5.0",
  "normalizer": {
    "name": "chatgpt-web-normalizer",
    "version": "0.5.0"
  },
  "provenance": {
    "raw_schema_version": "0.8.0-draft",
    "observation_id": "obs_example",
    "run_id": "run_example"
  },
  "environment": {
    "account_plan": "max",
    "model_selection": "default",
    "requested_model": "gpt-5-6-instant"
  },
  "conversations": [],
  "turns": [],
  "sources": [],
  "normalization_warnings": []
}
```

## 분석 데이터 후보

```json
{
  "observation_id": "obs_example",
  "analysis_id": "analysis_example",
  "claims": [],
  "entities": [],
  "recommendations": [],
  "citation_matches": [],
  "provenance": {
    "rules_version": "draft",
    "prompt_version": null,
    "model": null,
    "reasoning_effort": null
  }
}
```

## 현재 확정된 불변 조건

- raw에는 추천·점수·의미 매칭 결과를 넣지 않는다.
- raw는 수집 후 덮어쓰지 않는다.
- normalized와 analysis는 원본 `observation_id`를 참조한다.
- 분석 결과에는 규칙·프롬프트·모델 버전을 남긴다.
- UI에서 보이지 않는 ChatGPT 내부 검색어와 추론 과정은 저장하지 않는다.
- `confirmed`는 UI 직접 연결 증거와 출처 지지 여부를 분리해 판정한다.

## 아직 확정하지 않는 항목

- 질문과 답변 노드 선택자
- 응답 완료 감지 규칙
- 인라인 인용의 연결 단위
- Sources 패널 자동 열기 필요 여부
- 대화 URL 보존 여부
- 알려지지 않은 신규 요청 모델 코드의 화면 표시명 매핑
- HTML 전체 보존 범위와 보존 기간
