# 쿠팡 소비자 쇼핑 XHR 계약 및 독립 HTTP 커넥터 문서

- 작성 일자: 2026-09-30
- 런타임: Node.js >=24 (ESM native, zero external dependencies)
- 프로바이더: `coupang-consumer-shopping`
- 작업 위치: `/home/worker/coupang-shopping-crawler`

---

## 1. 개요 및 관측 결과

쿠팡 소비자 웹(`https://www.coupang.com/`)에서 관측한 공개 XHR 계약과 독립 HTTP 조회 결과를 정리합니다.

### 1) 라이브 독립 HTTP 검증 성공 XHR API (`/n-api/recommend/feeds`, `/n-api/homeunit/LINE_BANNER`)
- **`feed` (`POST /n-api/recommend/feeds`)**:
  - 1단계: `{"nextFeedsToken": ""}` 호출로 초기 `continuationToken`을 메모리 내에서 수신 (피드 0건, 커서 획득).
  - 2단계: 서버 발급 continuation cursor를 전달하여 실제 추천 피드 블록(예: "골드박스 기간한정 파격 특가", 15개 상품) 수신.
  - 3단계: 다음 continuation cursor를 전달하여 추가 피드 블록(예: "오늘의 할인", 15개 상품) 수신.
  - **독립 표준 HTTP replay로 30개 실제 상품 및 가격(정상가 `basePriceKrw`, 판매가 `salePriceKrw`, 단위가격 `unitPrice`, 할인율 등) 반환 검증 완료**.
  - cursor 토큰 및 tracking 필드는 메모리 내에서만 유지되며, 외부 반환 스키마나 로그에 유출되지 않음.
  - 요청 간 **1초 지연(1-second interval pacing)** 및 **최대 페이지 상한(maxPages, 기본 3페이지, 최대 5페이지 제한; 초기 커서 요청 1회 별도)** 적용.
- **`line-banner` (`GET /n-api/homeunit/LINE_BANNER`)**:
  - 홈 화면 프로모션 배너 데이터 3건 수신 (HTTP 200 OK, JSON).
  - 단, 배너는 마케팅 프로모션 배너이며 상품 검색/목록 카탈로그가 아님을 명시.

### 2) 공개 카테고리 메타데이터 (`/n-api/homeunit/BEST_CATEGORY`)
- **`categories` (`GET /n-api/homeunit/BEST_CATEGORY`)**:
  - 브라우저 탐색에서 관측 후 독립 Node24 HTTP200을 확인했습니다.
  - `defaultBestCategories`의 홈 그룹 코드(`categoryId = code`)·이름·제목만 반환합니다. 실제 상품 목록 경로의 카테고리 ID라는 의미는 아닙니다. 광고 메타정보와 추적 값은 반환하지 않습니다.
  - 카테고리별 상품 목록과 가격은 포함하지 않습니다.

### 3) SSR 문서 경로 (`/np/search`, `/vp/products/*`) 및 미관측 후보 (`/vp/product/reviews`)
- **`search` (`GET /np/search?q={query}`)**:
  - 브라우저 XHR API가 아닌 **Server-Side Rendered (SSR) HTML 문서 경로**입니다.
  - 독립 HTTP 요청 시 **HTTP 403 Access Denied** 응답이 관측됩니다.
  - 실행 클라이언트는 없으며 접근 거부 관측만 발굴 기록에 보존합니다.
- **`product` (`GET /vp/products/{productId}`)**:
  - SSR HTML 문서 경로로, 독립 HTTP 요청 시 **HTTP 403 Access Denied** 응답이 관측됩니다.
  - 실행 클라이언트는 없으며 접근 거부 관측만 발굴 기록에 보존합니다.
- **`reviews` (`GET /vp/product/reviews`)**:
  - 소비자 웹 브라우징 흐름에서 실제 독립 XHR로 관측되지 않은 **미관측 후보(unobserved candidate)**입니다.
  - 독립 HTTP 호출 시 HTTP 404/403 응답이 발생하며, 실행 코드에서 제외하고 발굴 기록으로만 유지합니다.

### 4) 개인 데이터 경로 (스코프 제외 및 발굴 이력 보존)
- `cart-count`, `recently-viewed`, `viewed-products`:
  - 개인 장바구니 및 방문 기록에 해당하므로 상품 수집 스코프에서 제외하고 `discoveryFrontier` 메타데이터로만 보존합니다.

---

## 2. 엔티티 관계: productId vs itemId vs vendorItemId

쿠팡의 상품 식별 체계는 단순한 `productId` 단일 구조가 아니며, 다음 3단계 계층 구조를 가집니다:

```text
[ productId ] (기본 카탈로그 상품군, 예: 8035983162)
      │
      ├─► [ itemId ] (옵션 / SKU 단위, 예: 22483457378 - 평판형/1개)
      │         │
      │         └─► [ vendorItemId ] (판매자 딜 / 위너, 예: 95036224970 - 로켓배송 판매자)
      │
      └─► [ itemId ] (옵션 / SKU 단위, 예: 22483457379 - 절곡형/1개)
                │
                └─► [ vendorItemId ] (판매자 딜 / 위너, 예: 95036224971 - 오픈마켓 판매자)
```

1. **`productId`**:
   - 상품의 상위 카탈로그 대표 번호입니다.
2. **`itemId`**:
   - 소비자가 선택하는 특정 규격/옵션(SKU) 번호입니다.
3. **`vendorItemId`**:
   - 쿠팡의 Buy Box(아이템위너) 시스템에서 해당 옵션을 실제 공급하는 판매자의 딜 번호입니다.
   - **실제 가격, 재고, 배송 조건(로켓배송 여부), 판매자 정보는 `vendorItemId`에 종속**됩니다.
   - 정수 식별자는 64비트 부동소수점 정밀도 손실을 방지하기 위해 **양의 정수 문자열(positive integer string)**로 보존합니다.

---

## 3. 가격 구조 및 준수 사항

- **기본가 / 정상가 (`basePriceKrw`)**: 할인 전 정가 또는 쿠팡 기준가 (`originalPrice`). 미관측 시 `null` 유지(판매가로 채우지 않음).
- **판매가 (`salePriceKrw`)**: 피드에 표시된 가격 (`salePrice` 또는 `price`). 회원·쿠폰 조건과 최종 결제 금액은 검증하지 않았습니다.
- **와우회원가**: 현재 응답에서 별도로 검증하지 않았으며 정규화된 반환 필드에 포함하지 않습니다.
- **할인율 (`discountRatePercent`)**: 정가 대비 할인율.
- **단위 가격 (`unitPrice`)**: 1개당/100g당 단위 가격.

### 절대 금지 사항:
- 전체 최저가 보장 주장 금지 (`lowestPriceGuaranteed: false`).
- 최종 결제 가격 보장 금지 (`payablePriceVerified: false`).
- 조건부 적립금 임의 합산 금지 (`conditionalRewardGuaranteed: false`).

---

## 4. 평점 신호 처리 원칙

- 쿠팡 피드 응답의 `ratingAverage`는 90, 100 등 백분율 또는 별점 기반 척도가 모호한 상태로 수신됩니다.
- 척도(5점 만점 vs 100점 만점)가 검증되지 않은 평점을 임의로 5점 척도 별점으로 변환하거나 창작하지 않습니다.
- 원문 값은 `sourceRatingSignal: raw.ratingAverage`, `sourceRatingField: 'ratingAverage'`로 그대로 보존하고, 정규화된 별점 `ratingAverage`는 `null`, `ratingScaleVerified: false`로 명시합니다.

---

## 5. 지원 작업 및 로컬 스코프 원칙

소비자 추천 피드 기반으로 다음 작업들을 지원합니다:

### 1) `feed`
- 추천 피드 블록을 순회하며 상품 목록과 표시 가격을 반환합니다.
- **로컬 필터링 지원**:
  - `query`: 상품명 대소문자 무관 부분 일치.
  - `section`: 피드 섹션명 또는 피드 타입 부분 일치.
  - `minPrice` / `maxPrice`: 판매가 범위 필터.
  - `minDiscount`: 최소 할인율(%) 필터.
  - `productId` / `vendorItemId` / `itemId`: 특정 식별자 일치.
- **정렬 지원**:
  - `price_asc`: 판매가 오름차순.
  - `price_desc`: 판매가 내림차순.
  - `discount_desc`: 할인율 높은 순.
  - `rating_signal_desc`: 평점 신호 높은 순.
  - `reviews_desc`: 리뷰 수 많은 순.
  - `none`: 피드 원문 수신 순서.
- **조기 절단 방지 원칙**: 정렬 및 `limit`은 수집된 전체 대상 상품군에 대해 크롤링 완료 후 적용됩니다.

### 2) `deals`
- 피드 상품 중 할인율이 특정 기준(기본 >=20%) 이상인 특가 상품만 추출하고 할인율 내림차순으로 정렬하는 편의 작업.

### 3) `sections`
- 피드에 포함된 섹션(예: "골드박스 기간한정 파격 특가", "오늘의 할인")의 목록, 섹션별 상품 수, 대표 상품 샘플 3건을 요약 반환.

### 4) `find`
- 특정 `productId`, `vendorItemId`, 또는 `itemId`가 관측된 피드 인벤토리에 존재하는지 확인하는 편의 작업.
- 피드에 존재하지 않는 경우 `matched: false`, `product: null`을 반환하며, **임의 상품 상세 API가 아님을 명확히 보고**합니다.

### ⚠️ 중요 스코프 한계:
- 모든 필터링 및 정렬은 **가져온 피드 인벤토리 범위의 로컬 작업(Local Filters)**입니다.
- 쿠팡 전체 키워드 검색 엔진이나 임의 상품 상세 서비스가 아니며, 이를 오인하게 표현하지 않습니다.

---

## 6. 보안 및 네트워크 방어 체계

1. **고정 화이트리스트 검증**:
   - Host: `www.coupang.com`만.
   - Path: `/n-api/recommend/feeds`, `/n-api/homeunit/LINE_BANNER` 등 관측된 경로로 엄격히 제한.
   - Userinfo, 포트 변경, 해시 프래그먼트, 비허용 쿼리/바디 필드는 `INPUT` 에러로 즉각 거부.
2. **에러 분류 우선순위**:
   - **HTTP 429 Too Many Requests 분류가 HTML WAF 마커보다 우선**합니다.
   - 응답 상태 코드가 429일 경우 HTML 본문 마커와 무관하게 `RATE_LIMITED`로 분류합니다.
3. **메모리 전용 커서 관리**:
   - 서버가 발급한 `continuationToken`은 메모리 내에서만 사용되며, 디스크·로그·CLI 출력에 기록되지 않습니다.
4. **네트워크 안전 상한**:
   - HTTP 리다이렉트 자동 추적 거부 (`redirect: 'manual'`).
   - 단일 응답 최대 8 MiB 제한.
   - 요청 타임아웃 15초 제한.
   - 피드 요청 간 1초 간격 유지.

---

## 7. 단계별 검증 매트릭스 (Evidence Ladder)

| Operation | Protocol / Nature | Browser XHR Captured | Client Exists | Remnant Free | Credential Propagated | Live Replay (HTTP) | Inspected / Returned |
|---|---|---|---|---|---|---|---|
| `feed` | XHR / JSON | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Public Anonymous | ✅ **200 OK** | 30개 수집 / 로컬 필터·정렬 적용 |
| `deals` | XHR / JSON (Derived) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Public Anonymous | ✅ **200 OK** | 30개 수집 / 할인율30% 이상20개(최신 조회 시점) |
| `sections` | XHR / JSON (Derived) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Public Anonymous | ✅ **200 OK** | 2개 섹션 요약 (30개 검사) |
| `find` | XHR / JSON (Derived) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Public Anonymous | ✅ **200 OK** | 30개 검사 / 특정 ID 일치 판별 |
| `line-banner` | XHR / JSON | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Public Anonymous | ✅ **200 OK** | 3건 배너 (상품 검색 아님) |
| `categories` | XHR / JSON | ✅ Yes (CDP) | ✅ Yes | ✅ Yes | ✅ Public Anonymous | ✅ **200 OK** | 공개 카테고리18개, 상품 목록 없음 |
| `search` | SSR / HTML | ❌ No (SSR) | ❌ No | N/A | N/A | ❌ **403 Access Denied** | 0개 (WAF_BLOCKED) |
| `product` | SSR / HTML | ❌ No (SSR) | ❌ No | N/A | N/A | ❌ **403 Access Denied** | 0개 (WAF_BLOCKED) |
| `reviews` | HTML Fragment | ❌ No (Unobserved) | ❌ No | N/A | N/A | ❌ **404 Not Found** | 0개 (HTTP_STATUS) |

[최신 코드의 독립 HTTP 조회 영수증](../references/host-live-http-reads-20260930.json)은 각 호출의 상태·응답 크기·해시와 코드 해시를 포함합니다. 이전 AGY 구현 단계의 기록은 별도로 보존합니다.
