# Naver travel price history (flight graph, hotel 1-night trend)

Verified live 2026-10-16 (KST), anonymous, plain HTTPS POST with a Chrome UA, `Origin`/`Referer` of the site. No cookies required.
Client: `naver-shopping-travel-crawler` `NaverTravelClient.flightPriceGraph()` / `.hotelPriceTrend()` (CLI `flight-price-graph`, `hotel-price-trend`).

## Flight: "항공권 가격 변동 그래프" (flight.naver.com results page)

- `POST https://flight-api.naver.com/graphql`, operation `GET_PRICE_GRAPH` (found in the `[...routes]` Next chunk).
- `priceGraph(searchKey, includeEventFare, nonstop, period, departureLocationType, arrivalLocationType) { averageLowestFare fares { lowestFare searchDate } }`
- `searchKey` = fareType + per leg `yyyymmdd`+origin+destination, e.g. `Y20261026ICNSPN20261030SPNICN`.
- Location types are the **lowercase** enum `airport` / `city`; `AIRPORT` returns `BAD_USER_INPUT`.
- `includeEventFare: true` is the page default ("카드요금" toggle on). `period: 60` on the page.
- Page math: min/max/avg over the series **plus the current search min fare** (avg rounded);
  "최근 2주 평균보다 N%" = round(|cur - averageLowestFare| / averageLowestFare * 100), |diff| <= 2% shows "비슷".
- Check: ICN-SPN 10/26~10/30, adult 1, Y, current 230,400 → 최저 211,800 / 최고 320,200 / 평균 258,987, 16% lower (matches the page).

## Hotel: "1박 최저가 추이" (hotels.naver.com detail)

- `POST https://hermes-hotel-svc-api.naver.com/graphql`, `query HotelDailyMinPrices($hotelId: String!, $checkIn: String!) { hotelDailyMinPrices(...) { checkIn price roomName logDate } }`
- ~30 `logDate` points of the 1-night lowest room price for that check-in date. Page ratio = round((total/nights - avg) / avg * 100).
