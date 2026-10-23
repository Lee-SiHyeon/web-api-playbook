# Naver travel HTTP client

네이버 여행, 항공, 호텔의 실제 서비스 트래픽 분석(document 및 client JS 분석)을 통해 도출한 production-observed contract 기반의 Node.js 24+ 클라이언트입니다. 브라우저나 외부 런타임 없이 독립 HTTP/SSE 요청만 사용합니다.

- **발굴 방식**: document 및 배포 client JS 번들 분석을 통한 계약 식별 후 독립 네이티브 HTTP/SSE 리플레이 (`browserCaptureObserved: false`)
- **지원 범위**: 공개 읽기 한정 (국내/국제 실시간 항공권 운임, 국내 호텔 검색 및 객실 요금, 국내 여행 피드 카드, 국내 지역 자동완성)
- **제외/불가 범위**: 예약, 결제, 회원 계정 로그인, 해외 호텔 검색, 전체 여행사 투어 카탈로그 전체 크롤링

---

## 관측된 계약 및 지원 범위

1. **국제선 항공권 검색** (`POST https://flight-api.naver.com/flight/international/searchFlights`):
   - Server-Sent Events (SSE) 스트리밍 POST (`text/event-stream`).
   - 왕복/편도 여정 ID(`itineraryIds`)를 개별 leg으로 분할 매핑하여 출도착 시간, 항공사 코드/명칭, 편명, 운항 시간을 정규화합니다.
   - 가격 단위: `priceScope = "per_adult"` (`sourcePriceField = "adult.totalFare"`). 성인 1인당 유류할증료/세금 포함 운임이며, 일행 전체 합계가 아닙니다 (`occupancyPricingVerified = false`).
2. **국내선 항공권 검색** (`POST https://flight-api.naver.com/flight/domestic/searchFlights`):
   - SSE 스트리밍 POST (`text/event-stream`).
   - 국내 주요 공항(GMP, CJU 등)의 편도 구간별 실시간 운임 및 잔여 좌석 조회.
   - 가격 단위: `priceScope = "per_leg"` (`sourcePriceField = "s.minFare"`). 구간별 편도 운임이며 왕복 결합 최저가가 아닙니다.
3. **항공 프로모션 카드** (`POST https://flight-api.naver.com/graphql`):
   - GraphQL `flightsCards` 쿼리. 카드사 즉시할인/청구할인 프로모션 카테고리 식별.
4. **국내 호텔 검색** (`POST https://hermes-hotel-svc-api.naver.com/graphql`):
   - Hermes Hotel GraphQL `domesticHotelList` 쿼리.
   - 국내(대한민국) 숙소 검색 한정 (해외 호텔 미지원).
   - 가격 단위: `priceScope = "indicative_hotel_min_rate_without_dates"`. 투숙 일정이 지정되지 않은 대표 최저 안내 가격이며, 실제 투숙일 요금은 `hotelRates`로 조회해야 합니다.
5. **호텔 실시간 객실 요금** (`POST https://hermes-hotel-svc-api.naver.com/graphql`):
   - Hermes Hotel GraphQL `domesticHotelRates` 쿼리.
   - 투숙 기간, 성인 수, 아동 연령에 따른 OTA 제휴사별 실시간 객실 요금, 취소 규정, 조식 포함 여부 조회.
   - 가격 단위: `priceScope = "quoted_listing_rate"` (`sourcePriceField = "rate.userRate"`). 제휴사에서 제공하는 목록 인용 요금이며 최종 결제 단계의 카드사 할인이나 추가 옵션에 따라 달라질 수 있습니다.
6. **국내 여행 상품 및 큐레이션 호텔** (`GET https://travel.naver.com/domestic`):
   - document SSR 수신 후 `__NEXT_DATA__` 내 React Query 탈수 상태(dehydratedState) 추출 (`document_ssr_hydration`).
   - 지자체 시티투어 등 국내 패키지 20선(`tourProduct`) 및 지역 대표 숙소 20선(`hotelProduct`)의 시작가(`indicative_starting_price`) 확인.
7. **국내 지역 자동완성** (`POST https://travelsearch-api.naver.com/graphql`):
   - GraphQL `domesticAutocompleteSearch` 쿼리. 대한민국 행정구역 코드(rcode) 및 공식 명칭 반환.

---

## CLI 사용법

저장소 루트에서 실행합니다. 출력은 성공 시 stdout의 JSON 단일 객체, 실패 시 stderr의 JSON 단일 객체입니다. 종료 코드는 성공 0, 호출 실패 1, 잘못된 입력 2입니다.

`npm exec --yes --package=node@24 -- node scripts/naver-travel.mjs ...` 또는 npm 스크립트 `npm run --silent naver:travel -- ...`를 사용합니다.

```bash
# 1. 국제선 왕복 항공권 검색 (ICN ↔ NRT, 2026-10-15 ~ 2026-10-20, 성인 2인)
npm run naver:travel -- flight-search --type international --departure ICN --arrival NRT --departure-date 20261015 --return-date 20261020 --adult 2 --seat-class Y

# 2. 국내선 왕복 항공권 검색 (GMP ↔ CJU, 2026-10-15 ~ 2026-10-20, 성인 1인)
npm run naver:travel -- flight-search --type domestic --departure GMP --arrival CJU --departure-date 20261015 --return-date 20261020

# 3. 항공 프로모션 카드 조회
npm run naver:travel -- flight-cards

# 4. 국내 호텔 검색 (서울 지역 인기순)
npm run naver:travel -- hotel-search --query 서울 --size 10 --sort POPULAR_DESC

# 5. 호텔 실시간 객실 요금 조회 (그랜드 워커힐 서울, 2026-10-15 ~ 2026-10-20, 성인 2인)
npm run naver:travel -- hotel-rates --hotel-id 11583218 --check-in 2026-10-15 --check-out 2026-10-20 --adult 2

# 6. 네이버 여행 국내 피드 상품 (투어 상품 및 큐레이션 호텔 목록)
npm run naver:travel -- travel-products --category tour --limit 20
npm run naver:travel -- travel-products --category hotel --limit 20

# 7. 국내 지역 자동완성 검색
npm run naver:travel -- travel-autocomplete --keyword 제주

# 8. 관측된 계약 카탈로그 확인
npm run naver:travel -- catalog
```

---

## JavaScript 연동

```js
import { NaverTravelClient } from './adapters/naver-travel.mjs';

const client = new NaverTravelClient();

// 국제선 항공권 검색 (왕복 각 leg 분할 매핑 및 성인 1인 요금 수신)
const flights = await client.flightSearch({
  type: 'international',
  departureAirport: 'ICN',
  arrivalAirport: 'NRT',
  departureDate: '2026-10-15',
  returnDate: '2026-10-20',
  adult: 2,
  seatClass: 'Y',
});
console.log(`항공편 ${flights.totalCount}건 관측, 성인1인 요금: ${flights.items[0]?.listingPriceKrw} KRW`);

// 국내 호텔 검색 (투숙일 미지정 대표 최저가 목록)
const hotels = await client.hotelSearch({
  query: '서울',
  size: 5,
  sort: 'POPULAR_DESC',
});
for (const h of hotels.items) {
  console.log(h.title, h.listingPriceKrw, h.starCount);
}

// 특정 호텔 실시간 객실 요금 (지정 투숙일 및 인원 기준 제휴사 인용 요금)
const rates = await client.hotelRates({
  hotelId: '11583218',
  checkIn: '2026-10-15',
  checkOut: '2026-10-20',
  adult: 2,
});
console.log(`객실 옵션 ${rates.rates.length}건, 인용 요금: ${rates.rates[0]?.listingPriceKrw} KRW`);
```

---

## 안전장치 및 제약 사항

1. **내부 전용 전송 격리**: 외부 호출 가능한 임의의 `request` 메서드는 제거되었으며, 내부 전용 `#request`를 통해 사전 정의된 엔드포인트와 읽기 전용 Named GraphQL 쿼리만 실행됩니다. 임의 mutation이나 임의 URL 전송은 네트워크 시도 전 원천 차단됩니다 (`INPUT`).
2. **입력값 검증**:
   - 현재 한국 시각(KST) 기준 과거 날짜 및 달력 오버플로(예: 2027-02-30)는 네트워크 요청 전에 즉시 거부됩니다.
   - 편도(OW) 여정에 귀국일이 지정되거나, 성인+소아 합계 좌석이 9석을 초과하거나, 유아가 성인 수를 초과하는 경우 선제 거부됩니다.
   - 호텔 ID는 양의 정수 문자열만 허용되며, 좌표 및 반경은 유효 범위 내로 제한됩니다.
3. **에러 및 보안 격리**:
   - HTTP 429는 응답 본문 검사보다 먼저 감지되어 `RATE_LIMITED`로 분류되며 자동 재시도를 수행하지 않습니다.
   - 리다이렉트 발생 시(`REDIRECT_REJECTED`) 대상 `Location` URL이나 쿼리 파라미터를 에러 메시지에 노출하지 않아 토큰 유출을 방지합니다.
   - GraphQL 응답에 `errors`가 포함된 경우 원문 에러 상세를 노출하지 않고 안전한 `GRAPHQL_ERROR` 코드로 처리합니다.
   - 모든 반환 텍스트는 `untrusted_external_text`로 마킹되며 세션 쿠키, 계정 토큰 등은 저장되지 않습니다.

응답 상한은 8 MiB입니다. 스트림이 완료되지 않은 경우 `streamCompleted: false`로 표시되며 전체 검색 완료를 뜻하지 않습니다. 미확인 불리언 값과 누락된 여정 정보는 `null`로 유지합니다. `--nonstop`은 국제선 계약에서만 지원합니다.
