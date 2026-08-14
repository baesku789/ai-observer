# ai-observer

ChatGPT 등 AI 서비스에서 실제 사용자가 보는 답변을 관측하고, 병원 언급·추천·인용 근거를 추적하는 브라우저 기반 진단 도구입니다.

현재 단계의 목표는 완성된 진단기가 아니라 **ChatGPT 웹 데이터 구조를 확인하는 탐사용 Chrome 익스텐션**을 만드는 것입니다. 실제 DOM과 인용 동작을 실측한 뒤 원본 데이터 스키마 v1을 확정합니다.

## 현재 범위

- 대상 채널: `chatgpt.com`
- 실행 환경: Chrome 익스텐션(Manifest V3)
- 수집 대상: 질문, 답변, 인라인 인용 후보, 출처 링크, 화면에 표시된 모델/모드, DOM 증거
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
7. **측정 시작**을 누른 다음 새 질문을 입력한다.
8. 답변이 끝나면 **측정 중지**, **JSON 내려받기**를 차례로 누른다.

측정 시작 전에 화면에 있던 대화는 기준선으로만 사용하며 결과에 포함하지 않는다. 결과 파일은 기본적으로 `ai-observer/` 다운로드 폴더에 저장된다. HTML 조각에 화면상의 대화 내용이 포함되므로 외부 공유나 fixture 편입 전에 반드시 개인정보를 확인하고 익명화한다.

## 현재 익스텐션 동작

- 사용자가 측정을 시작한 이후의 질문·답변 후보만 관측
- DOM 변경과 스트리밍 중 텍스트 변경 감지
- 질문·답변 텍스트 및 정제된 HTML 조각 저장
- 답변 내부 링크와 인용 UI 후보 속성 수집
- 화면에 표시된 모델/모드 후보 수집
- 1.5초간 DOM 변경이 없는 답변을 `quiet_candidate`로 표시
- 선택자 실패를 `capture_warnings`에 기록

`quiet_candidate`는 ChatGPT 내부 완료 상태가 아니라 탐사용 휴지기 추정값이다. 추천 여부, 출처의 의미적 적합성, 점수는 이 익스텐션에서 판정하지 않는다.

## 로컬 검증

```bash
node --check apps/extension/background.js
node --check apps/extension/content.js
node --check apps/extension/sidepanel.js
python3 -m json.tool apps/extension/manifest.json >/dev/null
```

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
