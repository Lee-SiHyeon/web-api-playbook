# 요청한 제휴 플랫폼의 API 조회

Amazon·AliExpress는 기존 공식 파트너 API를 재사용하고, Olive Young·Shopee Indonesia·Sephora US·Ulta US·Rakuten Japan과 Rakuten Advertising을 수집기에 연결했다. 브라우저는 계약 탐색에 사용하며 공통 `scripts/commerce.mjs`는 Node HTTP로 실행한다.

| 프로그램 | 수집기 | 상품·가격 조회 경로 | 현재 경계 |
|---|---|---|---|
| Olive Young 쇼핑 큐레이터 | `oliveyoung` | 기존 인증 Curator 검색, KRW `priceToPay`와 `originalPrice` 분리 | 자체 세션 없음, 익명 403; 상세/다음 페이지/현재 회원 바인딩과 링크 발급 미확인 |
| Amazon Associates | `amazon-partner` | 기존 Creators API 검색·ASIN 조회·OffersV2 | API 자격 정보·해당 마켓 PartnerTag·API 접근 요건 필요 |
| AliExpress Affiliate | `aliexpress-partner` / `aliexpress-social` | 기존 TOP 서명 상품 검색·상세·가격 및 소셜 범위 가격 | 앱 키/비밀 키 필요; 별도 드랍쉬핑 권한은 미확인 |
| Shopee Affiliate Indonesia | `shopee-id` | 공식 V2 GraphQL 상품 검색·itemId 조회 | 해당 국가 App ID/Secret 필요; 문자열 가격은 배율 변환 없이 보존, 통화는 IDR 후보/미확인 |
| Sephora US | `sephora` | 관찰한 공개 상품 검색 XHR·페이지, USD 정가 및 범위·상품 URL | 실제 익명 HTTP 수집 실증; 상세/할인가/미국 외 시장 미확인 |
| Sephora US affiliate | `sephora-affiliate` | Rakuten Advertising Product Search, MID와 응답 광고주 이름·USD 검증 | 승인된 publisher token과 자기 계정의 MID 필요; MID를 추측하지 않음 |
| Ulta US affiliate | `ulta-affiliate` | 기존 Impact에서 카탈로그를 읽어 광고주 이름·US/USD 확인 후 상품 조회 | 자기 SID/AuthToken·catalogId 필요; 검색은 반환 항목의 로컬 필터, 전체 탐색 미확인 |
| Ulta US 공개 스토어 | `ulta` | 익명 HTML에서 현재 요청 입력을 준비한 뒤 `/dxl/graphql` 상품 검색·페이지·정가/세일가 | Node HTTP 재생 실증; 상세·미국 외 시장 미확인 |
| Rakuten Ichiba Japan | `rakuten-ichiba` | 새 2026-07-01 Item Search·itemCode 조회·장르, JPY 가격 | 등록한 applicationId/accessKey 필요; 자기 affiliateId는 선택 |
| Rakuten Advertising | `rakuten-advertising` | 공식 토큰/XML Product Search·MID·페이지·가격/세일가격 분리 | publisher token 필요; 문서 한도 충돌 때문에 최대 1,000개로 제한 |

Ulta의 공개 조회는 현재 검색 페이지의 입력/쿼리를 HTTP로 얻고 JSON XHR을 재현한다. HTML은 요청 준비에 사용하며 상품 가격은 실제 GraphQL 응답에서 읽는다. 상류 페이지는 64개에 스폰서 카드가 포함될 수 있어 보고된 resultCount와 수집한 고유 카드 수를 같은 지표로 합치지 않는다. 공통 수집기는 모든 반환 카드를 읽고 중복을 제거하지만 전체 카탈로그 완료를 보증하지 않는다.

## 실행

```bash
npm run commerce -- providers
npm run commerce -- sephora collect --query=lipstick --page-size=60 --max-pages=3 --limit=500 --output=work/sephora.json --csv=work/sephora.csv
npm run commerce -- ulta collect --query=lipstick --max-pages=4 --limit=500 --output=work/ulta.json --csv=work/ulta.csv
npm run commerce -- oliveyoung search --query="립스틱" --credentials-stdin --output=work/oliveyoung.json
npm run commerce -- shopee-id search --query=lipstick --credentials-stdin --output=work/shopee-id.json
npm run commerce -- rakuten-ichiba search --query="リップ" --page-size=30 --credentials-stdin --output=work/rakuten-jp.json
npm run commerce -- rakuten-ichiba product --id=OBSERVED_SHOP:OBSERVED_ITEM --credentials-stdin --output=work/rakuten-item.json
npm run commerce -- sephora-affiliate search --query=lipstick --merchant-id=YOUR_APPROVED_MID --credentials-stdin --output=work/sephora-affiliate.json
npm run commerce -- ulta-affiliate search --query=lipstick --catalog-id=YOUR_APPROVED_CATALOG_ID --credentials-stdin --output=work/ulta-affiliate.json
```

새 출력만 허용한다. 디렉터리를 먼저 만들고, 실제 API 키·세션 값은 [메모리 공급 방식](commerce-collection.md)으로 표준 입력에 전달한다. 명령줄·작업 JSON·Git·결과 파일에는 넣지 않는다. 추가 공급자의 입력 필드는 다음과 같다.

| 수집기 | 표준 입력 JSON의 필드 |
|---|---|
| `oliveyoung` | `provider:"oliveyoung"`, `session` (기존 Curator 어댑터의 scope/authorization 또는 origin-scoped cookie envelope) |
| `shopee-id` | `provider:"shopee-id"`, `appId`, `appSecret` |
| `rakuten-ichiba` | `provider:"rakuten-ichiba"`, `applicationId`, `accessKey`, 선택 `affiliateId` |
| `rakuten-advertising` / `sephora-affiliate` | 실행 수집기와 같은 `provider`, `accessToken` |
| `ulta-affiliate` | `provider:"ulta-affiliate"`, `accountSid`, `authToken`; `catalogId`는 조회 인자 |

Rakuten Japan의 accessKey는 HTTP 헤더에만 보낸다. 글로벌 Rakuten Advertising과 일본 Rakuten Ichiba는 서로 다른 계정·API·키·보상 체계다. Sephora/Ulta 브랜드 이름을 검색어에 붙이는 것으로 승인된 해당 브랜드 카탈로그라고 간주하지 않는다.

## 가격·링크·수수료

Sephora의 `currentSku.listPrice`는 `retail_list`로 저장하며 단일 금액과 상품 범위를 구분한다. 상품 전체 범위를 선택한 SKU 하나의 가격으로 표시하지 않는다. Rakuten Japan의 `itemPrice`는 listing 수준 API 가격이며 selected variant 가격으로 단정하지 않는다. `itemPriceBaseField`와 전체/검색 가능/구매 가능 옵션 범위는 원 모듈에 따로 보존한다.

Rakuten Advertising의 `price`와 `saleprice`는 각각 정가/보고된 세일가로 기록한다. 세일 적용 시각이 응답에 없어 `reported_sale`을 현재 확정 할인가로 합치지 않는다. Shopee Indonesia는 직접 API 가격 문자열을 나누거나 다른 나라의 배율로 변환하지 않으며, 통화 미확인은 `currencyUnverifiedCount`와 `complete:false`로 나타낸다.

API가 반환한 제휴 링크는 `affiliateLink`로 일반 상품 URL과 분리하고 `source:"api_returned"`를 표시한다. 추적 URL에 실제 GET을 보내 클릭을 만들지 않는다. 별도 실증 없이 소유자 attribution이나 최종 도착 URL을 검증했다고 표시하지 않는다. Olive Young 신규 링크 생성은 현재 회원 식별자 바인딩이 확인되기 전까지 차단한다. 프로그램 가입, 광고주 신청, 주문/결제는 이 수집기가 실행하지 않는다.

주신 수수료·정산 표는 [공식 자료 확인 기록](commerce-program-facts-2026-10-05.json)에 출처와 국가·조건·미확인을 분리했다. Olive Young 국내 외부 링크 기본 직접 7%/간접 3%와 셔터 태그 직접 3%는 공식 가이드에서 확인했다. Sephora/Ulta의 공개 공식 가입 페이지에는 고정 요율이 없고, AliExpress는 현재 포털/계약 기준을 확인해야 하므로 예상 숫자를 런타임 상수로 넣지 않는다. Amazon 일반 가입 심사와 Creators API 접근 조건도 별도다.

기능별 코드·테스트·실증·현재 코드 해시는 [체크리스트](../checklists/README.md)에 연결했다. 실계정 키가 없는 서비스는 모의 응답 테스트가 통과해도 라이브 완료가 아니다.
