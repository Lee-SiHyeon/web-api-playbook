# 상품 상세와 리뷰 조회

이번 범위는 제휴 링크를 제외한 검색·가격·상세·옵션·상품 이미지·리뷰 본문·리뷰 사진·페이지 이동이다. 기존 `commerce`는 가격 스냅샷을 만든다. `catalog`는 SDK가 검증한 상세 필드를 보존하고 리뷰를 별도 JSON/CSV로 수집한다.

Olive Young 한국 공개몰은 `oliveyoung-public`, 인증 Curator는 `oliveyoung`, 글로벌몰은 `oliveyoung-global`이다. 한국 검색·KRW 가격과 리뷰 커서 두 페이지는 쿠키 없는 `curl_cffi` HTTP 전송기로 재생했고 기본 commerce/catalog 명령에 연결했다. 숫자 ID·널 값을 포함한 리뷰 커서와 여러 카테고리 ID를 보존한다. 전체 리뷰 종료와 상품 상세·옵션은 미확인이다. 국내 판매 랭킹은 [별도 HTML 문서 수집기](commerce-oliveyoung-korea-ranking.md)이며 XHR로 분류하지 않는다. 추가 카테고리 일괄검증은 429에서 중단했다. 반복 조회에는 브라우저를 포함하지 않는다.

글로벌몰은 카테고리 상품을 JSON API로 읽고 USD 설정을 별도 현재 HTTP 페이지에서 확인한다. 한 카테고리의 당시 전체 결과 수는 3,674건이며 24/36/48개 페이지 크기와 마지막/빈 페이지를 검증했다. 카테고리 조회, 자동완성, 인기 검색어, 베스트셀러는 별도 명령이며 전체 키워드 상품 검색으로 표시하지 않는다.

```bash
npm run catalog -- oliveyoung-global suggest --query=mask --output=work/oy-suggestions.json
npm run catalog -- oliveyoung-global popular-keywords --output=work/oy-keywords.json
npm run catalog -- oliveyoung-global best-sellers --output=work/oy-bestsellers.json
npm run catalog -- oliveyoung-global category-products --category-id=1000000008 --page=1 --catalog-page-size=24 --output=work/oy-category.json
npm run commerce -- oliveyoung-global category --category-id=1000000008 --page-size=24 --max-pages=2 --limit=200 --output=work/oy-prices.json --csv=work/oy-prices.csv
```

정가/현재가와 상품 전체/옵션 가격은 서로 다른 레코드다. `reviews` JSON·CSV는 연관 상품의 후기 여부와 실제 원 상품 ID도 유지한다. 연관 상품 후기를 요청 상품의 직접 후기라고 바꾸지 않는다.

2026-10-05 현재 코드의 독립 CLI 실증과 JSON/CSV 대조는 [실행 기록](../verification/catalog-native-cli-2026-10-05.json)에 있다. 선택 상품의 전체 리뷰는 Sephora 1,773건(본문 1,771건), Ulta 429건, Rakuten Japan 427건, ColourPop 32건이다. 이는 해당 상품·필터의 당시 결과이며 전체 쇼핑몰 데이터 수가 아니다. Olive Young Global은 상품 상세와 리뷰/사진 API 및 후속 페이지를 검증했고 공통 실행기로 20건을 샘플 수집했다.

| 플랫폼 | 실제 조회 또는 구현 범위 | 남은 범위 |
|---|---|---|
| Sephora US | 공개 검색·페이지, SKU 가격/세일·이미지·옵션, 리뷰 본문/사진·SKU 필터 | 장문 상품 설명 API에서 본문을 받지 못함 |
| Ulta US | 공개 검색·가격·상세 설명/성분·이미지·옵션·전체 리뷰/사진·페이지 | 현재 US 읽기 범위의 필수 게이트 통과; 전체 카탈로그 전수 수집은 아님 |
| [Rakuten Japan](japan-retail-http.md) | 공개 Document 메뉴·검색·상세·SKU 가격/재고, 리뷰 본문·사진 썸네일·페이지 | 공식 API 실호출은 applicationId/accessKey 필요; 전체 탐색 미완료 |
| [Yahoo Shopping Japan](japan-retail-http.md) | 공개 Document 홈/카테고리·상세·옵션별 가격/재고·리뷰 미리보기 | 일반 검색 HTTP 500; 공식 검색 app ID·제휴 연결·전체 리뷰 미검증 |
| Olive Young Global | 상세·설명·옵션·가격·베스트셀러·리뷰 요약/본문/사진·페이지 | 키워드 검색 403; 한국 Curator와 별도 |
| Olive Young Korea | Curator 가격 검색 코드 | 세션 부재, 공개 상세/리뷰는 Cloudflare 차단 |
| Amazon US | 공개 검색 XHR·표시 가격·썸네일·페이지; 공식 상품/이미지/옵션 클라이언트 | 공개 상세/전체 리뷰·완전한 검색 종료 미검증, 공식 조회는 승인된 API 자격 필요 |
| AliExpress | 공개 SEO, 공식 상품/갤러리/가격 클라이언트 | 공개 상세·리뷰 CAPTCHA, 공식 조회 앱 자격 필요 |
| Shopee Indonesia | 공식 상품 offer/가격/평점 클라이언트 | 앱 자격 필요; 공개 상세 접근 오류로 설명/SKU/전체 리뷰 미검증 |
| Shopify 예시 몰 | Allbirds/ColourPop 상세·옵션·가격, ColourPop 전체 리뷰/사진 | Allbirds 리뷰 소스 비활성, 전체 검색·컬렉션은 미완료 |
| eBay | 공개 추천어, 공식 Browse 상세/변형/가격/평점 요약 클라이언트 | Browse 앱 자격 필요, 공개 전체 상세/리뷰 XHR 미검증 |

자동 감사는 [현재 읽기 범위 결과](../verification/catalog-scope-audit-2026-10-05.json)를 따른다. 필수 미완료가 있어 전체 `catalog:check`는 종료 코드 2다. [Amazon 리뷰 로그인 화면](../verification/catalog-blockers/amazon-reviews.png), [AliExpress CAPTCHA](../verification/retail-blockers/aliexpress-detail-2026-10-05.png), [한국 Olive Young 차단](../verification/catalog-blockers/oliveyoung-korea-detail.png), [글로벌 검색 차단](../verification/catalog-blockers/oliveyoung-global-search.png)을 보존했다. Shopee 오류 응답의 `is_login:false`는 일반 로그인만으로 해결된다는 증거가 아니며, 계정 요구와 트래픽 차단 원인은 구분한다.

```bash
npm run catalog -- providers
npm run catalog -- shopify-storefronts product --store=colourpop --id=eeveelution-shadow-palette --output=work/product.json
npm run catalog -- shopify-storefronts reviews --store=colourpop --id=eeveelution-shadow-palette --max-pages=10 --limit=100 --output=work/reviews.json --csv=work/reviews.csv
npm run catalog -- sephora product --id=P281411 --sku-id=2760981 --output=work/sephora-product.json
npm run catalog -- sephora reviews --id=P281411 --page-size=20 --max-pages=3 --limit=100 --output=work/sephora-reviews.json --csv=work/sephora-reviews.csv
npm run catalog:check
```

출력 디렉터리를 먼저 만들고 새 파일명을 쓴다. `providers`는 오프라인 기능 재고다. `unimplemented`와 `not_exposed_by_official_api`는 계정 연결만으로 해결되지 않는다. `implemented_pending_live`는 코드가 있다는 뜻이며 실계정 성공을 뜻하지 않는다. 실제 요청 증거와 현재 코드 해시는 플랫폼 체크리스트를 따른다.

`--scope=catalog` 감사는 링크 발급, 가입, 프로필·정산·주문 변경을 이번 완료 기준에서 제외한다. 원래 기능 상태를 N/A나 완료로 바꾸지 않는다. 필요한 상세·리뷰가 없거나 실증되지 않았으면 `catalog:check`는 종료 코드 2다. 일반 `checklist` 명령은 기존 범위를 유지한다.

## 데이터 의미

상품 설명·갤러리와 고객 리뷰 본문·사진은 별도다. 평점·리뷰 수·긍정 평가 비율은 리뷰 본문 조회가 아니다. 상품·부모 상품·SKU/옵션과 listing 가격·선택 SKU 가격을 구분한다. 제공하지 않는 필드는 `null` 또는 명시된 미지원 상태로 남긴다. SSR 상세 문서는 상품 XHR로 표시하지 않는다.

Amazon 공개 검색은 실제 `POST /s/query` 스트리밍 XHR의 주 검색 카드를 파싱한다. 표시 가격의 `KRW` 등 ISO 코드와 금액을 보존하고 `$`만 있으면 USD를 추정하지 않는다. 줄친 표시는 정가로 단정하지 않는다. 전체 검색 결과 수·페이지 ASIN 수·주 검색 카드 수는 서로 다른 지표다. 종료 조건이 확정되지 않아 가격 수집은 `provider_limited`다.

공식 Amazon/AliExpress/eBay/라쿠텐 API는 등록된 앱 자격·API 권한이 필요할 수 있다. Amazon PartnerTag는 API 요청에 필요한 입력이며 이번 출력은 제휴 URL·귀속 정보를 제거한다. 상품 API에 고객 리뷰 본문 필드가 없으면 계정만으로 생기지 않는다.

공개 리뷰의 frontend key는 현재 페이지·자사 번들에서 HTTP로 준비할 수 있다. 그 준비와 실제 API 호출을 별도로 기록하고 사용자 계정 키와 구분한다. 값은 프로세스 메모리에만 둔다. 발견용 Playwright는 반복 실행 경로에 포함하지 않는다.

리뷰는 본문·평점·날짜·이미지를 저장하며 작성자 계정·프로필 정보는 저장하지 않는다. 구매 인증 의미나 평점 척도를 확인하지 못한 필드는 추정하지 않는다. CSV는 줄바꿈과 사진 URL을 보존하고 수식 문자를 이스케이프한다.

## 범위와 이어 받기

리뷰 수집은 페이지·리뷰 수·저장 바이트로 제한된다. 중복 ID, 순환 커서, 변경된 중복 본문, 전체 건수 변동을 감지한다. 마지막 페이지를 읽어도 전체 건수와 다르면 `complete:false`다. 뒤쪽 페이지에서 시작한 조회도 전체 수집 완료로 표시하지 않는다.

`requestContext.requestedPageSize`와 `effectivePageSize`를 구분한다. ColourPop은 최대 5건, 글로벌 Olive Young은 최대 10건, Rakuten은 고정 30건이고 Ulta는 실제 API 최대 25건이다. 이어 받기에서는 대상·스토어·원 요청 페이지 크기가 일치해야 한다.

`collection.continuation`이 있으면 동일 상품·스토어·페이지 크기로 이어 받는다.

```bash
npm run catalog -- shopify-storefronts reviews --store=colourpop --id=eeveelution-shadow-palette --page-size=20 --max-pages=3 --limit=100 --resume-input=work/reviews.json --output=work/reviews-next.json --csv=work/reviews-next.csv
```

페이지 중간에서 한도에 도달하면 같은 페이지를 재조회하고 이미 저장한 ID를 건너뛴다. 결과들을 합칠 때 리뷰 ID로 중복을 제거한다. 토큰이 담긴 URL을 이어받기 커서로 저장하는 것은 거부한다. 제휴 링크 생성·클릭·수익 귀속 검증은 실행하지 않는다.
