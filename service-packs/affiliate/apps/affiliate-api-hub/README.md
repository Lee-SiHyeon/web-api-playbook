# Affiliate API Hub

> 이 문서는 원래 허브의 2026-09 작업 기록 스냅샷입니다. 여기의 당시 "현재 상태"를 새 계정/오늘의 라이브 상태로 해석하지 마세요. 이번 통합 pack의 설치·명령은 [pack README](../../README.md)를 먼저 따릅니다.

상품·여행·SaaS 제휴 수익화를 하나의 자동화 파이프라인으로 연결하기 위한 후보군과 공통 계약입니다.

기준일: 2026-09-19

2026-09-21 추가: 마이리얼트립은 일반·왕복 항공 링크 생성, 공항·항공사 검색, 예약 건수·수익 집계 등 **10개 API의 독립 HTTP 실호출을 검증**했습니다. [실행 방법과 지원 범위](docs/myrealtrip-api-only-2026-09-21.md)를 참고하세요. 초기 세션 취득에는 브라우저가 필요하며 자동 갱신과 정산정보 제출은 포함하지 않습니다.

## 결론

가장 먼저 붙일 축은 다음 세 가지입니다.

1. **국내 직접 제휴:** 쿠팡 파트너스. 기존 Chrome 로그인 세션을 값 추출 없이 재사용해 포털 계약을 실제 관측했습니다.
2. **글로벌 네트워크:** impact.com, CJ Affiliate, Rakuten Advertising, Awin, Partnerize.
3. **자동 링크 수익화:** Sovrn Commerce, Skimlinks. 기존 일반 쇼핑 링크를 제휴 링크로 바꾸는 데 유리합니다.

그 다음 Amazon Creators API, eBay Partner Network, PartnerStack, Booking.com Demand API,
Expedia Group을 수직 확장으로 붙입니다.

## 공통 커넥터 계약

각 프로그램은 아래 capability를 선언하고, 지원하지 않는 기능은 명시적으로 `unsupported`로 둡니다.

- `programs.list`: 가입·승인된 광고주/캠페인
- `catalog.search`: 상품·오퍼 검색
- `catalog.get`: 상품 상세
- `links.create`: 추적 링크·딥링크 생성
- `promotions.list`: 쿠폰·프로모션
- `transactions.list`: 주문·전환·커미션
- `reports.summary`: 집계 리포트
- `events.subscribe`: 웹훅·포스트백
- `commission.rules`: 카테고리·광고주별 보상 규칙
- `payouts.list`: 지급·정산 상태

수수료를 고정 `3%`로 모델링하지 않습니다. 공통 스키마는 `percent_of_sale`, `fixed_cpa`,
`recurring_revenue_share`, `tiered`, `hybrid`, `unknown`을 지원해야 합니다.

## 안전·운영 원칙

- 공식 API와 승인된 파트너 계정을 우선합니다.
- 로그인 포털 안쪽 문서는 사용자가 승인한 계정 세션에서 읽기 전용으로 관측합니다.
- 비공개 API의 인증 우회, CAPTCHA 우회, 타인 계정 접근은 구현하지 않습니다.
- API 키는 OS 자격증명 저장소 또는 서버 secret manager에 저장하고 Git·채팅·로그에 남기지 않습니다.
- 상품 가격·재고·수수료율은 변동 데이터이므로 캐시 만료와 마지막 확인 시각을 기록합니다.
- 게시 자동화는 광고·제휴 고지 문구와 채널별 정책 검사를 통과한 콘텐츠만 실행합니다.

## 쿠팡 파트너스 현재 상태

Google Chrome Stable의 `Default` 프로필에 로그인된 세션을 브라우저 안에서 그대로 사용했습니다.
쿠키 또는 세션 토큰 값을 복사하거나 파일에 저장하지 않았습니다.

- 포털 계약 후보: **146개**
- 실제 인증 요청 관측: **26개**
- 실제 HTTP 200 응답 확인: **26개**
- 요청 형태 힌트: **22개**
- 필드명이 확인된 POST 형태: **11개**
- 실행 가능 계약: **0개**

상품 검색 `POST /api/v1/search`, 링크 카테고리 `GET /api/v1/url/instant/all`, 일별 리포트
`POST /api/v1/report/daily`, 수익 요약 `GET /api/v1/earning/summary/v2`, 지급·정산 리포트 등은
로그인된 포털에서 실제 요청과 HTTP 200 응답까지 확인했습니다.

세부 결과는 [쿠팡 세션 재사용 기록](docs/coupang-session-reuse-2026-09-19.md)에 있습니다.

## 파일

- `references/candidates.json`: 후보별 검증 상태, 기능, 우선순위
- `references/coupang-portal-contracts.json`: 쿠팡 포털 라이브 관측 + 공개 번들 후보 카탈로그
- `references/coupang-request-shape-hints.json`: 요청 메서드·필드명 힌트
- `docs/landscape-2026-09-19.md`: 조사 결과와 구현 순서
- `docs/coupang-session-reuse-2026-09-19.md`: 기존 Chrome 세션 재사용과 실제 관측 결과
