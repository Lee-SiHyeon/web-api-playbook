# Zigzag (지그재그) public reads

확인일: 2026-10-20 (관측 날짜). 대상: 지그재그 웹 `https://zigzag.kr`과 GraphQL API `https://api.zigzag.kr/api/2/graphql/*`.
용도: AI 진행자 여행 영상의 착장 소싱(카테고리별 인기 상품 후보, 상품 이미지 수집).
구현: [scripts/zigzag.mjs](../scripts/zigzag.mjs). 에이블리 구현([commerce-ably.md](commerce-ably.md))과 같은 영수증·간격·차단 분류 구조를 쓴다.

## 사용법

Node 24 이상, 의존성 없음. 결과는 JSON(stdout, `--output=<새 파일>` 선택).
기본 전송 방식은 `--transport=cdp`(아래 "HTTP 차단 관측" 참고). Chrome Canary CDP `127.0.0.1:9333`이 떠 있어야 한다.

```sh
node scripts/zigzag.mjs categories --parent=689                 # 카테고리 트리(689 = 패션잡화)
node scripts/zigzag.mjs rank --category=tops --limit=10         # 상의 인기순 상위 10
node scripts/zigzag.mjs rank --all --limit=5                    # 8개 카테고리 전부
node scripts/zigzag.mjs rank --category=547,560 --limit=10      # 팬츠+스커트(ID 직접 지정)
node scripts/zigzag.mjs search "리조트 원피스" --limit=30        # 키워드, 인기순
node scripts/zigzag.mjs search "크롭 나시" --sort=recommend      # 추천순
node scripts/zigzag.mjs goods 119621317 --reviews=10            # 상세: 이미지, 옵션, 가격, 카테고리
node scripts/zigzag.mjs images 119621317 --out="D:/work/zigzag-119621317" --reviews=30
```

별칭(`--category`): `tops`=474 상의, `bottoms`=547,560 팬츠+스커트, `dress`=507 원피스, `outer`=436 아우터,
`swim`=751 비치웨어(비키니 752, 원피스 수영복 758, 래쉬가드 759, 비치원피스 760 포함), `bag`=623 가방,
`hat`=702 모자, `sunglasses`=745 선글라스. 숫자 ID(쉼표 최대 5개)도 받는다. ID는 바뀔 수 있으므로
`categories --parent=689`(또는 `--parent=-1`)로 다시 확인한다.

정렬(`--sort`, 기본 `popular`): `popular`=인기순(200), `review`=리뷰많은순(201), `recommend`=추천순(205, 웹 기본값),
`new`=신상품순(206), `price-asc`=저가순(203), `price-desc`=고가순(204), `discount`=할인율 높은순(207).

## 동작과 경계

- 실행 모드: 기본 `cdp`(`browser_page_fetch`). 스크립트가 Canary에 `zigzag.kr` 탭을 하나 열고, 그 탭 안에서
  사이트 클라이언트와 같은 GraphQL `POST`를 보낸 뒤 탭을 닫는다. Canary 프로세스는 건드리지 않는다.
  `--transport=http`(Node fetch)는 구현만 남겨 두었고 현재 차단된다(아래).
- 계정: 로그인하지 않는다. `GetUserName`, `GetCartItemsCount`, `IsLoggedIn` 등 계정 오퍼레이션은 호출하지 않는다.
  `credentials: 'omit'`으로 쿠키를 보내지 않는다(영수증 `cookiesSent:false`). 관측 시 익명 상태였다(`user_account: null`).
- 간격: 요청 사이 최소 3초(`--interval-ms`로 늘릴 수만 있음).
- 중단: 401/403/418/451/챌린지 마커/429는 재시도하지 않고 즉시 중단한다([anti-bot-boundaries](anti-bot-boundaries.md)).
  예외로 탭 안 `fetch`가 네트워크 수준에서 `Failed to fetch`로 끝나면 탭 안에서 최대 3회까지 4초 간격으로 다시 시도한다(읽기 전용).
- 쓰기 없음: 찜, 장바구니, 공유 링크 생성(POST)은 구현하지 않았다.
- 탭 정리: 명령마다 탭을 새로 열고 명령이 끝나면(성공이든 실패든) 그 탭만 `/json/close/{id}`로 닫는다.
  관측 중 Canary의 다른 작업자 탭은 건드리지 않았다.

## HTTP 차단 관측 (2026-10-20)

- Node `fetch`로 `POST https://api.zigzag.kr/api/2/graphql/GetClpTopComponentList`를 보내면 HTTP 200이지만
  `content-type` 없이 본문 0바이트가 오고, 응답 헤더는 `server: CloudFront`, `x-cache: Error from cloudfront`였다.
  `GET https://zigzag.kr/categories/-1`도 Node에서 같은 빈 응답이었다.
- 같은 요청을 curl로 보내면 200과 정상 JSON(3,799 bytes)이 온다. `User-Agent`를 바꾸는 것만으로는 해결되지 않는다.
- Node 요청에 `sec-ch-ua`, `Sec-Fetch-*`, `Origin`/`Referer`를 하나씩 더하면 여전히 실패하고, 브라우저 힌트 묶음을 전부 넣어야
  통과했다. 이는 CloudFront가 비브라우저 클라이언트를 가려내는 조건에 맞춰 헤더를 위조하는 것이므로 구현하지 않았다.
  대신 실제 브라우저 탭 안에서 사이트 클라이언트 자신이 보내는 요청과 같은 요청을 보낸다.
- 탭 안 `fetch`는 페이지 로드 직후 첫 요청이 간헐적으로 `Failed to fetch`로 실패했다(반복 재현 시 대부분 성공).
  준비 후 3초 대기와 최대 3회 재시도로 완화했다. `credentials: 'include'`는 실패, `omit`/`same-origin`은 간헐 실패가 섞였다.
- 상품 이미지 원본 `origin_url`의 일부는 `https://s3.ap-northeast-2.amazonaws.com/product-image.s.zigzag.kr/...`이며
  익명 요청에 `403 AccessDenied`다. 같은 키를 `https://cf.product-image.s.zigzag.kr/...`에서 받으면 `200 image/jpeg`다.
  `images`는 CDN 호스트를 쓴다.
- 리뷰 사진은 `content-type: binary/octet-stream`으로 온다. MIME이 아니라 파일 시그니처(JPEG/PNG/GIF/WEBP)로 판정한다.
- 정적 청크(`/resources/.../_next/static/chunks/*.v3.js`)는 익명 curl에 `403 AccessDenied`다.

## 엔드포인트 (GraphQL)

모든 호출은 `POST https://api.zigzag.kr/api/2/graphql/<OperationName>`, 본문 `{"query": "...", "variables": {...}}`,
`Content-Type: application/json`. 웹 클라이언트가 보내는 쿼리 문자열을 그대로 쓴다(persisted hash 미사용).
쿼리 원문은 스크립트 안에 들어 있다. 웹 클라이언트 번들이 바뀌면 쿼리 필드도 바뀔 수 있다.

| 기능 | 오퍼레이션 | variables (요지) |
|---|---|---|
| 카테고리 트리 | `GetClpTopComponentList` | `{display_category_id_list:[parent], page_id:"srp_clp_category"}` |
| 카테고리 상품 목록 | `GetSearchResult` | `{input:{display_category_id_list:[id,...], page_id:"web_srp_clp_category", filter_id_list:[sortId], after?}}` |
| 키워드 검색 | `GetSearchResult` | `{input:{q, page_id:"srp_item", filter_id_list:[sortId], filter_list:[], sub_filter_id_list:[], after}}` |
| 상세 리뷰 | `GetPdpIntegratedData` | `{catalog_product_id, limit_count, order:"EXPERIENCE_GROUP_BEST_SCORE_DESC"}` |
| 상세 이름·가격·이미지·옵션 | `GetCatalogProductDetailPageOption` | `{catalog_product_id, input:{catalog_product_id}}` |

- 정렬은 `filter_id_list`에 정렬 `str_id`를 붙인다(웹 클라이언트 `concat(sort)` 로직). 인기순(200)과 추천순(205) 결과 순서가 실제로 다른 것을 확인했다.
- 페이지: 응답 `end_cursor`와 `has_next`. 다음 쪽은 `input.after`에 `end_cursor`를 넣는다. 스크립트는 최대 6쪽을 읽는다.
- 응답 카드(`ui_item_list[].type == "UX_GOODS_CARD_ITEM"`): `goods_id`, `shop_id`, `shop_name`, `title`,
  `price`(정가, KRW), `final_price`(할인가), `discount_rate`, `image_url`, `display_review_count`(문자열, `"1,105"` 형식),
  `review_score`(평점), `is_ad`, `sellable_status`. `ranking` 필드는 관측한 모든 카드에서 `null`이다.
- 상세: `product_price.max_price_info.price`(정가), `product_price.final_discount_info.discount_price`(할인가)를 쓴다.
  할인 상품 `119621317`에서 정가 21,500 / 할인가 19,350이 카드 값과 일치했다.
  `managed_category_list`(패션의류 > 여성 스포츠의류 > 수영복/비치웨어 > 비치 상의/커버업 등), `product_option_list`(`value_list[].value`는 "화이트", "그레이"처럼 옵션명, `code`는 색 헥스),
  `product_image_list[]`(`image_type` MAIN/SUB, `url`은 CDN, `origin_url`은 S3일 수 있음),
  `ux_review_list.item_list[]`(`rating`, `contents`, `image_list[].thumbnail_url`),
  `related_product_review_summary.overview.aggregate.total`(`count`, `average_rating`).
- 없는 상품 ID(예: `1`)는 GraphQL `errors`가 온다 → `ZIGZAG_GRAPHQL_ERROR`.

## 순위 정의

지그재그 응답에는 순위 필드가 없다. `rank`는 인기순(`popular`) 정렬 목록에서 광고 카드(`is_ad`)를 뺀 순서를 `rank`로 쓴다.
광고는 `adsSkipped`에 개수만 남긴다. 순위 값은 "웹 인기순 목록의 위치"이며 지그재그가 공표한 랭킹과 같다는 보장은 없다.
카테고리 목록에는 남성용 상품도 섞인다(예: 비치웨어의 래쉬가드 `136596009` 옵션이 "남성용 그레이M"). 성별은 필터링하지 않는다.

## 카테고리 ID (2026-10-20 관측)

| 별칭 | ID | 출처 |
|---|---|---|
| 상의 | 474 | 최상위 트리 |
| 아우터 | 436 | 최상위 트리 |
| 팬츠 / 스커트 | 547 / 560 | 최상위 트리 |
| 원피스 | 507 | 최상위 트리 |
| 비치웨어 | 751 | 최상위 트리 |
| 패션잡화 | 689 | 최상위 트리(`categories`에 없음, 검색 필터에서 확인) |
| 모자 | 702 | 689 하위 |
| 아이웨어 / 선글라스 | 743 / 745 | 689 하위 |
| 가방 | 623 | 검색 CATEGORY 필터에서 확인, `rank --category=bag` 결과(가방 상품 표시) |

가방(623)은 `categories --parent=689` 트리에 나타나지 않는다. ID 623은 키워드 "가방" 검색의 CATEGORY 필터 값과
`rank` 결과 상품명으로 확인했다. 트리 구조가 바뀌면 이 표를 다시 확인한다.

## 실행 샘플 (2026-10-20 실측, 상위 3개)

모든 명령은 `--transport=cdp`(기본)로 실행했다. 요청 영수증은 명령 출력의 `requests`에 있다(요청마다 상태 코드, 바이트 수, 익명 여부만 기록).

### categories --parent=689

| ID | 이름 | 하위 개수 | 하위 상위 3개 |
|---|---|---|---|
| 689 | 전체 | 0 |  |
| 690 | 핸드폰 | 3 | 전체, 핸드폰 케이스, 핸드폰 액세서리 |
| 693 | 양말 | 8 | 전체, 양말, 페이크삭스 |

### rank --all --limit=3 (인기순, 광고 제외)

| 카테고리 | 순위 | 상품 ID | 쇼핑몰 | 상품명 | 정가 → 할인가 (KRW) | 평점 | 리뷰 수 | 상품 URL |
|---|---|---|---|---|---|---|---|---|
| 상의 | 1 | 145426176 | 리얼코코 | [기모추가🤎/스트라이프&무지/10만장돌파/made] 로셀 라 | 33,900 → 12,200 | 4.6 | 18015 | https://zigzag.kr/catalog/products/145426176 |
| 상의 | 2 | 167182302 | 슬로우리스트 | [가을하객룩✨][MADE]드넬 하이넥 타이 블라우스[3colo | 44,900 → 35,920 | 4.8 | 1109 | https://zigzag.kr/catalog/products/167182302 |
| 상의 | 3 | 172273477 | 슬로우앤드 | [🎉안국감사제/무료배송] made. 아르벨 홀가먼트 헤어리니 | 55,000 → 44,000 | 4.9 | 27 | https://zigzag.kr/catalog/products/172273477 |
| 하의(팬츠·스커트) | 1 | 159899063 | 슬로우앤드 | [핏보정팬츠] made. 나이브 히든밴딩 세미부츠컷 팬츠 (+ | 29,900 → 26,910 | 4.8 | 7169 | https://zigzag.kr/catalog/products/159899063 |
| 하의(팬츠·스커트) | 2 | 171971621 | 어텀 | 워크커브드팬츠 | 36,000 → 28,800 | 4.8 | 4346 | https://zigzag.kr/catalog/products/171971621 |
| 하의(팬츠·스커트) | 3 | 168536695 | 텐가트 | 🍂[2만장돌파/트임걱정없이][가을하객룩] made 포이즈 H | 31,600 → 26,160 | 4.8 | 2206 | https://zigzag.kr/catalog/products/168536695 |
| 원피스 | 1 | 147171009 | 리얼코코 | [가을원피스🤎/하객룩/made] 리브엘 셔링 캉캉 미니원피스 | 42,900 → 24,010 | 4.7 | 3538 | https://zigzag.kr/catalog/products/147171009 |
| 원피스 | 2 | 166210828 | 니썸 | [가을🍁원피스/핀턱원피스/미니원피스/원피스/긴팔원피스/레이어 | 50,900 → 33,040 | 4.8 | 370 | https://zigzag.kr/catalog/products/166210828 |
| 원피스 | 3 | 114128513 | 가내스라 | [💫몸매보정][하객룩][ordinaire] 아르테 원피스 ( | 63,500 → 50,800 | 4.8 | 9819 | https://zigzag.kr/catalog/products/114128513 |
| 아우터 | 1 | 171703333 | 스파오 | [백지헌/지구지수PICK💖][리사이클] 베이직 퍼플리스 집업 | 29,900 → 24,210 | 4.8 | 10565 | https://zigzag.kr/catalog/products/171703333 |
| 아우터 | 2 | 165709968 | 케이클럽 | [MADE/뉴컬러]솜므 투웨이 스웨이드 레더 자켓 (S-M/3 | 52,000 → 41,600 | 4.7 | 1044 | https://zigzag.kr/catalog/products/165709968 |
| 아우터 | 3 | 165137881 | 하네 | [커치프 SET][11 Color]에센셜 라운드 가디건 | 94,000 → 39,760 | 4.8 | 2227 | https://zigzag.kr/catalog/products/165137881 |
| 수영복·비치웨어 | 1 | 160447447 | 비키니밴더 | 레베랑스 셔링 스커트 모노키니 - Cream [수영복/체형커버 | 65,000 → 46,310 | 4.9 | 1042 | https://zigzag.kr/catalog/products/160447447 |
| 수영복·비치웨어 | 2 | 169655742 | 비키니밴더 | 홀터 셔링 텍스쳐 스커트 모노키니 - Cream | 65,000 → 48,750 | 4.8 | 563 | https://zigzag.kr/catalog/products/169655742 |
| 수영복·비치웨어 | 3 | 166164173 | 비키니밴더 | 데니스 홀터 에스닉 언발란스 원피스 - Multi [휴양지/여 | 55,000 → 39,180 | 4.8 | 224 | https://zigzag.kr/catalog/products/166164173 |
| 가방 | 1 | 159416332 | 고세 | [스웨이드BEST][주미니,lean PICK🍂] 미들클레어  | 72,900 → 46,830 | 4.8 | 2258 | https://zigzag.kr/catalog/products/159416332 |
| 가방 | 2 | 121649380 | 고세 | [브랜드가방1위🏆스웨이드🍂] 프리쇼퍼백 KC1399C (7 | 66,900 → 39,130 | 4.9 | 16266 | https://zigzag.kr/catalog/products/121649380 |
| 가방 | 3 | 172149893 | 린츠 | basil bag 바질 백 (스웨이드 올리브) | 88,000 → 43,110 | 4.8 | 309 | https://zigzag.kr/catalog/products/172149893 |
| 모자 | 1 | 171308973 | 휴먼앤캣 | [단독컬러] 파운드2 워시드 빈티지 볼캡 (11색상) | 49,900 → 20,930 | 4.8 | 396 | https://zigzag.kr/catalog/products/171308973 |
| 모자 | 2 | 167165434 | 휴먼앤캣 | 파운드 워시드 빈티지 볼캡 [블랙] | 49,900 → 20,930 | 4.9 | 180 | https://zigzag.kr/catalog/products/167165434 |
| 모자 | 3 | 172012776 | 스틸로우키 | ⭐️입점특가⭐️ 스틸로우키 캡모자 SLK002 BLACK 볼캡 | 42,000 → 23,100 | 4.9 | 28 | https://zigzag.kr/catalog/products/172012776 |
| 선글라스 | 1 | 142675291 | 블루씨티 | 하트 픽셀 UV400 자외선차단 타원형 선글라스 5color | 8,900 → 6,920 | 4.8 | 593 | https://zigzag.kr/catalog/products/142675291 |
| 선글라스 | 2 | 168176707 | 포지타노 | [자외선차단] DELTA 1색상 여자 데일리 뿔테 패션 선글라 | 28,900 → 14,700 | 4.8 | 51 | https://zigzag.kr/catalog/products/168176707 |
| 선글라스 | 3 | 161457285 | 리에티 | [BEST🏆] 리에티 TEONA 3색상 자외선차단 선글라스 | 49,000 → 35,250 | 4.9 | 497 | https://zigzag.kr/catalog/products/161457285 |

첫 카테고리(상의) 상위 1개 원본 필드 (중략 없이 전부):

```json
{
  "rank": 1,
  "id": "145426176",
  "shop": {
    "id": 200,
    "name": "리얼코코"
  },
  "name": "[기모추가🤎/스트라이프&무지/10만장돌파/made] 로셀 라인 셔츠 (7color)",
  "priceKrw": {
    "original": 33900,
    "sale": 12200,
    "discountRate": 75
  },
  "image": "https://cf.product-image.s.zigzag.kr/original/d/2026/8/24/200_202608241016156235_16684.gif",
  "productUrl": "https://zigzag.kr/catalog/products/145426176",
  "reviews": {
    "count": 18015,
    "rating": 4.6
  },
  "sellableStatus": "ON_SALE",
  "isAd": false,
  "listPosition": 1
}
```

### search "리조트 원피스" --limit=3 (인기순)

| 리스트 위치 | 상품 ID | 쇼핑몰 | 상품명 | 정가 → 할인가 (KRW) | 평점 | 리뷰 수 | 광고 |
|---|---|---|---|---|---|---|---|
| 1 | 167955502 | 데이달링 | [자체제작]리조트룩 끈소매 원피스(여름/사계절/동남아/휴가/휴 | 37,800 → 25,410 | 4.8 | 972 | false |
| 2 | 161845238 | 어썸나나 | [고급미✨/44-66] 글리즈 새틴 플레어 롱원피스 여름 휴양 | 32,800 → 26,240 | 4.8 | 130 | false |
| 3 | 134107361 | 메이비치 | [단독🌟] 시폰 홀터 미니 원피스(44-66) 동남아 휴양지 | 38,000 → 30,400 | 4.8 | 336 | false |

총 결과 수: 응답에 없음(`totalCount: null`). 읽은 쪽 1, `endReached: false`.

### goods 119621317 --reviews=3

- 상품: [루즈핏/살안타템☀️] 메이젠 크롭 니트 커버업 티셔츠 체형커버 군살커버 긴팔 여름니트 여름가디건 상의 휴양지룩 비치웨어 (ID 119621317, 쇼핑몰 비키비키, shop_id 793)
- 가격: 정가 21,500원 → 할인가 19,350원 (쿠폰 COUPON_AVAILABLE)
- 배송비: FREE, 기본 0원, 제주/도서산간 0원
- 카테고리: 패션의류 > 여성 스포츠의류 > 수영복/비치웨어 > 비치 상의/커버업
- 리뷰: 732개, 평균 4.7, 이번 응답에 3개 포함
- 이미지: 상품 9장(MAIN/SUB), 리뷰 사진 10장

옵션 상위 3개:

| 그룹 | 옵션 ID | 옵션명 | 색 |
|---|---|---|---|
| 상품선택 | 105135041 | 화이트 | #FFFFFF |
| 상품선택 | 105135042 | 그레이 | #B4B4B4 |
| 상품선택 | 105135043 | 베이지 | #E1CEA5 |

상품 이미지 상위 3장:

- 1. SUB https://cf.product-image.s.zigzag.kr/original/d/2023/1/27/793_202301271159550241_50752.jpeg
- 2. SUB https://cf.product-image.s.zigzag.kr/original/d/2023/1/27/793_202301271153150465_63402.jpeg
- 3. SUB https://cf.product-image.s.zigzag.kr/original/d/2023/1/27/793_202301271159550231_74315.jpeg

### images 119621317 --out=<새 폴더> --reviews=10

결과: 다운로드 36장, 실패 0장, 요청 38건(상세 2건 + 이미지 36건). 임시 폴더에 받은 뒤 `--out`으로 복사하고 `manifest.json`을 기록했다. 이미지 바이트는 저장소에 넣지 않았다.

| 파일 | 종류 | 표시 | 바이트 | SHA-256 앞 12자리 |
|---|---|---|---|---|
| product-01-sub.jpg | product | SUB | 841297 | 36b8daa87f64 |
| product-02-sub.jpg | product | SUB | 1286933 | 9b24ff04c27a |
| product-03-sub.jpg | product | SUB | 1025968 | 2d52a81eef71 |

실패 경로 확인(2026-10-20): `--out`이 비어 있지 않으면 `ZIGZAG_OUT_NOT_EMPTY`, `--transport=http`는 `ZIGZAG_EDGE_EMPTY_RESPONSE`, 없는 상품 ID `1`은 `ZIGZAG_GRAPHQL_ERROR`. 인기순과 추천순의 상위 3개 순서는 달랐다(`--category=hat`).

## 이미지 다운로드

`images <id> --out=<dir>`:

1. `goods`와 같은 두 호출로 상품 이미지(MAIN/SUB)와 리뷰 사진을 얻는다.
2. 시스템 임시 폴더(`os.tmpdir()/zigzag-images-*`)에 모두 받는다. 시그니처가 이미지가 아니거나 HTTP 200이 아니면 그 항목만 실패로 기록한다.
3. `--out`은 새 폴더 또는 빈 폴더여야 한다(`ZIGZAG_OUT_NOT_EMPTY`). 다 받은 뒤에만 `--out`에 복사하고 `manifest.json`을 쓴다.
   구글 드라이브 경로에 직접 쓰지 않는다. 임시 폴더는 끝나면 지운다.
4. 파일명: `product-NN-{main|sub}.{jpg|png|gif|webp}`, `review-NN.{ext}`. 매니페스트에는 원본 URL, SHA-256, 바이트 수, 리뷰 ID가 들어간다(리뷰 본문은 넣지 않음).

착용컷: 응답은 상품 이미지를 `MAIN`/`SUB`로만 표시한다. 착용컷이 따로 표시되지 않으므로 자동 분류하지 않는다.
착용 사진은 SUB이거나 리뷰 사진에 섞여 온다. 사람이 파일을 보고 고른다.

## 공유리워드 / 크리에이터 라운지 (제휴 프로그램, 2026-10-20 공개 페이지 기준)

로그인하지 않았고 계정을 만들지 않았다. 아래는 익명으로 보이는 범위다.

| 항목 | 관측 |
|---|---|
| 진입 URL | `https://zigzag.kr/affiliate` → 307 → `/influencer/affiliate/login`(공유 리워드 로그인 페이지) |
| 크리에이터 라운지 | `https://zigzag.kr/creator-lounge` → 307 → `/influencer/creator-lounge/onboarding` |
| 가입 URL | 가입(온보딩) 진입점은 `/influencer/creator-lounge/onboarding`. 가입 절차 본문은 로그인 후에만 보인다 |
| 로그인 필요 여부 | 필요. 익명 화면은 "크리에이터 라운지 / 로그인 하기"만 보인다 |
| 로그인 페이지 문구 | "공유 리워드 — 상품 링크 공유하고 리워드 받으세요. 내가 공유한 링크를 통해 구매가 발생하면 구매액의 일부를 지급해드려요." |
| 익명 API 응답 | `GetIsLoggedIn` → `{is_logged_in:false}`. `GetRewardUserAccountStatus`, `GetUserAccountTermAgreements` → `route_not_logged_in`. `GetIsFirstVisitToAffiliateCreatorLounge`, `GetCreatorLoungeAccessRequest` → `NOT_LOGIN` |
| 공유 링크 형식 | 익명에서 확인 불가. 번들에 제휴 출처 상수(`affiliate`, `share_link`)가 있으나 실제 링크 형식과 생성 호출은 찾지 못했다 |
| 공유 링크 생성 | 로그인 세션이 필요한 쓰기. 구현하지 않았다. 상품 상세 공유 버튼은 클릭하지 않았다(쓰기 가능성) |
| 리워드 조건(율, 기간, 정산) | 공개 페이지에서 수치를 찾지 못했다. 로그인 후 화면 확인이 필요하다 |
| 상품 상세 혜택 | `GetPdpMaxRewardBenefit`은 마일리지/리뷰 적립 안내이며 공유 리워드 조건이 아니다 |

결론: 공유리워드는 로그인이 필요하다. 링크 형식, 생성 방식, 리워드율은 익명 공개 페이지에서 확인하지 못했다.
로그인 후 화면을 보려면 사용자가 직접 로그인해야 하며, 그 세션을 넘겨받는 작업은 별도 승인 사항이다.

## 실패 시 대처

| 코드 | 의미 | 대처 |
|---|---|---|
| `ZIGZAG_EDGE_EMPTY_RESPONSE` | `--transport=http`에서 CloudFront 빈 200 | `--transport=cdp`로 실행 |
| `ZIGZAG_CDP_UNAVAILABLE` | `127.0.0.1:9333`에 연결 불가 | Canary 실행 상태 확인. 스크립트는 Canary를 띄우거나 끄지 않는다 |
| `ZIGZAG_BROWSER_FETCH_FAILED` | 탭 안 `fetch`가 3회 모두 `Failed to fetch` | 잠시 뒤 재실행, `--interval-ms` 늘리기 |
| `ZIGZAG_CHALLENGE` / `ZIGZAG_ACCESS_DENIED` | 챌린지 마커 또는 401/403 | 즉시 중단. 재시도하지 않는다. 차단 사유를 기록하고 공식 경로를 검토 |
| `ZIGZAG_RATE_LIMITED` | 429 | 재시도하지 않는다. 시간을 두고 다시 실행 |
| `ZIGZAG_GRAPHQL_ERROR` | 상품 없음 또는 스키마 변경 | 없는 ID인지 확인. 반복되면 아래 재관측 |
| `ZIGZAG_SCHEMA_INVALID` | 응답 JSON 구조가 바뀜 | 재관측 후 파서 수정 |
| `ZIGZAG_OUT_NOT_EMPTY` | `--out`에 파일이 이미 있음 | 새 폴더 지정 |

재관측 절차: Canary CDP `9333`에서 `PUT /json/new?<url>`로 탭 하나를 열고, 네트워크 이벤트에서 `api.zigzag.kr` 요청을 모아 본 뒤
`/json/close/<id>`로 그 탭만 닫는다. 관측에 쓴 임시 스크립트는 스크래치패드에 두고 저장소에 넣지 않는다.

## 제한

- 키워드 검색 응답에는 `total_count`가 없어 `totalCount`는 `null`이다.
- 리뷰 사진은 `goods`/`images`가 한 번에 받는 리뷰 수(`--reviews`, 최대 50)만 얻는다. 리뷰 페이지네이션은 구현하지 않았다.
- 옵션 재고(품절) 필드는 관측하지 못했다. 옵션은 이름과 색 헥스만 준다.
- 상세 본문(설명) 이미지는 관측한 응답에 없었다(`pdp_short_form_contents`는 비어 있음). 상품 이미지는 `product_image_list`와 리뷰 사진으로 한정된다.
- 카테고리 목록은 성별을 구분하지 않는다. 소싱 전 사람이 확인한다.
- 키워드 검색은 상위 목록만 본다. 카탈로그 전체 수집 기능이 아니다.
- 대량 크롤링 용도가 아니다. 검증은 소량(카테고리 8개 × 3개, 상품 1개 36장)으로만 했다.

## 실측 기록

- 2026-10-20: `categories --parent=689`, `rank --all --limit=3`, `search "리조트 원피스" --limit=3`, `goods 119621317 --reviews=3`,
  `images 119621317 --reviews=10`(36/36 성공), 실패 경로(`--out` 재사용, `--transport=http`, 없는 상품 ID, 인기순·추천순 비교) 확인.
- 원본 명령 출력은 스크래치패드의 `zigzag/final/` 폴더에 있다(저장소에 넣지 않음).
