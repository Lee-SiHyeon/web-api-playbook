# 쿠팡 파트너스 기존 Chrome 세션 재사용 — 2026-09-19

## 결론

Windows의 Google Chrome Stable `Default` 프로필에 남아 있던 쿠팡 파트너스 로그인 세션을
브라우저 안에서 그대로 재사용했다. 쿠키 값이나 세션 토큰 값을 추출·복사·출력·저장하지 않았다.

로그인 상태는 쿠팡 파트너스 화면에서 `링크 생성`, `리포트`, `실적`, `내 정보` 메뉴가 보이고
`로그인`, `회원가입`은 보이지 않는 조건으로 확인했다. Chrome 창을 정리해 같은 프로필로 다시 연 뒤에도
로그인 상태가 유지됐다.

## 실제 관측 결과

- 정제된 포털 계약 후보: **146개**
- 인증된 브라우저 NetLog에서 실제 요청 관측: **26개**
- 요청과 응답을 같은 NetLog source로 연결해 HTTP 200 확인: **26개**
- 공개 JS 번들에서 추출한 요청 형태 힌트: **22개**
- 필드명이 구체적으로 확인된 POST 형태: **11개**
- 실행 가능으로 자동 승격한 계약: **0개**
- 쿠키·세션 토큰 값 복사: **0건**
- 주문·구매·회원정보 수정·정산정보 수정: **0건**

실제 200 응답까지 확인한 주요 계약은 다음과 같다.

| 기능 | 메서드 | 경로 |
|---|---|---|
| 상품 검색 | POST | `/api/v1/search` |
| 추천 상품 | GET | `/api/v1/discovery/fashion` |
| 골드박스 상품 | GET | `/api/v1/discovery/goldbox` |
| 로켓프레시 상품 | GET | `/api/v1/discovery/rocket-fresh` |
| 모든 즉시 링크 카테고리 | GET | `/api/v1/url/instant/all` |
| 일별 리포트 | POST | `/api/v1/report/daily` |
| 수익 요약 | GET | `/api/v1/earning/summary/v2` |
| 성과 요약 | POST | `/api/v1/performance/summary` |
| 상품별 성과 | POST | `/api/v1/performance/product` |
| 지급 리포트 | POST | `/api/v1/report/payouts` |
| 정산 리포트 | POST | `/api/v1/report/settlements` |
| 이벤트 | POST | `/api/v1/events` |
| 위젯 검색 | POST | `/api/v1/widgets/instances/search` |
| 위젯 목록 | GET | `/api/v1/widgets` |
| 배너 목록 | GET | `/api/v1/widgets/banners` |

## 공개 번들에서 확인한 링크 생성 계약

공개 JS의 직접 호출부에서 다음을 확인했다.

- `GET /api/v1/url/any?coupangUrl=...`
- `GET /api/v1/url/instant/{categoryId}`
- `POST /api/v1/banner/iframe/url` — `group`, `product`
- `POST /api/v1/banner/gen` — `group`, `product`, `options`
- `POST /api/v1/widgets/banners` — `datasetId`, `width`, `height`

값은 보관하지 않았고 필드 이름만 `references/coupang-request-shape-hints.json`에 기록했다.

## 상품 검색·리포트 형태 힌트

- 상품 검색: `categoryId`, `filter`, `deliveryTypes`, `page.pageNumber`, `page.size`
- 이벤트 목록: `page.pageNumber`, `page.size`
- 일별·월별·성과 리포트: `filters[].column`, `filters[].operator`, `filters[].value`
- 관측된 필터 column 후보: `startDate`, `endDate`, `subIds`, `childTrackingCodes`
- 구형 정산 목록: `pageNumber`, `size`

지급·정산 상세의 POST 본문은 객체 전달까지 확인했지만 내부 필드명은 아직 `opaqueBodyObject`로 남겼다.

## 증거와 구현 경계

- `evidence/coupang-netlog-sanitized.json`: URL 값·헤더 값·본문을 제거한 실제 요청/응답 메타데이터
- `evidence/coupang-public-script-analysis.json`: 인증정보 없이 공개 번들 6개를 분석한 결과
- `references/coupang-request-shape-hints.json`: 직접 호출부의 메서드와 필드명 힌트
- `references/coupang-portal-contracts.json`: 라이브 관측과 정적 후보를 합친 최종 카탈로그

포털 내부 계약은 쿠팡의 비공개 구현이므로 변경될 수 있다. 현재 카탈로그는 전부
`executable: false`이며, 공식 Open API 계정·키·호출 규칙을 확인하거나 별도 안전한 재현 테스트를
통과하기 전에는 자동 호출기로 승격하지 않는다.
