# 일본 쇼핑 HTTP API 플레이북

2026-10-15 관측. 라쿠텐 이치바와 야후쇼핑 일본의 HTTP 계약, 실행 클라이언트, 검증 기록이다. 공개 HTML Document GET도 관측·실행 대상에 포함한다. HTML 안의 JSON은 `JSON.parse`로 읽으며 사이트 JavaScript를 실행하지 않는다.

- 요청·응답 필드: [계약 목록](japan-retail-contracts.json)
- 실행기: [japan-retail.mjs](../scripts/japan-retail.mjs), [공개 클라이언트](../lib/retail/japan-public.mjs)
- 기능 감사: [Rakuten Ichiba](../checklists/services/rakuten-ichiba.json), [Yahoo Shopping JP](../checklists/services/yahoo-shopping-jp.json)
- 실제 CLI 출력·본문 해시·재조회: [검증 manifest](../verification/japan-retail-2026-10-15/manifest.json)

## 현재 범위

| 기능 | 라쿠텐 | 야후쇼핑 일본 |
|---|---|---|
| 홈 메뉴 | 상품 장르 10개 그룹·40개 링크 | 카테고리 448개와 부모/자식 관계 |
| 카테고리 | 홈에서 발견한 장르 4개 조회, 상품·하위 링크·다음 페이지 | 추천 카테고리 Document 조회, 동일 origin의 301 경로 변경 확인 |
| 일반 검색 | `マウス`, 장르 `100026`, 3페이지·150개 행 | `/search` HTTP 500; 원인 미확인, 응답 파서 미검증 |
| 상품 상세 | shop/item 숫자 ID, URL의 shop/manage number, 설명·이미지·가격·리뷰 URL | URL·판매자·상품 ID·canonical·JSON-LD의 가격/통화 교차 확인 |
| 옵션·재고 | M220 SKU 3개, 옵션별 세금 포함 가격과 SKU 재고 | YA-MAN 가격이 다른 SKU 6개; Yogibo 27개 옵션은 재고만 확인, 옵션 가격 null 유지 |
| 리뷰 | 기존 공개 XHR 클라이언트로 M220 2페이지·60건, 본문 60건·이미지 리뷰 7건 | 상품 Document에 포함된 미리보기만; 전체 리뷰·페이지 조회 미검증 |
| 탐색 재개 | 홈 + 4개 장르 완료, 948개 URL 대기 | 홈·카테고리·일부 상품 5페이지 완료, 928개 URL 대기, 검색 5개 adapter pending |
| 공식 상품 API | 기존 등록 앱 API 클라이언트; 자격정보 실호출 대기 | V3 itemSearch 클라이언트·합성 테스트; 등록 앱 ID 실호출 대기 |
| 제휴 링크 | 사용자 Affiliate ID와 공식 API 실호출 미확인 | 사용자 ValueCommerce 가입/ID 미확인, 링크 발급 미구현 |

수치는 저장된 표본의 당시 결과다. 가격·재고·검색 순서는 변할 수 있다. 검색 행에는 광고 상품이 포함되므로 150개 행을 150개 고유 상품으로 부르지 않는다. 전체 카탈로그, 최종 검색 페이지, 결제 가격, 제휴 계정 소유권을 검증한 것은 아니다.

## 공개 HTTP 실행

Node 24+, `npm ci --ignore-scripts`. 브라우저·로그인·앱 키 없이 아래 명령을 실행한다. 출력 디렉터리는 먼저 만들고 매번 새 파일명을 사용한다. `--output`은 기존 파일을 덮어쓰지 않는다.

```powershell
New-Item -ItemType Directory -Force work | Out-Null
npm run retail:japan -- rakuten home --output=work/rakuten-home.json
npm run retail:japan -- rakuten search --query=マウス --category-id=100026 --output=work/rakuten-search-1.json
npm run retail:japan -- rakuten product --url=https://item.rakuten.co.jp/logicool/m220gr/ --output=work/rakuten-product.json
npm run retail:japan -- yahoo home --output=work/yahoo-home.json
npm run retail:japan -- yahoo page --url=https://shopping.yahoo.co.jp/category/2494/recommend --output=work/yahoo-category.json
npm run retail:japan -- yahoo product --url=https://store.shopping.yahoo.co.jp/ya-man/r2305a.html --output=work/yahoo-product.json
```

라쿠텐 검색의 후속 호출은 반환된 `data.pagination.nextUrl`을 `page --url=...`로 전달한다. `search --query=マウス --category-id=100026 --page=2`도 같은 관측 경로를 사용한다. 요청/응답의 검색어·장르·페이지와 다음 링크의 연속성을 검사한다. 출력의 `advertisedPageSize`와 실제 `returned`가 다를 수 있다.

```powershell
npm run retail:japan -- rakuten crawl --max-pages=3 --output=work/rakuten-frontier-1.json
npm run retail:japan -- rakuten crawl --max-pages=2 --input=work/rakuten-frontier-1.json --output=work/rakuten-frontier-2.json
npm run retail:japan -- yahoo crawl --max-pages=4 --output=work/yahoo-frontier-1.json
npm run retail:japan -- yahoo crawl --max-pages=1 --input=work/yahoo-frontier-1.json --output=work/yahoo-frontier-2.json
```

탐색기는 홈에서 시작해 발견된 URL을 깊이 우선순위에 따라 읽고 각 요청 뒤 체크포인트를 저장한다. 완료된 URL은 다시 읽지 않으며 형제 카테고리·상품 링크·다음 페이지를 보존한다. `max-pages`는 이번 실행에서 읽을 페이지 수다. redirect 때문에 실제 HTTP 요청 수는 더 많을 수 있다. `blocked_http`, `blocked_schema`, `adapter_pending`을 구분하고 실패 URL을 자동 반복하지 않는다. 홈 메뉴 수집 완료와 모든 하위 URL 처리 완료는 별개다. 리뷰 링크는 기존 리뷰 실행기로 넘길 대상으로 남긴다.

M220 상세에서 관측된 숫자 shop/item ID와 리뷰 URL을 기존 실행기에 전달한 예:

```powershell
node scripts/catalog.mjs rakuten-public reviews --shop-id=386625 --item-id=10000275 --id=386625:10000275 --review-url=https://review.rakuten.co.jp/item/1/386625_10000275/1.1/ --max-pages=2 --limit=60 --output=work/rakuten-reviews.json
```

리뷰 API의 공개 frontend key는 최초 페이지/bundle에서 매 실행 메모리로 얻는다. 사용자 계정 토큰은 아니다. key 값과 원문 bundle은 검증 기록에 저장하지 않는다. 이번 결과의 `nextCursor:3`, `complete:false`를 유지한다.

## 응답 해석

공개 결과는 `web-api-japan-retail-result-v1`이다. `requests`에는 GET 경로·상태·MIME·charset·본문 바이트 수·SHA-256이 있고, 정규화된 `data`는 `dataSha256`에 묶인다. 원문 HTML, `pageProps` 전체, IP·crumb·세션·리뷰 작성자 프로필은 저장하지 않는다.

라쿠텐 상품 Document의 `EUC-JP`를 실제 charset으로 해독한다. 검색의 숫자 `shop.id:item.code`와 URL slug는 다른 식별자다. 검색의 `variantId`만으로 선택 SKU 가격이 확인됐다고 표시하지 않는다. 상세 SKU 재고는 `purchaseInfo.sku.newPurchaseSku`를 사용한다. M220의 display axis와 실제 SKU 재고가 충돌했기 때문에 axis의 품절 표시를 근거로 재고를 덮어쓰지 않는다. SKU와 연결되지 않는 재고 행은 `unmappedInventoryRows`로 남긴다.

야후 대표 가격 `item.applicablePrice`와 옵션 가격 `individualItemList[].price.applicablePrice`를 구분한다. Yogibo처럼 SKU `price:null`인 상품은 재고·옵션을 반환하되 옵션 가격도 null로 둔다. `selectedVariantPriceVerified:false`가 붙는다. 배송 동의 등의 `selectOptionList`는 `customizationOptions`이며 재고 SKU로 만들지 않는다. 상품 미리보기 리뷰는 작성자 정보 없이 본문·평점·날짜만 추출한다.

## 등록 앱 API와 제휴 경계

[Yahoo 공식 itemSearch 문서](https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html)의 GET `https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch`에는 등록된 `appid`가 필요하다. 클라이언트는 검색어·카테고리·판매자·JAN, 시작 위치·페이지 크기·정렬을 지원하고 `start + results <= 1000`을 검사한다. 사용자 소유 app ID는 검증하지 못했다.

CLI는 `yahoo official-search --credentials-stdin --query=マウス --start=1 --results=20`이다. 신뢰하는 자격정보 공급자가 메모리 stdin으로 `{provider:"yahoo-shopping-jp", appId:<caller-owned value>}`를 전달해야 한다. 실제 값을 명령 인수·예제 파일·로그에 넣지 않는다. 선택 플래그는 `--category-id`, `--seller-id`, `--jan`, `--sort`다. `--sort`는 `-score`, `+price`, `-price`, `-review_count`를 지원한다. 공통 commerce collector 등록과 자동 세션 갱신은 이번 구현 범위에 없다.

[Rakuten 공식 Search 문서](https://webservice.rakuten.co.jp/documentation/ichiba-item-search)의 기존 `rakuten-ichiba` 클라이언트는 `applicationId`와 `accessKey`가 필요하다. 공개 Document 조회 성공을 공식 API 인증이나 제휴 링크 발급 성공으로 승격하지 않는다. Yahoo ValueCommerce 링크 생성과 실제 계정 가입도 아직 완료하지 않았다.

## 검증과 재현

```powershell
node --test tests/japan-retail.test.mjs tests/public-read-checklist.test.mjs
npm run retail:japan:verify
node scripts/checklist.mjs --service=rakuten-ichiba --run-tests
node scripts/checklist.mjs --service=yahoo-shopping-jp --run-tests
```

`retail:japan:verify`는 저장된 증거를 다시 확인하는 **오프라인 검사**다. 코드/파일 해시, 실제 CLI 응답, 상품 ID와 통화, 옵션별 가격 구분, 검색 페이지 연결, 재조회, 탐색 재개와 현재 체크리스트를 검증한다. 새 원격 상태를 확인하려면 위의 조회 명령을 새 출력 파일로 실행한다. 체크리스트의 `recorded_live` 역시 기록 시점의 실행 증거를 뜻한다.

현재 공개 HTTP 기능은 라쿠텐 6개, 야후 5개가 `recorded_live`다. Yahoo 공개 검색은 `blocked`, 공식 검색은 `pending_live`, 제휴 링크 발급은 `unimplemented`다. 이 미완료 항목 때문에 전체 서비스 `--strict` 통과를 주장하지 않는다.

새 일본 사이트의 CDP capture는 `paused document response` 오류로 얻지 못했다. 따라서 이번 Document 계약은 `direct_http_observed`, `captured:false`, `live_replay:true`로 기록했다. 일반 UI 방문이나 HTTP 200만으로 XHR capture 성공을 표시하지 않는다. 기존 라쿠텐 리뷰 XHR 계약과 이번 Document 계약의 출처를 분리한다.

> 2026-10-16: `parseRakutenListing` now accepts keyword-only searches. When `uiQuestion` has no `category`, the next link has no genre segment, and the parser used to compare it against `"undefined"` (`RAKUTEN_NEXT_PAGE_QUERY_MISMATCH`). `query.categoryId` is now `null` in that case. A live keyword-only search (`ヘッドホン`) returned 50 priced rows and the `?p=2` next link. Because `lib/retail/rakuten-public-catalog.mjs` changed, the 2026-10-15 receipts no longer match its hash: `retail:japan:verify` fails, and the audit shows the Rakuten public catalog capabilities as `needs_reverification` until the evidence set is recorded again.
