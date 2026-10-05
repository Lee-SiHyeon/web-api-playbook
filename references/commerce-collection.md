# 해외 제휴·드랍쉬핑 상품과 가격 수집

Olive Young·Shopee·Sephora·Ulta·Rakuten의 추가 어댑터, 세션/키 입력과 공식 수수료 확인은 [프로그램별 연결 안내](affiliate-program-adapters.md)를 따른다.

상품 검색·상세·옵션별 가격을 브라우저 없이 HTTP로 읽고, 가격 스냅샷을 JSON·CSV로 저장한다. 제휴사 가입·상품 광고 권한과 공개 상품 조회는 별도 조건이다. 이 도구는 가입, 캠페인 신청, 주문, 결제, 장바구니 수정이나 제휴 링크 발급을 실행하지 않는다.

| 수집기 | 연결한 조회 기능 | 현재 실증 |
|---|---|---|
| `printful-feed` | 공식 지역별 ZIP/CSV 상품·옵션·가격, 키워드/옵션 ID 필터 | 비로그인 피드 8지역 22,635옵션 파싱, 미국 11,279옵션 가격 수집 |
| `shopify-storefronts` | Allbirds·ColourPop 상품/옵션 가격과 예측 검색 | 두 스토어의 익명 HTTP 조회 실증 |
| `aliexpress-partner` | 서명한 Affiliate 상품 검색·상세, 가격·목표 통화·페이지 조회 | 앱 자격 정보가 없어 실계정 미확인 |
| `aliexpress-social` | 서명한 소셜 상품 검색, USD 가격 범위 | 앱 자격 정보가 없어 실계정 미확인 |
| `amazon-partner` | Creators API 상품 검색·ASIN 상세·OffersV2 가격 | 승인된 Associates 계정 자격 정보·PartnerTag가 없어 미확인 |
| `ebay-partner` | Browse 고정가 검색·상세·페이지, 배송비 분리 | 앱 자격 정보와 프로덕션 권한이 없어 미확인 |
| `cjdropshipping` | 상품 검색·옵션 상세·USD 카탈로그 가격, 실제/가상 재고 구분 | API 토큰이 없어 미확인 |
| `banggood` | 제휴 상품 검색·상세·창고 가격·시장 참고가격 | 제휴 API 키가 없어 미확인; 세일 시간대 불명 |
| `impact` | Partner Catalogs 상품 검색·상세·페이지·소비자 판매가 | SID/AuthToken이 없어 미확인 |
| `awin` | Enhanced JSONL 피드의 로컬 검색·상품 ID·가격 매핑 | 토큰과 실제 행 구조 미확인; 공식 문서의 서로 다른 행 형식을 임의로 합치지 않음 |
| `printful-api` | 공식 v2 옵션/기법별 생산 기본가·통화·지역·페이지 | OAuth 토큰이 없어 미확인 |

Printful 공개 피드는 **공식 데이터 파일을 HTTP로 받는 경로**다. 사이트 XHR 또는 JSON API를 캡처한 것으로 표시하지 않는다. 인증된 Printful v2 REST API도 별도 구현했으며 실행 자격이 필요하다. 다른 주요 서비스 20개에 대한 가입·API/피드·가격/재고·권한 경계는 [공식 출처 조사표](commerce-provider-matrix.json)에 기록했다. Printify 카탈로그에는 확인된 생산 원가 필드가 없으며, 판매자 전용 API를 공개 쇼핑몰 검색으로 전용하지 않는다.

## 바로 수집

Node 24 이상에서 저장소 루트 명령을 사용한다. 출력은 새 파일만 만들고 기존 결과를 덮어쓰지 않는다.

```bash
npm run commerce -- providers
npm run commerce -- printful-feed collect --region=USA --limit=50000 --output=work/printful-usa.json --csv=work/printful-usa.csv
npm run commerce -- printful-feed collect --region=all --limit=50000 --output=work/printful-all.json --csv=work/printful-all.csv
npm run commerce -- printful-feed search --region=USA --query=shirt --limit=100 --output=work/shirts.json --csv=work/shirts.csv
npm run commerce -- shopify-storefronts search --store=colourpop --query=eeveelution --limit=5 --output=work/colourpop.json --csv=work/colourpop.csv
npm run commerce -- shopify-storefronts product --store=allbirds --id=mens-runner-nz-slip-on-mushroom
```

출력 디렉터리는 먼저 만든다. `--limit`는 저장할 가격 레코드 수이며 최대 50,000개, 기본 100개다. `--max-pages`는 최대 100페이지, 기본 3페이지다. `--page-size`는 해당 원격 API의 페이지 너비이며 마지막 저장 여유가 줄어도 그대로 유지해 페이지 커서가 달라지지 않게 한다. 많은 결과는 `--output`이 필요하고, CSV에는 통화·가격 종류·마켓·지역·창고·기법·광고주/카탈로그 ID를 함께 기록한다.

```bash
npm run commerce -- printful-feed collect --region=USA --limit=50000 --baseline=work/printful-usa.json --output=work/printful-usa-next.json --csv=work/printful-usa-next.csv
npm run commerce -- run job --input=examples/commerce-public-feed-job.json --output=work/job-result.json --csv=work/job-result.csv
```

이전 스냅샷 비교는 같은 공급원·상품·옵션·지역·마켓·목적 국가·통화·가격 종류·로케일·생산 통화끼리 수행한다. 금액은 십진 문자열과 정수 연산으로 비교하며 환율 변환을 하지 않는다. 이번 결과에서 빠진 상품은 품절로 단정하지 않는다. CSV 문자열은 수식 실행을 막도록 이스케이프하며 원문은 JSON에 보존한다.

## 자격 정보가 필요한 조회

자격 정보는 명령줄/작업 JSON/결과 파일에 넣지 않고 `--credentials-stdin`으로 전달한다. 기존 보호 저장 공급자가 있으면 해당 공급자가 아래 형식의 JSON을 프로세스 표준 입력에 공급하도록 연결한다. 공급자가 없으면 현재 작업의 메모리 입력 경로를 사용한다. 토큰을 파일에 저장하거나 환경변수에서 자동 탐색하지 않는다.

```bash
npm run commerce -- aliexpress-partner search --query="usb charger" --country=US --currency=USD --credentials-stdin --output=work/aliexpress.json
npm run commerce -- ebay-partner search --query="usb charger" --marketplace=EBAY_US --credentials-stdin --output=work/ebay.json
npm run commerce -- amazon-partner search --query="usb charger" --marketplace=www.amazon.com --credentials-stdin --output=work/amazon.json
npm run commerce -- cjdropshipping product --id=OBSERVED_PRODUCT_ID --credentials-stdin --output=work/cj.json
```

표준 입력의 공통 필드는 `provider`이며 실행하는 수집기 이름과 일치해야 한다. 서비스별 나머지 필드는 다음과 같다.

| 수집기 | 메모리 입력 필드 |
|---|---|
| AliExpress Affiliate/Social | `appKey`, `appSecret`; Affiliate의 기존 `trackingId`, `appSignature`는 선택 |
| Amazon | `credentialId`, `credentialSecret`, `credentialVersion`, `partnerTag` |
| eBay | `accessToken` 또는 `clientId`·`clientSecret`; 기존 EPN campaign/reference ID는 선택 |
| CJdropshipping·Printful API | `accessToken` |
| Banggood | `apiKey`, `apiSecret` |
| Impact | `accountSid`, `authToken` |
| Awin | `publisherId`, `accessToken`; 조회 인자로 `advertiserId`, `locale` 필요 |

예를 들어 eBay의 메모리 공급자 출력은 `{ "provider":"ebay-partner", "accessToken":"<protected token>" }`이다. 예시는 인증된 실행 증거가 아니다. 잘못된 서비스의 자격 정보, 알 수 없는 필드, 리다이렉트, HTML 로그인/차단 화면 또는 플랫폼 오류를 성공으로 처리하지 않는다. 지원하는 가입 지역·프로덕션 승인·API 스코프는 각 [계약 조사](commerce-provider-matrix.json)와 체크리스트를 따르며 현재 실계정 데이터는 미확인이다.

## 가격과 수집 범위

`retail_current`는 소비자 판매가, `supplier_catalog`는 공급사/창고가 제시한 카탈로그 가격, `supplier_base`는 문서가 명시한 생산 기본가, `regional_catalog_base`는 지역별 공식 카탈로그 기본가, `market_reference`는 별도 시장 참고가격이다. CJ sellPrice를 directWholesalePrice로 바꾸지 않으며 문서상 단위·통화가 없는 도매 객체는 API 결과에 원문과 미확인 표시로 보존한다. 배송비·세금·출력 위치·수량 할인 등이 최종 매입 원가를 바꿀 수 있어 이 수집값을 최종 결제 총액으로 합산하지 않는다.

Printful 피드는 서버의 Last-Modified와 원 응답 해시를 남긴다. 당시 피드 수정 시각은 2026-10-04 00:10:10 UTC였다. 중국 지역의 `$`는 통화가 확인되지 않아 `currency:null`을 유지하고 `currencyUnverifiedCount`를 올린다. 이런 수집은 `complete:false`다.

Allbirds/ColourPop은 기본 익명 USD 스토어 문맥만 검증했다. 예측 검색은 최대 10개 제안으로 `predictive_sample`이며 전체 카탈로그 탐색 완료로 표시하지 않는다. 판매 가능 여부 응답은 재고 수량이 아니며 `hide` 옵션을 줘도 공급원이 품절 항목을 포함할 수 있다. Impact의 선주문·입고 대기는 재고 있음으로 표시하지 않는다.

Amazon은 최대 100개 검색 결과 범위에서 API의 첫 가격 포함 offer를 기록한다. 최저가/Buy Box로 추정하지 않으며 부분 실패는 `partialResponses`로 표시한다. Banggood 세일 날짜의 시간대가 불명확하므로 현재 할인 여부를 추정하지 않는다. Awin의 행 구조, Banggood의 페이지 입력, 공급원별 한도에 도달한 조회는 미확인·제한된 수집 범위로 남는다.

각 서비스와 공통 수집기는 [자동 기능 체크리스트](../checklists/README.md)에서 감사한다. 모의 응답 테스트는 로컬 계약 검증이며 인증된 실증을 대체하지 않는다. `npm run checklist:strict`는 필수 미충족 항목이 있으면 종료 코드 2를 반환한다.
