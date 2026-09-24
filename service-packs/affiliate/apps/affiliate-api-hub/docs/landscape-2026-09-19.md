# 제휴·어필리에이트 API 후보군 — 2026-09-19

## 1. 바로 구현할 P0

### 쿠팡 파트너스

- 국내 상품형 콘텐츠의 첫 번째 대상입니다.
- Windows Chrome Stable `Default` 프로필의 승인된 로그인 세션을 값 추출 없이 재사용했습니다.
- 인증 포털에서 26개 요청과 HTTP 200 응답을 연결 검증했고, 공개 번들까지 합쳐 146개 계약 후보를 정리했습니다.
- 실제 관측 범위에는 상품 검색, 추천 상품, 링크 카테고리, 배너·위젯, 일별·성과·지급·정산 리포트가 포함됩니다.
- 현재 후보는 모두 `executable: false`이며 포털 내부 계약과 공식 Open API를 구분해 구현합니다.
- 상세 증거는 `docs/coupang-session-reuse-2026-09-19.md`와 `references/coupang-portal-contracts.json`에 있습니다.

### impact.com

- REST Partner API와 계정별 Basic 인증을 제공합니다.
- 캠페인, 카탈로그, 링크, 프로모션, 액션·리포트 계열을 한 네트워크에서 처리할 수 있는 핵심 후보입니다.
- 신규 토큰은 read-only 최소 scope로 시작합니다.

### CJ Affiliate

- Product Feed/Product Search와 Commission Detail API가 핵심입니다.
- 상품 후보 생성과 실제 커미션 검증을 같은 네트워크에서 연결하기 좋습니다.
- GraphQL과 REST 인증·토큰 흐름을 별도 adapter로 분리합니다.

### Rakuten Advertising

- Product Search, Link Locator, Events, Advanced Reports가 분리돼 있습니다.
- 상품 검색 → 추적 링크 → 거래 확인 → 리포트 흐름을 공통 E2E 테스트의 기준 구현으로 삼기 좋습니다.

### Awin

- 공식 API는 거래와 집계 리포트를 읽고 프로모션 같은 객체를 생성할 수 있습니다.
- 광고주별 상품 피드와 링크 기능은 계정에서 사용할 수 있는 범위를 확인해 capability를 확정합니다.
- ShareASale 계열 프로그램도 Awin 운영 범위와 중복 여부를 확인합니다.

### Partnerize

- API-first REST 구조이며 추적 링크 생성, 커미션·전환·리포트 API가 공개돼 있습니다.
- 상품 카탈로그보다 링크·전환·정산 자동화 쪽 우선순위가 높습니다.

### Sovrn Commerce

- Merchant, Link, Reporting API 외에 상품 추천, 가격 비교, 프로모션 코드 기능을 제공합니다.
- 개별 쇼핑몰 API를 다 붙이기 전 빠르게 링크 수익화를 넓히는 데 적합합니다.

### Skimlinks

- Merchant API, Link Wrapper, Reporting API, Product Key, Data Pipe가 공개돼 있습니다.
- 기존 글의 외부 상품 링크를 후처리해 제휴 링크로 바꾸는 connector로 우선 구현합니다.

## 2. P1 확장

### Amazon Creators API

- 기존 PA-API 5가 아니라 Creators API를 사용해야 합니다.
- 상품 카탈로그 접근에 강하고, 지역별 Associates 계정과 정책을 분리해야 합니다.
- 실적·지급 데이터가 동일 API에서 제공되는지는 계정 문서 기준으로 별도 capability를 둡니다.

### eBay Partner Network

- 고용량 제휴 통합용 feed/API와 성과 리포트 API가 있습니다.
- eBay 상품 검색 API와 EPN 캠페인·custom ID를 결합하는 adapter가 필요합니다.

### PartnerStack

- 물리 상품 카탈로그보다 SaaS 추천·리드·딜·보상에 적합합니다.
- Partner API, 링크 추적, postback을 이용해 반복 구독 수익을 별도 vertical로 운영합니다.

### Booking.com Demand API / Expedia Group

- 숙박·여행 재고 검색과 예약/리디렉션을 위한 강력한 API지만 계약·심사·운영 요건이 일반 제휴 링크보다 높습니다.
- 여행 글 전용 파이프라인에서 가격·재고의 짧은 TTL과 지역·통화 처리를 별도로 둡니다.

### 국내 포털 검증 후보

- 네이버 쇼핑 커넥트
- 링크프라이스
- 애드픽

이 세 곳은 가입·승인 계정에서 공개된 링크 생성, 상품 DB, 실적 다운로드/API 여부를 직접 확인한 뒤
`confirmed`로 승격합니다. 브라우저 자동화만 가능한 경우에도 숨은 쓰기 API를 실행하지 않고 먼저
읽기·문서·XHR 계약만 수집합니다.

## 3. P2 탐색 백로그

- Admitad
- AliExpress Portals
- Travelpayouts
- TradeDoubler
- Klook Affiliate
- Agoda Affiliate
- Trip.com Affiliate

프로그램 자체는 후보지만 공개 공식 문서, 한국 거주자 가입 가능 여부, 정산 국가·통화, API 권한을
승인 계정에서 확인하기 전에는 구현 대상으로 확정하지 않습니다.

## 4. 수익 API가 아닌 보조 데이터 소스

- 네이버 쇼핑 검색 API
- 11번가 Open API
- 카카오 쇼핑 Open API

상품 탐색·판매자 운영 데이터에는 유용할 수 있지만, API 호출 자체가 제휴 커미션을 발생시키는 것은
아닙니다. 반드시 별도의 승인된 제휴 추적 링크와 결합해야 합니다.

## 5. 제외·주의

- Udemy Affiliate API는 2025-01-01부터 중단됐으므로 신규 connector 대상에서 제외합니다.
- 상품몰 화면을 크롤링해 가격·재고를 장기 저장하는 방식은 정책·신선도 문제가 있으므로 공식 feed/API가 없는
  경우 마지막 수단으로만 검토합니다.
- 카테고리별 커미션은 수시로 달라질 수 있으므로 소스 코드 상수로 박지 않고 `commission_rules` 테이블과
  `effective_from/effective_to`로 관리합니다.

## 6. 구현 파동

### Wave 0 — 공통 런타임

- OAuth2, Basic, API key, signed request 인증 adapter
- 공통 product/offer/link/conversion/payout schema
- rate limit, retry, idempotency, cursor pagination
- secret redaction, audit receipt, capability manifest

### Wave 1 — 가장 넓은 커버리지

1. impact.com
2. CJ Affiliate
3. Rakuten Advertising
4. Awin
5. Partnerize
6. Sovrn Commerce
7. Skimlinks

### Wave 2 — 직접 프로그램

1. 쿠팡 파트너스
2. Amazon Creators API
3. eBay Partner Network
4. PartnerStack

### Wave 3 — 수직 확장

1. Booking.com
2. Expedia Group
3. 국내 포털 검증 후보
4. AliExpress·Admitad·Travelpayouts 계열

## 7. 추천 E2E 워크플로

`주제/키워드 → 여러 catalog 검색 → 가격·평점·커미션 후보 정규화 → 광고주 정책 필터 → 추적 링크 생성
→ 고지 문구 포함 콘텐츠 초안 → 사용자 승인 → 게시 → 클릭/전환/커미션 수집 → EPC·CVR 기준 재랭킹`

상품 선택 점수는 단순 커미션율보다 다음을 함께 사용합니다.

`score = 예상 전환율 × 예상 커미션액 × 재고 신뢰도 × 콘텐츠 적합도 × 정책 안전도`
