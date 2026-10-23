# 네이버 쇼핑·여행 HTTP 커넥터

[브랜드 상품 페이지 HTTP 조회](docs/naver-brand-product-page.md): `product-page`로 상품·가격·리뷰 집계를 브라우저 없이 조회합니다. 4개 브랜드9개 상품을 확인했습니다. 원천은 SSR 문서이며, 상품 JSON XHR·리뷰 본문은 아직429입니다.

Node.js 24 이상. 브라우저는 계약 탐색에만 사용하며 일반 호출은 독립 HTTP로 실행합니다.

```bash
npm ci
npm run --silent naver:shopping -- integrated-search --query 노트북
npm run --silent naver:shopping -- feed --section promotion
npm run --silent naver:shopping -- catalog
npm run --silent naver:deals -- --output evidence/today-deals.json

# 브랜드 상품 페이지의 구조화 데이터 (별도 Python HTTP 의존성)
python3 -m pip install --target .runtime/http-python -r requirements-http.txt
npm run --silent naver:shopping -- product-page --product-url https://brand.naver.com/hera/products/9215718713

# 네이버 여행 (항공/호텔/국내여행)
npm run --silent naver:travel -- flight-search --type international --departure ICN --arrival NRT --departure-date 20261015 --return-date 20261020 --adult 2
npm run --silent naver:travel -- flight-search --type domestic --departure GMP --arrival CJU --departure-date 20261015 --return-date 20261020
npm run --silent naver:travel -- hotel-search --query 서울 --size 10
npm run --silent naver:travel -- hotel-rates --hotel-id 11583218 --check-in 2026-10-15 --check-out 2026-10-20 --adult 2
npm run --silent naver:travel -- travel-products --category all --limit 20
npm run --silent naver:travel -- catalog
```

## 쇼핑 도메인별 가용 범위

2026-09-30 워커의 독립 HTTP 관측 기준입니다.

| 도메인 | 조회 범위 | 상태 |
|---|---|---|
| `search.naver.com` | 통합검색에 노출된 한정된 상품 카드·표시 가격 | 지원 |
| `shopsquare.naver.com` | 공개 쇼핑·브랜드 소개·프로모션 카드(가격이 제공된 경우만 반환) | 지원 |
| `shopping.naver.com` + `vertical-api.shopping.naver.com` | 오늘끝딜 기본 스페셜딜 상품·표시 가격 | 지원 |
| `brand.naver.com` 상품 문서 | `product-page`: 상품·가격·리뷰 집계, SSR 상태 | 독립 HTTP 지원, 4개 브랜드9개 상품 확인 |
| `brand.naver.com` 상품 JSON·리뷰 API | 별도 XHR 상품 상세·리뷰 본문 | 독립 HTTP 429, 미완료 |
| `smartstore.naver.com` | 개별 스마트스토어 상품·리뷰 | 지원 계약 미확인 |
| `search.shopping.naver.com` | 네이버 쇼핑 전용 검색 | HTTP418 소스 제거, 미지원 |

`shopsquare.naver.com/newbrandshop`의 공개 브랜드 소개 피드와 `brand.naver.com`의 개별 스토어 상세는 서로 다른 경로입니다. 공개 카드의 가격·평점·리뷰 수가 보이더라도 전체 리뷰 본문을 가져왔다는 뜻은 아닙니다. 전체 상품 목록과 최종 결제 금액은 보장하지 않습니다.

[최신 브랜드 소개 피드 조회](references/naver-brand-feed-read-20260930.json)는 HTTP200·카드10개·가격 제공0개였습니다. 브랜드 소개 피드가 열린다는 사실로 상품 가격 조회까지 가능하다고 해석하지 않습니다.

브랜드 스토어는 정상 브라우저의 상품 JSON·리뷰 요청에서 200을 재현했지만 Node/curl 독립 HTTP는 429였습니다. [이전 성공과 현재 실패의 대조 기록](docs/naver-store-hypothesis-results.md)에 실행 환경과 입증 범위를 정리했습니다.

현재 여행: 국제선/국내선 실시간 항공권 검색(SSE 스트리밍), 국내 호텔 검색 및 실시간 객실 요금 조회(GraphQL), 네이버 여행 국내 투어/호텔 피드 상품(SSR 탈수 상태 추출), 국내 지역 자동완성(GraphQL) 등 독립 HTTP 라이브 조회 지원.

[쇼핑 사용법](docs/naver-shopping-api-only.md) · [쇼핑 계약과 상태](references/naver-shopping-contracts.json) · [여행 사용법](docs/naver-travel-api-only.md) · [여행 계약과 상태](references/naver-travel-contracts.json)

[2026-09-30 독립 HTTP 조회 기록](references/live-read-verification-20260930.json): 쇼핑 2개 동작과 여행 7개 동작의 상태·응답 크기·해시·반환 개수. 가격은 관측 시점의 값이며 최종 결제 금액이나 전체 시장 최저가가 아닙니다. 해외 호텔 검색과 예약·결제는 지원하지 않습니다.

오늘끝딜의 기본 스페셜딜 행사도 독립 HTTP로 수집합니다. [오늘끝딜 사용법·가격 기준](docs/naver-today-deals.md) · [원본 기여와 계약](references/naver-today-deals-contracts.json). 여행 피드의 시작 가격과 항공 카드 혜택 메타정보는 제공하지만, 기간 한정 여행 핫딜을 판정하는 전용 수집기는 아직 없습니다.

[다른 브랜드 상품 비교](docs/naver-multi-brand-products.md): 헤라·다이슨·농심·이니스프리 각2개, 총8개 상품에서 브라우저 문서·JSON200과 Node 독립 HTTP429를 확인했습니다. 전체 도메인 검증은 아닙니다.
