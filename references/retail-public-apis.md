# 해외 쇼핑몰 공개 HTTP 조회

현재 범위는 비로그인 조회다. 브라우저는 계약 탐색에만 사용하고, 아래 지원 명령은 Node HTTP로 실행한다. 계정 쿠키나 인증 토큰을 공급하지 않는다. 공개 상품 URL은 제휴 추적 링크가 아니다.

| 서비스 | 직접 HTTP로 확인한 기능 | 남은 범위 |
|---|---|---|
| AliExpress | 상품 ID로 SEO 제목·설명·정규 URL 조회 | 상품 목록 검색, 현재 가격·통화·재고, 분류, 페이지 이동 |
| eBay | 검색어 제안과 제안별 카테고리 힌트 | 상품 목록·상세, 전체 분류, 페이지 이동 |
| Shopify 기반 Allbirds | 공개 상품·옵션·가격·통화·판매 가능 여부, 최대 10개 예측 상품 검색 | 전체 상품 검색·분류·페이지 이동, 다른 스토어 계약 |
| Amazon | 공개 카탈로그 API 실증 없음 | 상품 JSON의 정확한 Accept 헤더 미확보, 독립 재생 415; 추천 입력 준비 미전환 |
| Walmart | 공개 카탈로그 API 실증 없음 | 익명 검색이 사람 확인 화면으로 이동 |

```bash
node scripts/retail.mjs status
node scripts/retail.mjs aliexpress product-seo --product-id=1005011947482958
node scripts/retail.mjs ebay suggest --query="usb cable"
node scripts/retail.mjs shopify product --handle=mens-runner-nz-slip-on-mushroom
node scripts/retail.mjs shopify predictive-search --query=runner --limit=5
node scripts/checklist.mjs --service=aliexpress --run-tests
node scripts/checklist.mjs --service=ebay --run-tests --strict
```

결과를 저장하려면 `--output=NEW_FILE.json`을 붙인다. 기존 파일은 덮어쓰지 않는다. 미지원 명령은 네트워크 요청 없이 `RETAIL_OPERATION_UNVERIFIED`와 지원 명령 목록을 반환하고 종료 코드 2를 사용한다. 가격을 제공하지 않는 AliExpress SEO 응답은 `price:null,currency:null`을 반환한다. eBay 제안의 카테고리 힌트는 전체 분류 체계나 해당 상품 목록이 아니다.

Shopify는 여러 스토어가 쓰는 플랫폼이다. 현재 어댑터는 `https://www.allbirds.com` 한 곳에 고정하며 다른 스토어로 인증값이나 요청을 전달하지 않는다. 기본 로케일의 익명 시장·통화 문맥만 확인했다. 상품 Ajax가 반환하는 정수 가격은 단위를 명시하고, 통화는 같은 익명 문맥의 `/cart.js` GET으로 검증한다. 이 보조 요청은 통화만 사용하며 장바구니를 수정하지 않는다. 예측 검색은 제한된 제안 상품이며 전체 검색과 페이지네이션으로 표시하지 않는다.

검색은 공식 `unavailable_products=hide` 옵션을 전송했지만 실측 결과에 `available:false` 상품도 포함됐다. 응답의 판매 가능 여부를 그대로 제공하며 해당 필터가 작동했다고 보증하지 않는다. 재고 수량이나 예약 가능 수량은 검증하지 않았다.

계약과 검증은 [AliExpress 계약](retail-aliexpress-contracts.json), [eBay 계약](retail-ebay-contracts.json), [Amazon 조사 기록](retail-amazon-contracts.json), [Walmart 차단 기록](retail-walmart-contracts.json)에 남긴다. eBay의 자사 JS는 실제 `XMLHttpRequest` URL 생성기를 포함하지만 현재 페이지에서 그 요청이 발생한 것은 관찰하지 못했다. 따라서 `first_party_bundle_contract`와 실제 익명 HTTP 재생을 각각 기록한다. SSR 상품 문서나 텔레메트리 응답은 상품 API 성공으로 처리하지 않는다.

Amazon의 추천 스트림은 캡처한 암호화 입력으로 재생됐지만, 새 입력을 HTTP만으로 얻는 단계는 미전환이고 샘플 HTML 카드에서 상품 링크·가격 노드를 검증하지 못했다. 응답 길이는 같았으나 해시는 달랐다. 상품 JSON의 415 원인도 정확한 요청 Accept를 확보하지 못해 미확인이다. 이들을 작동하는 상품 클라이언트로 등록하지 않는다.

관찰된 자사 JS 18개를 추가 확인했지만 공개 상품 조회의 정확한 Accept는 찾지 못했다. 소스에 있던 별도 associate 요청의 인증 헤더는 공개 상품 조회에 재사용하지 않았다. 실제 차단 화면은 [Amazon](../verification/retail-blockers/amazon.png), [Walmart](../verification/retail-blockers/walmart.png)에 보존했다.

각 서비스의 [체크리스트](../checklists/README.md)는 지원 기능과 미구현·차단 기능을 함께 유지한다. `npm run checklist:strict`의 미완료 종료 코드 2는 전체 상품 카탈로그가 완성됐다는 잘못된 표시를 방지한다. 저장된 라이브 영수증은 당시 코드와 실행 결과에 대한 증거이며 현재 재조회와 구별한다.

최종 검증은 실제 `scripts/retail.mjs`를 새 Node 프로세스로 실행했다. `verification/retail-*-cli-result-2026-10-05.json`은 원 실행기의 공개 결과이고, `*-cli-live-*` 영수증은 이를 독립 검사해 모듈·공통 CLI·관련 라이브러리·결과 파일 해시와 연결한다. 최초 모듈 실증 파일도 보존한다. 네 개 지원 명령이 HTTP 200과 비즈니스 응답 검증을 통과했으며 로컬 전체 테스트는 165개 통과했다.
