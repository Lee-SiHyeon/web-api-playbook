# 쿠팡 소비자 상품·특가 피드 독립 HTTP 커넥터

Node.js 24 이상 (ESM 네이티브, 외부 의존성 0개).
브라우저 자동화, Playwright, MCP, 사용자 쿠키, SDK 서명 위조 없이, 실제 관측된 쿠팡 소비자 XHR JSON 계약을 독립 HTTP로 실행합니다.

---

## 1. 빠른 시작 (npm 스크립트 및 CLI)

```bash
# 1. 추천 피드 상품 및 가격 수집 (기본 20개, 최대 3페이지 순회)
npm run --silent coupang:feed -- --limit 20

# 2. 피드 내 로컬 키워드 검색 및 가격 범위 필터링
npm run --silent coupang:feed -- --query 도마 --min-price 10000 --max-price 25000

# 3. 가격 오름차순 정렬 (전체 대상 수집 후 정렬 적용)
npm run --silent coupang:feed -- --sort price_asc --limit 10

# 4. 특가 상품 추출 (기본 20% 이상 할인, 할인율 높은 순 정렬)
npm run --silent coupang:deals -- --min-discount 30 --limit 10

# 5. 관측된 피드 섹션 및 상품 수 요약
npm run --silent coupang:sections

# 공개 카테고리 이름·ID 조회 (카테고리별 상품 목록은 포함하지 않음)
npm run --silent coupang:categories

# 6. 관측된 피드 내 특정 상품/옵션/판매자 식별자 검색
npm run --silent coupang:find -- --product-id 8035983162

# 7. 홈 프로모션 배너 조회 (상품 검색과 엄격히 구분)
npm run --silent coupang:banner

# 8. 계약 메타데이터 및 지원 상태 요약
npm run --silent coupang:catalog
```

직접 `node` 명령어로도 동일하게 실행할 수 있습니다:

```bash
node scripts/coupang-shopping.mjs feed --query 충전 --limit 5
node scripts/coupang-shopping.mjs deals --min-discount 40 --limit 5
node scripts/coupang-shopping.mjs sections --pages 2
node scripts/coupang-shopping.mjs find --vendor-item-id 95036224970
node scripts/coupang-shopping.mjs line-banner
```

---

## 2. 실제 지원 작업 (Operations)

- **`feed` (`POST /n-api/recommend/feeds`)**:
  - 서버 발급 continuation cursor를 **메모리 내에서만** 이어 호출하며 골드박스 특가·오늘의 할인 등 실제 추천 피드 블록의 상품과 가격을 수집합니다.
  - 식별자 계층(`productId`, `itemId`, `vendorItemId`)을 보존하며, 정상가(`basePriceKrw`), 판매가(`salePriceKrw`), 단위가격(`unitPrice`), 표시 할인율(`discountRatePercent`)을 분리 파싱합니다.
  - 요청 간 **1초 지연(1-second interval pacing)** 및 페이지 상한(최대 5페이지)을 엄격히 준수합니다.
- **`deals` (특가 편의 작업)**:
  - 수집된 피드 상품 중 특정 할인율(기본 >=20%) 이상인 상품을 선별하고 할인율 내림차순(`discount_desc`)으로 정렬합니다.
- **`sections` (피드 섹션 요약 작업)**:
  - 순회한 피드에 존재하는 섹션 이름(예: "골드박스 기간한정 파격 특가", "오늘의 할인"), 섹션별 상품 수, 대표 상품 샘플 3건을 집계합니다.
- **`find` (피드 내 식별자 조회)**:
  - 특정 `productId`, `vendorItemId`, 또는 `itemId`가 순회된 피드 인벤토리에 존재하는지 조회합니다. 존재하지 않는 경우 `matched: false`를 명확히 반환합니다.
- **`categories` (`GET /n-api/homeunit/BEST_CATEGORY`)**:
  - 공개 홈 카테고리 이름·그룹 코드를 반환합니다(`categoryId`는 응답의 `code`). 카테고리별 상품·가격 조회 기능은 포함하지 않습니다.
- **`line-banner` (`GET /n-api/homeunit/LINE_BANNER`)**:
  - 홈 프로모션 배너 목록을 반환합니다. 광고 클릭이나 방문 추적 파라미터는 실행/기록하지 않습니다.

---

## 3. 로컬 스코프 원칙 (중요 주의사항)

> [!WARNING]
> `feed`, `deals`, `sections`, `find`에서 제공되는 모든 필터링(`query`, `section`, `min-price`, `max-price`, `min-discount`) 및 정렬(`price_asc`, `discount_desc` 등)은 **순회된 피드 인벤토리(보통 15~30개 내외)를 대상으로 하는 로컬 연산**입니다.
>
> 이는 **쿠팡 전체 키워드 검색 엔진이나 임의의 모든 상품을 조회할 수 있는 상세 조회 API가 아닙니다**.

- **조기 절단 방지**: 정렬 및 `limit`은 각 페이지 요청 중 임의로 잘라내지 않고, 지정된 페이지 순회가 완료된 전체 대상 상품군에 대해 일괄 적용됩니다.
- **정밀도 손실 방지**: `productId`, `itemId`, `vendorItemId`는 64비트 부동소수점 손실을 방지하기 위해 양의 정수 문자열로 보존합니다.
- 안전 정수 범위를 넘는 숫자형 식별자는 오류로 처리합니다. `sections`는 반환 한도와 무관하게 순회한 전체 상품을 집계하며, `find`는 일치하는 옵션 목록과 조회 범위를 함께 반환합니다.

---

## 4. 지원하지 않는 경로 및 경계

1. **일반 키워드 검색 (`/np/search`) & 상품 상세 (`/vp/products/*`)**:
   - 브라우저 XHR이 아닌 **SSR HTML 문서 경로**입니다.
   - 현재 독립 HTTP 호출 시 **HTTP 403 Access Denied**로 응답합니다.
   - 해당 경로는 실행 명령에서 제외했습니다. 접근 거부 관측은 발굴 기록에 남깁니다.
2. **리뷰 API (`/vp/product/reviews`)**:
   - 일반 브라우징 흐름에서 독립 XHR로 관측되지 않은 후보(unobserved candidate)이며, 독립 호출 시 404/403 응답이 발생하여 런타임 실행에서 제외했습니다.
3. **개인 데이터 및 결제**:
   - 장바구니(`cart-count`), 방문 이력(`recently-viewed`, `viewed-products`), 주문/계정 정보는 수집 스코프에서 제외했습니다.
4. **가격 및 평점 해석 한계**:
   - 피드의 가격은 관측 시점의 화면 표시가이며, 로켓와우/쿠폰 자격이나 최종 결제 금액을 보장하지 않습니다 (`lowestPriceGuaranteed: false`, `payablePriceVerified: false`).
   - `ratingAverage`가 90, 100 등 모호한 척도로 전달될 경우 별점으로 임의 환산하지 않고 `sourceRatingSignal`에 원문 수치를 보존하며, `ratingAverage: null`, `ratingScaleVerified: false`로 처리합니다.

---

## 5. 보안 및 네트워크 안정성

- 고정 Host/Path/Method/Query/Body 화이트리스트 외 요청 거부 (`INPUT` 에러).
- **HTTP 429 Too Many Requests 분류가 HTML WAF 마커보다 우선** (`RATE_LIMITED`).
- 서버 발급 continuation cursor는 메모리 안에서만 사용 (파일·로그 저장 금지).
- 리다이렉트 자동 추적 거부 (`redirect: 'manual'`), 최대 응답 8 MiB 제한, 요청 타임아웃 15초.
- User-Agent 관측 결과: 일반 앱 식별 UA는 403으로 차단되었으며, 관측된 호환 헤더 프로필에서 200이 확인되었습니다 (헤더 차이 관측이며 영구적 가용성을 보장하지 않음).

---

## 6. 계약 문서 및 검증 기록

- [상세 계약 및 스키마 명세](references/coupang-shopping-contracts.json)
- [엔티티 관계 및 가격/검증 가이드](docs/coupang-shopping-contracts.md)
- [최신 독립 HTTP 실행 기록](references/host-live-http-reads-20260930.json): 상품30개·가격30개, 할인율30% 이상20개, 섹션2개, 카테고리18개. 키워드·가격·섹션 결합 필터와 상품·옵션 조회도 직접 실행했습니다. 수량과 가격은 조회 시점에 따라 변합니다.
- [AGY 구현 시점의 실행 기록](references/live-http-reads-20260930.json)
