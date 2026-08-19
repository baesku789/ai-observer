# ai-observer

ChatGPT 등 AI 서비스에서 실제 사용자가 보는 답변을 관측하고, 병원 언급·추천·인용 근거를 추적하는 브라우저 기반 진단 도구입니다.

현재 단계의 목표는 완성된 진단기가 아니라 **ChatGPT 웹 데이터 구조를 확인하는 탐사용 Chrome 익스텐션**을 만드는 것입니다. 실제 DOM과 인용 동작을 실측한 뒤 원본 데이터 스키마 v1을 확정합니다.

## 현재 범위

- 대상 채널: `chatgpt.com`
- 실행 환경: Chrome 익스텐션(Manifest V3)
- 수집 대상: 질문, 답변, 인라인 인용 후보, 출처 링크, 사용자가 선택한 모델/모드, DOM·요청 증거
- 제외 대상: 추천 판정, 주장-출처 의미 매칭, 종합 점수, Google Search 수집

## 설계 원칙

1. 사용자 입력과 시스템 자동수집 값을 분리한다.
2. 원본 수집, 정규화, 분석, 결과 표현을 분리한다.
3. 원본 데이터는 수정하지 않는다.
4. 가공 데이터는 원본 ID와 처리 버전을 참조한다.
5. 화면에서 확인할 수 없는 내부 검색어·추론 과정은 추정해 원본에 기록하지 않는다.
6. 구체적인 원본 스키마는 실제 브라우저 실측 후 확정한다.

## 문서

- [아키텍처](docs/architecture.md)
- [탐사 및 스키마 확정 계획](docs/discovery-plan.md)
- [데이터 계약 초안](docs/data-contract-draft.md)
- [ADR-0001: 브라우저 탐사 우선](docs/decisions/0001-browser-discovery-first.md)

## 탐사용 익스텐션 사용

별도 빌드 과정은 없다.

1. Chrome에서 `chrome://extensions`를 연다.
2. 오른쪽 위 **개발자 모드**를 켠다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누른다.
4. 이 저장소의 `apps/extension` 폴더를 선택한다.
5. `https://chatgpt.com`을 열거나, 이미 열려 있었다면 새로고침한다.
6. 툴바의 **AI Observer** 아이콘을 눌러 사이드패널을 연다.
7. 질문을 각각 입력하고 채팅 모드를 선택한다.
8. **측정 시작**을 누른 뒤 사이드패널이 한 번에 안내하는 행동을 따른다.
9. 질문마다 처음 측정을 시작한 ChatGPT 탭에서 **새 채팅**을 연다. 다른 탭으로 바꾸면 측정 탭으로 돌아가는 안내가 표시된다.
10. 모든 답변 수집이 끝나면 **측정 종료**, **JSON 내려받기**를 차례로 누른다.

측정 시작 전에 화면에 있던 대화는 기준선으로만 사용하며 결과에 포함하지 않는다. 결과 파일은 기본적으로 `ai-observer/` 다운로드 폴더에 저장된다. HTML 조각에 화면상의 대화 내용이 포함되므로 외부 공유나 fixture 편입 전에 반드시 개인정보를 확인하고 익명화한다.

### 질문 세트 실행

여러 독립 질문을 같은 조건으로 반복 측정하려면 사이드패널에서 질문을 각각 추가하고 반복 횟수와 채팅 모드를 선택한다. 별도 시스템에서 만든 질문 세트는 **질문 JSON 가져오기**에서 [예제 JSON](examples/query-set.example.json) 형식으로 불러올 수 있다.

1. **측정 시작**을 누른다.
2. 같은 ChatGPT 탭에서 **새 채팅**을 열고 **새 채팅 열었어요**를 누른다.
3. 안내된 채팅 모드로 전환한 뒤 **질문 복사**로 질문을 전송한다.
4. Collector가 질문과 답변 완료를 감지하면 다음 질문이 즉시 표시되고 복사할 수 있다. 자동 판정이 맞지 않으면 **답변 완료로 표시**를 사용한다.
5. 같은 탭에서 다시 **새 채팅**을 열고 위 과정을 반복한다.
6. 마지막 답변이 끝나면 **측정 종료 → JSON 내려받기**를 누른다.

각 대화에는 질문 세트 ID, 질문 ID, 분류, 반복 번호, 예상 질문과 실제 수집 질문의 일치 여부가 기록된다. 새 채팅의 기본 일반 모드는 질문 전 설정 이력으로 남고, 질문을 보낸 시점의 임시/일반 모드가 실질 질문 모드가 된다.

## 현재 익스텐션 동작

- 사용자가 측정을 시작한 이후의 질문·답변 후보만 관측
- DOM 변경과 스트리밍 중 텍스트 변경 감지
- 질문·답변 텍스트 및 정제된 HTML 조각 저장
- 답변 내부 링크와 인용 UI 후보 속성 수집
- 측정 중인 탭의 ChatGPT 요청에서 모델 코드만 선별하고 질문별 표면적 모델로 연결
- 각 답변 텍스트가 1.5초간 바뀌지 않고 중지 버튼이 없으면 `quiet_candidate`로 표시
- 선택자 실패를 `capture_warnings`에 기록
- 일반 채팅과 임시 채팅을 `chat_contexts`로 분리
- URL·채팅 모드 전환을 `context_events`로 기록하고 각 턴에 `context_id` 연결
- 같은 인용 UI의 pill과 링크를 `citation.group_id`로 묶음
- 정량 집계 가능한 `citation_groups`와 정규 URL 출력
- 네트워크 모델 감지 실패 시 모델·응답 모드의 선택자·라벨·HTML 증거와 UI 후보를 보조값으로 저장
- 사용자가 확정한 새 채팅 경계를 `conversation_instance_id`로 기록
- 측정을 시작한 탭을 소유 탭으로 고정하고 다른 탭에서 진행하지 못하도록 안내
- `awaiting_new_chat → awaiting_chat_mode → ready_to_send → collecting_response → completed` 단계로 UI 상태 관리
- 독립 질문 모드에서 대화당 질문 1개 규칙 검증

`quiet_candidate`는 ChatGPT 내부 완료 상태가 아니라 답변 노드별 텍스트 휴지기와 중지 버튼 부재를 결합한 탐사용 추정값이다. 추천 여부, 출처의 의미적 적합성, 점수는 이 익스텐션에서 판정하지 않는다. 실제 인용 수는 `citation_candidates.length`가 아니라 `citation_groups.length`로 집계한다.

`model_observation`은 사용자가 선택해 요청한 표면적 모델이다. Collector는 요청 전체를 보존하지 않고 `model`, 준비 상태, 임시채팅 여부만 즉시 선별한다. 서버 내부에서 실제로 실행된 모델을 의미하지 않는다.

채팅 유형은 `regular | temporary`로 기록하며 판정 근거를 함께 저장한다. `temporary-chat=true` URL이나 화면의 임시 채팅 라벨이 있으면 `temporary`, 둘 다 없으면 `regular` 후보로 분류한다.

## 로컬 검증

```bash
node --check apps/extension/background.js
node --check apps/extension/content.js
node --check apps/extension/sidepanel.js
node --check apps/extension/query-set.js
python3 -m json.tool apps/extension/manifest.json >/dev/null
npm test
```

## Normalizer

Collector raw JSON을 병원·지점·페이지별로 집계 가능한 구조로 기계적으로 변환한다. 네트워크나 AI를 사용하지 않으며, 미등록 출처는 추측하지 않고 `unknown`과 경고로 남긴다.

```bash
npm run normalize -- /path/to/raw-observation.json \
  --output artifacts/normalized-observation.json
```

Normalizer는 추적 파라미터 제거, 안정적인 source ID 생성, 인용 그룹 중복 제거, 검증된 registry 기반 소유자 분류, URL 경로 기반 페이지 유형 분류와 병원별 인용 집계를 수행한다. 지도 카드의 Mapbox·OpenStreetMap 저작권/약관 링크는 실제 인용보다 우선하지 않는 UI 보조 링크로 분리하고, 제외 근거를 `excluded_link_candidates`에 보존한다.

## 예정 구조

```text
ai-observer/
├── apps/
│   └── extension/          # ChatGPT 웹 원본 수집과 화면
├── packages/
│   ├── schemas/            # raw/normalized/analysis 계약
│   ├── normalizers/        # 채널별 원본을 공통 구조로 변환
│   └── core/               # 주장·인용·엔티티·추천 판정
├── services/
│   └── analyzer-api/       # 출처 조회와 AI 분석 실행
├── fixtures/               # 익명화된 실측 샘플
├── evals/                  # 모델 평가 정답 세트
└── docs/
```
