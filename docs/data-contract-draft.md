# 데이터 계약 초안

상태: `draft / 실측 전`

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
- 질문 텍스트는 ChatGPT 화면에서 자동수집하므로 별도 사전 입력을 요구하지 않는다.

## 시스템 자동수집 원본

```json
{
  "schema_status": "draft",
  "observation_id": "obs_example",
  "run_id": "run_example",
  "surface": "chatgpt_web",
  "captured_at": "2026-08-14T00:00:00+09:00",
  "page": {
    "url": null,
    "displayed_mode": null
  },
  "turn_candidates": [
    {
      "turn_id": "turn_example",
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
    "version": "0.0.1"
  }
}
```

`candidate`라는 이름은 아직 DOM 의미가 확정되지 않았음을 나타낸다. 실측 전에는 링크가 인용인지, 답변 노드가 완결된 turn인지 단정하지 않는다.

## 정규화 데이터 후보

```json
{
  "observation_id": "obs_example",
  "normalizer_version": "0.0.1",
  "conversation_turns": [
    {
      "turn_id": "turn_example",
      "prompt_text": "마곡에서 피부과 추천해줘",
      "answer_segments": [],
      "sources": []
    }
  ],
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
- 표시 모델·모드의 안정적 추출 여부
- HTML 전체 보존 범위와 보존 기간

