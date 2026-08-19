# 아키텍처

## 목적

AI 답변에서 특정 병원이 어떤 질문에 언급·추천되고 어떤 페이지가 근거로 제시되는지 관측한다. 첫 수집 채널은 ChatGPT 웹이며, 이후 Google Search나 다른 AI 서비스가 추가되어도 핵심 분석 로직을 재사용할 수 있어야 한다.

## 계층

```text
ChatGPT 웹
  ↓
Collector
  ↓ raw observation
Normalizer
  ↓ normalized observation
Core Analyzer
  ↓ analysis
Presenter
```

### Collector

- ChatGPT DOM과 Chrome API를 안다.
- 측정 중인 소유 탭의 요청 본문에서 모델·채팅 모드 신호만 즉시 선별하고 원문은 폐기한다.
- 화면에서 직접 확인되는 사실만 수집한다.
- 추천 여부나 출처 적합성을 판정하지 않는다.
- DOM 스냅샷과 선택자 실패 경고를 증거로 남긴다.

### Normalizer

- ChatGPT 고유 DOM을 공통 대화·답변·인용 구조로 변환한다.
- 채널별 원본 구조 변경을 core로 전파하지 않는다.
- 변환 버전과 누락 필드를 기록한다.

### Core Analyzer

- 정규화 데이터와 수집된 출처 문서를 입력받는다.
- 주장 분해, 엔티티 식별, 추천 여부, 주장-출처 관계를 분석한다.
- 직접 증거와 AI 의미 판정을 구분한다.
- 최종 판정 등급은 고정된 코드 규칙으로 결정한다.

### Presenter

- 분석 결과를 사이드패널, JSON, 리포트로 표현한다.
- 새로운 판정이나 점수를 만들지 않는다.

## 의존성 규칙

```text
apps/extension → packages/schemas
apps/extension → packages/normalizers
services/analyzer-api → packages/core
packages/core → packages/schemas
packages/core → LLM 인터페이스
```

- `core`는 Chrome API, ChatGPT DOM, UI 프레임워크를 import하지 않는다.
- 특정 모델명은 core가 아니라 LLM 어댑터 설정에 둔다.
- Collector의 DOM 선택자는 normalizer 및 core에 노출하지 않는다.
- Presenter는 raw DOM을 직접 해석하지 않는다.

## 저장 계층

```text
runs/{run_id}/
├── user-input.json
├── raw/
├── normalized/
├── analysis/
└── reports/
```

- `raw`: append-only
- `normalized`: normalizer 버전별 재생성 가능
- `analysis`: 모델·프롬프트·판정 규칙 버전별 저장
- `reports`: analysis에서 재생성 가능

## 보안·개인정보 경계

- 측정 시작 이후의 대화만 수집한다.
- 쿠키, 세션 토큰, 이메일, 계정 식별자는 저장하지 않는다.
- 네트워크 요청 본문·헤더는 저장하지 않으며 허용 목록의 모델·모드 신호만 raw observation에 남긴다.
- API 키를 익스텐션 번들에 포함하지 않는다.
- 대화 URL은 공유 위험이 있으므로 기본 저장 여부를 실측 단계에서 검토한다.
- fixture로 편입할 때 개인·민감 정보를 익명화한다.
