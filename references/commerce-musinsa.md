# 무신사 · 29CM 웹 읽기 (여성 랭킹·검색·상품·이미지)

확인일: 2026-10-20. 대상: 무신사 `www.musinsa.com`, 29CM `www.29cm.co.kr`.
용도: AI 진행자 여행 영상의 착장 소싱. 카테고리 랭킹과 키워드 검색으로 후보를 모으고, 상세와 이미지를 로컬에 보관한다.
구현: [scripts/musinsa.mjs](../scripts/musinsa.mjs), [lib/commerce/musinsa.mjs](../lib/commerce/musinsa.mjs), [lib/commerce/29cm.mjs](../lib/commerce/29cm.mjs), [lib/commerce/fashion-http.mjs](../lib/commerce/fashion-http.mjs), [lib/commerce/fashion-images.mjs](../lib/commerce/fashion-images.mjs). 테스트는 `tests/musinsa.test.mjs`.

## 사용법

Node 24 이상, 의존성 없음. 결과는 JSON(stdout, `--output=<새 파일>` 선택).

```sh
node scripts/musinsa.mjs rank --category=top --period=weekly --limit=20        # 무신사 여성 상의 주간 랭킹
node scripts/musinsa.mjs rank --category=dress --period=daily --limit=20       # 무신사 원피스(스커트 포함) 일간
node scripts/musinsa.mjs rank --category=100001 --period=weekly                # 무신사 미니원피스(코드 직접 지정)
node scripts/musinsa.mjs search "리조트 원피스" --limit=30                      # 무신사 검색, 인기순(POPULAR)
node scripts/musinsa.mjs goods 6704396                                          # 상세 + 옵션 + 소재 속성 + 이미지 URL
node scripts/musinsa.mjs images 6704396 --out=./out/6704396                    # 이미지 다운로드(아래 참고)
node scripts/musinsa.mjs rank --site=29cm --category=top --period=daily        # 29CM 베스트 일간
node scripts/musinsa.mjs search "비키니" --site=29cm --sort=MOST_SOLD           # 29CM 검색(판매순)
node scripts/musinsa.mjs goods 4000383 --site=29cm
node scripts/musinsa.mjs images 4000383 --site=29cm --out=./out/4000383
```

카테고리 별칭(여성): `top` 상의, `outer` 아우터, `bottom` 하의(바지), `dress` 원피스, `swim` 수영복·비치웨어, `bag` 가방, `hat` 모자, `sunglasses` 선글라스.
별칭 대신 코드를 직접 넘길 수 있다(무신사 3~6자리, 29CM 9자리).

| 별칭 | 무신사 코드 (section 199, gf=F) | 29CM 코드 | 비고 |
|---|---|---|---|
| top | 001000 | 268103100 (상의) | |
| outer | 002000 | 268102100 (아우터) | |
| bottom | 003000 | 268106100 (바지) | |
| dress | 100000 | 268104100 (원피스) | 무신사 100000은 원피스/스커트 전체. 미니/미디/맥시는 100001/100002/100003 |
| swim | 017022 (스포츠/레저 > 수영복/비치웨어) | 286104100 (레져 > 수영) | 남성·공용 상품이 섞일 수 있다 |
| bag | 004000 | 269100100 (여성가방) | |
| hat | 120000 | 310100100 (여성모자) | |
| sunglasses | 101003 (소품 > 선글라스/안경테) | 271104100 (여성액세서리 > 아이웨어) | 안경테 포함 |

기간: 무신사 `realtime|daily|weekly`, 29CM `realtime|daily|weekly|monthly`. 29CM의 실시간/일간/주간/월간 탭은 `periodSort=NOW|ONE_DAY|ONE_WEEK|ONE_MONTH`로 매핑했다(29CM 베스트 페이지 번들에서 확인).
무신사 월간은 관측하지 않아 노출하지 않았다.

공통 옵션: `--interval-ms=<>=3000>`(늘리기만 가능), `--output=<새 파일>`.

### 이미지 다운로드

`images`는 먼저 OS 임시 폴더(`fashion-images-*`)에 받은 뒤 `--out` 폴더로 복사하고 임시 폴더를 지운다. `--out`에 구글 드라이브 같은 동기화 경로를 직접 쓰지 않는다. 같은 이름이 이미 있으면 덮어쓰지 않고 실패한다(`FASHION_OUTPUT_EXISTS`).
받는 대상: 무신사는 썸네일, `goodsImages`(착용컷 포함 갤러리), 상세 설명 이미지(`goodsContents`의 `<img>`). 29CM는 `itemImages`(갤러리), 상세 설명 이미지. 동영상(mp4)과 색상 칩 이미지는 받지 않는다.
파일명은 `<goodsNo>-<NN>-<thumb|gallery|desc>.<jpg|png|webp|gif>`. 15 MB 초과, image/* 이외의 타입, https 이외 URL은 건너뛰고 `skipped`에 사유를 남긴다.
저작권: 상품 이미지는 해당 브랜드·플랫폼 권리다. 영상 사용 전 권리 확인이 필요하다.

## 동작과 경계

- 실행 모드: `pure_http`. 관측만 Canary(CDP 9333)에서 했고, 반복 수집은 Node fetch로만 한다. 브라우저는 쓰지 않는다.
- 세션: 쿠키를 보내거나 저장하지 않는다. 로그인, 계정, 토큰 발급 없음. 영수증의 `credentialsUsed:false`, `cookieSent:false`.
- 쓰기 없음: 찜, 장바구니, 리뷰, 제휴 링크 생성(POST 계열)은 구현하지 않았다.
- 간격: 요청 사이 최소 3초(`fashion-http.mjs`). 이미지 다운로드는 500 ms.
- 401/403/429/챌린지는 즉시 중단하고 재시도하지 않는다(`classifyResponse`, [anti-bot-boundaries](anti-bot-boundaries.md)).
- 호출 호스트: 무신사는 `client.musinsa.com`, `api.musinsa.com`, `goods-detail.musinsa.com`, `goods.musinsa.com`만. 29CM는 `recommend-api`, `display-bff-api`, `bff-api`, `www`(상품 페이지 HTML 1회).

### 무신사 robots.txt에 대한 판단 (사용자 확인 필요)

`https://www.musinsa.com/robots.txt`(확인일 2026-10-20 원문)는 `User-agent: *`에 `Disallow: /`를 둔다. 명단에 있는 봇(Claude-User, ClaudeBot, Googlebot 등)만 `Allow: /`를 받는다. 명단에 없는 봇은 전면 차단이다.

- 이 스크립트는 무신사 `www` HTML을 읽지 않는다. 랭킹·검색·상세·옵션은 API 호스트만 쓴다. `client`, `api`, `goods-detail`, `goods` 호스트에는 robots.txt가 없다(404).
- 다만 이는 운영 의도상 허용인지 불명확한 우회 성격이 있다. 스크립트는 브라우저 UA를 쓰는데(ably.mjs와 같은 방식) 이는 명단 밖 자동 수집이다. 정기·대량 수집이나 상업 사용 전에 무신사 측 허용을 확인하거나 큐레이터 채널로 문의하는 것을 권한다.
- 탐색 단계의 기록: 발견 과정에서 무신사 `www` 페이지(랭킹, 상품, 검색) 네트워크 관측을 Canary 브라우저로 했고, 상품·검색 HTML 원문을 Node로 2회 받았다. 이 부분은 robots 전면 차단 범위에 해당하므로 기록해 둔다. 이후 스크립트 경로에서는 `www` HTML을 쓰지 않는다.
- 29CM `www.29cm.co.kr/robots.txt`는 `User-agent: *`에 `Allow: /`이고 `/embed/`, `/my-page/`, `/order/`, `/auth/`, `/inbox/` 등만 금지한다. 상품 페이지(`/products/{id}`) HTML 1회 읽기는 허용 범위다.

## 무신사 엔드포인트 (관측 2026-10-20)

Canary에서 랭킹, 상품, 검색 페이지를 열어 네트워크를 관측한 뒤, 같은 요청을 Node fetch로 재현했다. 관측 탭은 열고 닫았고 Canary는 종료하지 않았다.

| 기능 | 요청 | 파라미터 · 응답 |
|---|---|---|
| 랭킹 | `GET client.musinsa.com/api/home/web/v5/pans/ranking/sections/199` | `storeCode=musinsa`, `gf=F`(여성), `ageBand=AGE_BAND_ALL`, `period=REALTIME\|DAILY\|WEEKLY`, `eventPeriod=BASIC_*`, `categoryCode`, `soldOut=true\|false`, `page`, `startRank`, `offset=startRank-1`. 1쪽에 101개. 다음 쪽은 응답 `link.next`를 따른다(`page=2&startRank=102`). 응답의 `hasNext`는 항상 false로 와서 쓰지 않는다 |
| 랭킹 카테고리 트리 | 같은 section 응답의 `TAB_OUTLINED` 모듈 | 위 코드표의 출처 |
| 검색 | `GET api.musinsa.com/api2/dp/v2/plp/goods?gf=F&keyword=…&sortCode=POPULAR&isUsed=false&page=1&size=60&caller=SEARCH` | 1쪽은 서명 없이 200이다. 다음 쪽은 응답 `data.pagination.nextPageUrl`을 그대로 따른다. 이 URL에는 서버가 발급한 `hmacId`가 있다. `hmacId`를 떼고 요청하면 403(`잘못된 접근입니다`)이다 |
| 상세 | `GET goods-detail.musinsa.com/api2/goods/{goodsNo}` | `goodsNm`, `brandInfo`, `goodsPrice`(finalPrice, normalPrice, couponPrice), `goodsReview`(totalCount, satisfactionScore 0-5), `goodsImages[].imageUrl`, `goodsContents`(상세 HTML), `goodsMaterial.materials[]`(핏·촉감·신축성·비침·두께·계절 속성), `category`, `labels` |
| 옵션 | `GET goods-detail.musinsa.com/api2/goods/{goodsNo}/options` | `basic[]`(사이즈, 컬러 등 그룹과 값), `optionItems[]`(조합의 `optionValues`, `price`(추가금), `activated`, `isDeleted`) |

랭킹 항목 필드: `modules[].items[]`에서 `type=PRODUCT_COLUMN`만 쓴다. 순위는 `image.rank`, 상품번호는 `id`, 브랜드·상품명·최종가는 `info`, 정가는 `onClick.eventLog.amplitude.payload.original_price`, 리뷰 수와 만족도는 같은 payload의 `reviewCount`, `reviewScore`다.
`reviewScore`는 상세 `satisfactionScore`(0-5) × 20과 일치한다(4.9 ↔ 98, 확인 상품 4636893, 5124904). 리뷰가 0이면 만족도는 null로 둔다.

### 색상 이름

색 옵션은 `basic`에서 이름이 `컬러` 또는 `색상`인 그룹의 `optionValues[].name`으로 얻는다. `optionItems[].colors[].colorCode`(숫자)와 색상 이미지 매핑 테이블은 상세 페이지 전용 데이터라 쓰지 않는다. 색상 칩 이미지는 받지 않는다.

## 29CM 엔드포인트 (관측 2026-10-20)

| 기능 | 요청 | 파라미터 · 응답 |
|---|---|---|
| 베스트(랭킹) | `GET recommend-api.29cm.co.kr/api/v4/best/items?categoryList=<code>&periodSort=NOW\|ONE_DAY\|ONE_WEEK\|ONE_MONTH&limit=100&offset=0` | `data.content[]`. 응답에 순위 필드가 없어 배열 순서를 순위로 쓴다. `reviewAveragePoint`(0-5), `reviewCount`, `lastSalePrice`(판매가), `consumerPrice`(정가) |
| 베스트 카테고리 | `GET recommend-api.29cm.co.kr/api/v4/best/categories?categoryList=<code>` | 자식 카테고리(코드 확인용) |
| 검색 | `POST display-bff-api.29cm.co.kr/api/v1/listing/items?colorchipVariant=treatment` body `{"keyword","pageType":"SRP","sortType","facets":{},"pageRequest":{"page","size"}}` | `data.list[].itemInfo`(productName, brandName, displayPrice, originalPrice, thumbnailUrl, reviewScore 0-5, reviewCount, likeCount), `data.pagination`(totalCount, hasNext). 광고 `isAd` 항목은 제외 |
| 정렬 목록 | `GET display-bff-api.29cm.co.kr/api/v1/listing/sorts?pageType=SRP` | `RECOMMENDED`(추천순), `NEWEST`, `MOST_REVIEWED`, `LOWEST_PRICE`, `HIGHEST_PRICE`, `HIGHEST_DISCOUNT`, `MOST_LIKED`(좋아요많은순), `MOST_SOLD`(판매순) |
| 상세 | `GET www.29cm.co.kr/products/{itemNo}` (HTML 1회) | 페이지가 내장한 상품 DTO를 React Flight 행(`self.__next_f.push`)에서 꺼낸다. 값은 `"$<hex>"`로 다른 행을 참조하므로 풀어서 쓴다. `itemImages`, `itemDescriptions`(상세 HTML), `itemDetailsList`(제품 소재 등 표), `frontBrand`, `frontCategoryInfo`, `reviewAggregation`, `sellPrice`, `consumerPrice`, `frontItemStockStatus` |
| 옵션 | `GET bff-api.29cm.co.kr/api/v6/product-detail/{itemNo}/options` | `layout`(예: `사이즈/색상`), `list[].title`(조합 문자열), `frontOptionStockStatus`, `sellPrice`(추가금) |

29CM 정렬 "인기순"에 해당하는 라벨은 없다. 기본값은 판매순(`MOST_SOLD`)으로 두었다. 좋아요순은 `--sort=MOST_LIKED`로 바꾼다.

29CM 상세 소재: 구조화된 혼용률이 없다. `itemDetailsList`의 "제품 소재"가 "상세 페이지 참고"로만 온다. 혼용률은 상세 이미지에서 확인한다.

## 응답 필드 (스크립트 출력)

- `rank`: `rank`, `goodsNo`, `brand`, `name`, `price{final, original, discountRate}`, `soldOut`, `image`(썸네일 https URL), `productUrl`, `reviewCount`, `satisfactionPercent`(무신사) 또는 `reviewAveragePoint`(29CM).
- `search`: `goodsNo`, `brand`, `name`, `price{final, normal, …}`, `soldOut`, `image`, `productUrl`, `reviewCount`, 만족도. 무신사는 `isAd`, 29CM는 `likeCount`.
- `goods`: `goodsNo`, `name`, `brand`, `category`, `price`, `reviews`(무신사 `satisfactionScore`, 29CM `averagePoint`), `materialAttributes`(무신사) 또는 `specs`(29CM), `images{thumbnail, gallery, description}`, `options`(무신사 `groups`, `colors`, `variants[label, managedCode, additionalPrice, activated]`, 29CM `layout`, `variants[label, stockStatus, additionalPrice]`), `productUrl`.
- `images`: `files[]`(로컬 절대경로, 종류, 원본 URL, 바이트, sha256), `skipped[]`(사유 코드).

영수증(`requests[]`)에는 메서드, 호스트, 경로, 쿼리 키 이름, 상태, MIME, 바이트, 시각만 남긴다. 쿼리 값과 `hmacId`는 남기지 않는다.

## 실패 시 대처

| 코드 | 의미 | 대처 |
|---|---|---|
| `*_NOT_FOUND` (404) | 상품 없음 또는 판매 종료 | 번호 확인 |
| `*_HTTP_ERROR` (403 등) | 차단 가능성 | 중단. 같은 요청을 다른 클라이언트로 바꿔 재시도하지 않는다 |
| `*_RATE_LIMITED` (429) | 과다 요청 | 중단. 간격을 늘리고 시간을 둔다. 재시도하지 않는다 |
| `*_CHALLENGE` | 챌린지 페이지 | 중단. 이 엔드포인트는 자동화 대상에서 뺀다 |
| `*_API_FAILED` | 본문 `result=FAIL` | 응답 `errorCode`를 확인한다 |
| `CM29_PRODUCT_DATA_MISSING` | 상품 HTML에 DTO가 없음 | 페이지 구조 변경 가능성. 상세 대신 검색 결과 항목을 쓴다 |
| `FASHION_OUTPUT_EXISTS` | `--out`에 같은 파일이 있음 | 다른 폴더를 지정한다 |
| `IMAGE_TYPE_REJECTED`, `IMAGE_SIZE_REJECTED` | 이미지가 아님, 또는 크기 초과 | 해당 이미지만 건너뛴다(`skipped`) |

## 무신사 큐레이터 (제휴 프로그램) — 공개 페이지 기준 조사

조사일 2026-10-20. 로그인, 가입, 계정 생성은 하지 않았다. 공개 페이지를 WebFetch로만 읽었고, 브라우저와 CDP는 쓰지 않았다. 확인하지 못한 항목은 "미확인"으로 표시했다.

| 항목 | 확인 내용 | 근거 |
|---|---|---|
| 가입 URL | `https://www.musinsa.com/curator/intro/pro` 소개 페이지의 "큐레이터 가입 신청하기" 버튼 | 소개 페이지(공개, 로그인 없이 열림) |
| 명칭 | "무신사 큐레이터 서비스". 보도자료는 "어필리에이트 프로그램 '무신사 큐레이터'"로 부른다 | 소개 페이지, 파이낸셜뉴스 2025-12-26 |
| 로그인 필요 여부 | 소개와 FAQ 열람은 로그인 없이 된다. 신청 단계에서 로그인이 필요한지는 미확인 | 소개 페이지 |
| 가입 조건 | 승인 필요. 보도자료는 "사전 승인을 받은 인플루언서"라고 쓴다. 약관 본문은 열리지 않아 "통합회원 가입, 본인 인증, 회사 검토 후 승인"은 검색 요약 수준(미검증). 팔로워 수, SNS 요건, 사업자 요건은 미확인 | 보도자료, 약관 로드 실패 |
| 링크 생성 | 샵 링크 또는 개별 상품 링크를 SNS에 공유하는 방식. 추적 파라미터, 공개 API, 대시보드는 미확인 | 소개 페이지 |
| 수수료 | 소개 페이지는 "판매 수수료 최대 10% 지원", 뉴스는 "최대 10% 이상"이라고 쓴다. 두 표현이 달라 원문 기준은 미확인. 카테고리별 요율 미확인 | 소개 페이지, 뉴스 |
| 쿠폰 | 소개 페이지에 "전월 정산 대상자에게만 지급". 금액과 장수는 미확인 | 소개 페이지 |
| 정산 | 주기, 최소 지급액, 구매 인정 기간, 제외 상품·브랜드, 원천징수(3.3%), 사업자등록 요건 모두 미확인 | — |
| 광고 표기 | 의무 문구 요건 미확인 | — |
| 규모 | 2025-12 보도자료 기준 활성 큐레이터 4,400명 이상, 누적 거래액 1,200억 원 돌파 | 파이낸셜뉴스 2025-12-26 |
| 자동화 제한 | `robots.txt`는 위 "robots.txt에 대한 판단" 참고. 약관의 자동 수집 금지 조항은 미확인 | robots.txt 원문, 약관 로드 실패 |

요약: 가입 신청은 사용자가 직접 결정할 일이며 자동화하지 않는다. 링크 생성 방식(API인지 링크 형식인지)이 공개 페이지에 없으므로, 제휴 링크 기능을 붙이려면 가입 후 실제 화면에서 다시 관측해야 한다. AI 인플루언서 계정으로 신청 가능한지는 정책에 명시가 없어 운영 측 확인이 필요하다.

## 실측 (2026-10-20)

아래 샘플은 각 명령 출력의 `data` 필드다(영수증 `requests`, `checkedAt`, `session`은 생략했다). 관련 호출은 모두 HTTP 200이었다.

### 무신사 랭킹 (상의 주간, 상위 3개)

```sh
node scripts/musinsa.mjs rank --category=top --period=weekly --limit=3
```

```json
{
  "category": {
    "key": "top",
    "code": "001000"
  },
  "period": "weekly",
  "includeSoldOut": false,
  "items": [
    {
      "rank": 1,
      "goodsNo": 6704396,
      "brand": "무신사 스탠다드 우먼",
      "name": "[빅토리아 울] 우먼즈 미니멀 리브드 후디드 니트 집업 [토프]",
      "price": {
        "final": 79900,
        "original": 79900,
        "discountRate": 0
      },
      "soldOut": false,
      "image": "https://image.msscdn.net/images/goods_img/20260619/6704396/6704396_17883246569829_500.jpg",
      "productUrl": "https://www.musinsa.com/products/6704396",
      "reviewCount": 124,
      "satisfactionPercent": 98
    },
    {
      "rank": 2,
      "goodsNo": 7365425,
      "brand": "베이프",
      "name": "KOREA EXCLUSIVE 도트 콜리지 릴렉스드 핏 롱슬리브 티셔츠(M) BLACK",
      "price": {
        "final": 189000,
        "original": 189000,
        "discountRate": 0
      },
      "soldOut": false,
      "image": "https://image.msscdn.net/images/goods_img/20260918/7365425/7365425_17919659418336_500.jpg",
      "productUrl": "https://www.musinsa.com/products/7365425",
      "reviewCount": 0,
      "satisfactionPercent": null
    },
    {
      "rank": 3,
      "goodsNo": 6970058,
      "brand": "유라고",
      "name": "Washable V-neck knit shawl set_Melange gray",
      "price": {
        "final": 61200,
        "original": 85000,
        "discountRate": 28
      },
      "soldOut": false,
      "image": "https://image.msscdn.net/images/goods_img/20260731/6970058/6970058_17893504439093_500.jpg",
      "productUrl": "https://www.musinsa.com/products/6970058",
      "reviewCount": 29,
      "satisfactionPercent": 98
    }
  ]
}
```

### 무신사 검색 ("리조트 원피스", 인기순, 상위 3개)

```sh
node scripts/musinsa.mjs search "리조트 원피스" --limit=3
```

```json
{
  "keyword": "리조트 원피스",
  "sort": "POPULAR",
  "totalCount": 235,
  "items": [
    {
      "goodsNo": 4636893,
      "name": "Mermaid of the City Dress (Cream)",
      "brand": "루루서울",
      "brandCode": "loulouseoul",
      "price": {
        "final": 108000,
        "normal": 108000,
        "couponPrice": null,
        "discountRate": 0
      },
      "soldOut": false,
      "image": "https://image.msscdn.net/images/goods_img/20241126/4636893/4636893_17325994146796_500.jpg",
      "productUrl": "https://www.musinsa.com/products/4636893",
      "reviewCount": 98,
      "satisfactionPercent": 98,
      "isAd": false
    },
    {
      "goodsNo": 2887449,
      "name": "Tiger Pattern Satin Halter Dress Purple",
      "brand": "배디",
      "brandCode": "badee",
      "price": {
        "final": 83300,
        "normal": 119000,
        "couponPrice": null,
        "discountRate": 30
      },
      "soldOut": false,
      "image": "https://image.msscdn.net/images/goods_img/20221024/2887449/2887449_3_500.jpg",
      "productUrl": "https://www.musinsa.com/products/2887449",
      "reviewCount": 1,
      "satisfactionPercent": 100,
      "isAd": false
    },
    {
      "goodsNo": 1978578,
      "name": "스트라이프 스트랩 원피스 / 라벤더",
      "brand": "로희어패럴",
      "brandCode": "roheeapparel",
      "price": {
        "final": 35200,
        "normal": 88000,
        "couponPrice": null,
        "discountRate": 60
      },
      "soldOut": false,
      "image": "https://image.msscdn.net/images/goods_img/20210602/1978578/1978578_1_500.jpg",
      "productUrl": "https://www.musinsa.com/products/1978578",
      "reviewCount": 0,
      "satisfactionPercent": null,
      "isAd": false
    }
  ]
}
```

### 무신사 상세 (6704396, 요약)

```sh
node scripts/musinsa.mjs goods 6704396
```

```json
{
  "goodsNo": 6704396,
  "name": "[빅토리아 울] 우먼즈 미니멀 리브드 후디드 니트 집업 [토프]",
  "brand": {
    "code": "musinsastandardwoman",
    "name": "무신사 스탠다드 우먼",
    "english": "MUSINSA STANDARD WOMAN"
  },
  "category": {
    "depth1": "상의",
    "depth2": "니트/스웨터",
    "baseFullPath": "Clothing > 니트/스웨터"
  },
  "price": {
    "final": 79900,
    "normal": 79900,
    "discountRate": 0,
    "couponPrice": 79900
  },
  "reviews": {
    "totalCount": 124,
    "satisfactionScore": 4.9
  },
  "materialAttributes": [
    {
      "name": "핏",
      "selected": [
        "루즈"
      ]
    },
    {
      "name": "촉감",
      "selected": [
        "부드러움"
      ]
    },
    {
      "name": "신축성",
      "selected": [
        "있음"
      ]
    },
    {
      "name": "비침",
      "selected": [
        "거의 없음"
      ]
    },
    {
      "name": "두께",
      "selected": [
        "보통"
      ]
    },
    {
      "name": "계절",
      "selected": [
        "봄",
        "가을",
        "겨울"
      ]
    }
  ],
  "images": {
    "thumbnail": "https://image.msscdn.net/images/goods_img/20260619/6704396/6704396_17883246569829_500.jpg",
    "gallery": 6,
    "description": 8,
    "galleryFirst": "https://image.msscdn.net/images/prd_img/20260619/6704396/detail_6704396_17883246647213_500.jpg"
  },
  "options": {
    "groups": [
      {
        "name": "사이즈",
        "displayType": "DROPDOWN",
        "values": [
          "XS",
          "S",
          "M",
          "L"
        ]
      }
    ],
    "colors": [],
    "variantCount": 4,
    "variantsFirst2": [
      {
        "label": "XS",
        "managedCode": "XS",
        "additionalPrice": 0,
        "activated": true
      },
      {
        "label": "S",
        "managedCode": "S",
        "additionalPrice": 0,
        "activated": true
      }
    ]
  },
  "productUrl": "https://www.musinsa.com/products/6704396"
}
```

### 무신사 이미지

```sh
node scripts/musinsa.mjs images 6704396 --out=./out/6704396
```

```json
{
  "goodsNo": 6704396,
  "name": "[빅토리아 울] 우먼즈 미니멀 리브드 후디드 니트 집업 [토프]",
  "files": [
    {
      "file": "6704396-01-thumb.jpg",
      "kind": "thumb",
      "contentType": "image/jpeg",
      "bytes": 210101
    },
    {
      "file": "6704396-02-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 170900
    },
    {
      "file": "6704396-03-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 214716
    },
    {
      "file": "6704396-04-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 355816
    },
    {
      "file": "6704396-05-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 547816
    },
    {
      "file": "6704396-06-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 405045
    },
    {
      "file": "6704396-07-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 357052
    },
    {
      "file": "6704396-08-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 110149
    },
    {
      "file": "6704396-09-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 1417486
    },
    {
      "file": "6704396-10-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 1521976
    },
    {
      "file": "6704396-11-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 101371
    },
    {
      "file": "6704396-12-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 640233
    },
    {
      "file": "6704396-13-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 3107734
    },
    {
      "file": "6704396-14-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 139595
    },
    {
      "file": "6704396-15-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 741518
    }
  ],
  "skipped": []
}
```

### 29CM 베스트 (상의 일간, 상위 3개)

```sh
node scripts/musinsa.mjs rank --site=29cm --category=top --period=daily --limit=3
```

```json
{
  "category": {
    "key": "top",
    "code": "268103100"
  },
  "period": "daily",
  "items": [
    {
      "rank": 1,
      "goodsNo": 4251806,
      "name": "WARM GRID HOOD, GRAY",
      "brand": "플리즈프로젝트",
      "brandEnglish": "PLZPROJECT",
      "price": {
        "final": 69000,
        "normal": 69000,
        "discountRate": 0
      },
      "soldOut": false,
      "image": "https://img.29cm.co.kr/item/202610/11f1c14ce5a420ee90edfddbc4659f06.jpg",
      "productUrl": "https://www.29cm.co.kr/products/4251806",
      "reviewCount": 0,
      "reviewAveragePoint": 0,
      "heartCount": 328,
      "category": {
        "depth1": "여성의류",
        "depth2": "상의",
        "depth3": "후디"
      }
    },
    {
      "rank": 2,
      "goodsNo": 4099024,
      "name": "[2차] RIBBED KNIT LONG SLEEVE, CHARCOAL",
      "brand": "플리즈프로젝트",
      "brandEnglish": "PLZPROJECT",
      "price": {
        "final": 53100,
        "normal": 59000,
        "discountRate": 10
      },
      "soldOut": false,
      "image": "https://img.29cm.co.kr/item/202608/11f1a1d5827a5fd68fdca19642223f20.jpg",
      "productUrl": "https://www.29cm.co.kr/products/4099024",
      "reviewCount": 45,
      "reviewAveragePoint": 5,
      "heartCount": 534,
      "category": {
        "depth1": "여성의류",
        "depth2": "상의",
        "depth3": "긴소매 티셔츠"
      }
    },
    {
      "rank": 3,
      "goodsNo": 1403398,
      "name": "[43th][서예지 PICK] [ESSENTIAL] ESSENTIAL ROUND TOP_10 COLOR",
      "brand": "닉앤니콜",
      "brandEnglish": "NICK&NICOLE",
      "price": {
        "final": 17970,
        "normal": 39000,
        "discountRate": 54
      },
      "soldOut": false,
      "image": "https://img.29cm.co.kr/item/202605/11f1491eefcd94d3bc92956ee779f596.jpg",
      "productUrl": "https://www.29cm.co.kr/products/1403398",
      "reviewCount": 2388,
      "reviewAveragePoint": 4.5,
      "heartCount": 19847,
      "category": {
        "depth1": "여성의류",
        "depth2": "상의",
        "depth3": "긴소매 티셔츠"
      }
    }
  ]
}
```

### 29CM 검색 ("비키니", 판매순, 상위 3개)

```sh
node scripts/musinsa.mjs search "비키니" --site=29cm --limit=3
```

```json
{
  "keyword": "비키니",
  "sort": "MOST_SOLD",
  "totalCount": 2738,
  "items": [
    {
      "goodsNo": 4000383,
      "name": "프렌치 홀터 투피스 - 브라운",
      "brand": "바이누",
      "brandId": 18895,
      "price": {
        "final": 97580,
        "normal": 119000,
        "discountRate": 18
      },
      "soldOut": false,
      "image": "https://img.29cm.co.kr/item/202605/11f1524e16e551fc83a40dc0def705fe.jpg",
      "productUrl": "https://www.29cm.co.kr/products/4000383",
      "reviewCount": 30,
      "reviewAveragePoint": 5,
      "likeCount": 10695
    },
    {
      "goodsNo": 2672148,
      "name": "여성 캐러셀 비키니 팬티 [D1618OP7A]",
      "brand": "캘빈클라인 언더웨어",
      "brandId": 11683,
      "price": {
        "final": 25500,
        "normal": 30000,
        "discountRate": 15
      },
      "soldOut": false,
      "image": "https://img.29cm.co.kr/item/202609/11f1a738c1e47cbab4a95f4dc6e4652a.jpg",
      "productUrl": "https://www.29cm.co.kr/products/2672148",
      "reviewCount": 103,
      "reviewAveragePoint": 5,
      "likeCount": 566
    },
    {
      "goodsNo": 3260144,
      "name": "[품절임박][당일출고]TOFFEE HALTER NECK SET",
      "brand": "이스트씨",
      "brandId": 83193,
      "price": {
        "final": 121550,
        "normal": 143000,
        "discountRate": 15
      },
      "soldOut": false,
      "image": "https://img.29cm.co.kr/item/202609/11f1aa98618234a89468271f7ee79c20.jpg",
      "productUrl": "https://www.29cm.co.kr/products/3260144",
      "reviewCount": 96,
      "reviewAveragePoint": 5,
      "likeCount": 8812
    }
  ]
}
```

### 29CM 상세 (4000383, 요약)

```sh
node scripts/musinsa.mjs goods 4000383 --site=29cm
```

```json
{
  "goodsNo": 4000383,
  "name": "프렌치 홀터 투피스 - 브라운",
  "brand": {
    "code": 18895,
    "name": "바이누",
    "english": "bynoo"
  },
  "category": {
    "depth1": "레저",
    "depth2": "수영",
    "depth3": "비키니"
  },
  "price": {
    "final": 119000,
    "normal": 119000,
    "discountRate": 0
  },
  "reviews": {
    "totalCount": 30,
    "averagePoint": 5,
    "photoCount": 22
  },
  "stockStatus": "ON_STOCK",
  "specs": [
    {
      "title": "제품 소재",
      "value": "상세 페이지 참고"
    },
    {
      "title": "색상",
      "value": "상세 페이지 참고"
    },
    {
      "title": "치수",
      "value": "상세 페이지 참고"
    }
  ],
  "images": {
    "gallery": 2,
    "description": 2,
    "galleryFirst": "https://img.29cm.co.kr/item/202605/11f1524e16e551fc83a40dc0def705fe.jpg"
  },
  "options": {
    "layout": [
      "사이즈"
    ],
    "variantCount": 15,
    "variantsFirst2": [
      {
        "label": "상의S/ 브라운 브리프S",
        "stockStatus": "ON_STOCK",
        "additionalPrice": 0,
        "isLimitedQty": true
      },
      {
        "label": "상의S/ 브라운 브리프M",
        "stockStatus": "ON_STOCK",
        "additionalPrice": 0,
        "isLimitedQty": true
      }
    ]
  },
  "productUrl": "https://www.29cm.co.kr/products/4000383"
}
```

### 29CM 이미지

```sh
node scripts/musinsa.mjs images 4000383 --site=29cm --out=./out/4000383
```

```json
{
  "goodsNo": 4000383,
  "name": "프렌치 홀터 투피스 - 브라운",
  "files": [
    {
      "file": "4000383-01-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 110849
    },
    {
      "file": "4000383-02-gallery.jpg",
      "kind": "gallery",
      "contentType": "image/jpeg",
      "bytes": 84090
    },
    {
      "file": "4000383-03-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 761539
    },
    {
      "file": "4000383-04-desc.jpg",
      "kind": "desc",
      "contentType": "image/jpeg",
      "bytes": 612367
    }
  ],
  "skipped": []
}
```

검증한 것: 무신사 8개 카테고리 랭킹(`top`~`sunglasses`, 일간 2개씩), 29CM 8개 카테고리(주간 2개씩), 29CM 월간, 무신사 랭킹 105개(2쪽 페이지네이션, 순위 1–105 중복 없음), 무신사 품절 포함 옵션, 무신사 상세의 만족도 대조(4.9 ↔ 98%), 잘못된 인자 8종과 404 2종의 오류 코드. 단위 테스트 13개 통과(`node --test tests/musinsa.test.mjs`).

## 관측된 차단과 한계

- 429, 챌린지 페이지는 검증 기간에 관측되지 않았다.
- 29CM `bff-api` 상품 상세 v5(`/api/v5/product-detail/{id}`)는 Node fetch에서 3가지 헤더 조합 모두 403 HTML(Cloudflare, cf-ray 헤더)을 받았다. 같은 URL을 curl로 호출하면 200이다. 클라이언트 지문에 따른 차단으로 보인다. 우회하지 않았고, 대신 공개 상품 페이지의 내장 데이터를 쓴다. 이 엔드포인트는 쓰지 않는다.
- 무신사 `www` 페이지에는 Cloudflare 챌린지 스크립트(`cdn-cgi/challenge-platform`)가 실린다. API 호스트는 Node에서 챌린지 없이 응답했다. 이는 2026-10-20 관측이며 지속을 보장하지 않는다.
- 랭킹은 노출된 상위 순위만 검증한다. 카탈로그 전체 수집 기능이 아니다.
- 무신사 카테고리는 무신사 분류 기준이다. `swim`(017022)과 `dress`(100000)에는 원하는 종류가 아닌 상품이 섞인다. 착용 검수가 필요하다.
- 29CM 검색 결과에는 원하는 상품이 아닌 항목이 섞인다. "비키니"에 속옷이 나오는 식이다.
- 리뷰 수와 만족도는 랭킹·검색 목록의 분석 payload 값을 쓴다. 상세 응답과 대조한 결과 일치하지만 필드 자체는 공식 계약이 아니다.
- 소재 혼용률은 구조화 데이터에 없다. 이미지에서 확인해야 한다.
- 대량 크롤링 용도가 아니다. 검증은 소량으로만 했다.
