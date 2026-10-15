# 쿠팡 일반 상품과 트래블 HTTP 탐색

2026-10-15 Canary의 실제 메뉴·상품 클릭으로 일반 검색, 정렬/필터, 홈 탭과 트래블을 관측하고 독립 Node HTTP reader를 추가했다. 트래블은 쿠키 없이 읽는다. 일반 검색 Document는 기존 `coupang-visitor-context`의 HTTP 발급 방문자 쿠키를 기본으로 사용한다. RSC reader는 관측한 입력을 메모리로 받아 별도 Node HTTP 프로세스에서 실행하며, 반복 입력의 브라우저 의존성 제거는 아직 완료하지 않았다.

**전체 탐색은 부분 완료다.** 일반 검색 RSC는 성공한 브라우저 요청의 전체 쿠키를 메모리로 전달하자 독립 Node HTTP에서 200으로 재현됐다. 상품 60개의 ID·이름·표시 가격이 현재 DOM과 모두 일치했다. 방문자 쿠키만 보내거나 Akamai 쿠키만 추가한 조합은 403이었다. 반복 입력과 세션 갱신의 브라우저 의존성 제거는 아직 완료하지 않았다. 트래블의 사용 가능한 계약은 실제 하위 카테고리, 다음 페이지, 상세·옵션·후기에 적용했다. 미처리 목록은 저장돼 있으며 백그라운드 작업이 실행 중인 것은 아니다.

## 현재 확인 범위

| 범위 | 실제 확인 | 남은 경계 |
|---|---|---|
| 홈 카테고리 | 공개 `category-list` JSON 200, 메뉴 노드 3,228개 | 메뉴 수는 상품 목록 수가 아니다 |
| 일반 상품 검색 | 브라우저 전체 쿠키 33개를 보낸 독립 HTTP RSC 200. 60/60 ID·이름·표시 가격이 DOM과 일치 | 방문자 3개, 방문자+Akamai 11개 조합은 403. 필요한 추가 쿠키의 최소 집합과 자동 갱신, 다른 검색·페이지는 미검증 |
| 일반 카테고리 | 가전디지털 목록 60개와 다음 링크로 2페이지 UI 확인 | 방문자 쿠키를 보낸 1·2페이지 Document GET도 403 |
| 일반 상품 공개 가격 | 기존 방문자 부트스트랩 200, 정확한 SKU의 offer-list 200. Document 거부 전후 동일 방문자로 일반가 13,200원 확인 | 회원 적용가는 미검증. 공개 후기 JSON은 별도 envoy 403 |
| 다른 홈 탭 | 로켓배송, 로켓프레시, 로켓직구, 판매자특가, 와우회원할인, 반품마켓, 착한상점, 이달의신상, 기획전, 골드박스 UI 관측 | 탭 방문은 모든 하위 기능의 HTTP 성공이 아니다. 다시 구매는 클릭 후 브라우저 도구 오류, 쿠팡비즈 계정 흐름은 미검증 |
| 트래블 대분류 | 국내 티켓·호텔·펜션·패키지·렌터카, 해외 패키지·항공+호텔·티켓·숙소·실시간항공권 10개 UI 관측 | 실시간항공권 iframe 탐색은 도구 오류로 미검증 |
| 트래블 카테고리/페이지 | 하위 navigation 54회 첫 탐색, 이후 수정·페이지 진행. 최종 고유 HTTP 자원 138개, 목록 자원 103개 | 목록 자원에는 목록을 담은 category navigation도 포함. 전체 재고 분모는 미상 |
| 숙소 검색 | 제주도 검색 JSON, 2·3페이지 각각 24개 | 요청 날짜는 2026-10-15~16. 다른 날짜·모든 숙소 재고의 검증이 아니다 |
| 상세·옵션 | 상세 Document 고유 25개. 24개 상세의 객실/티켓 옵션 HTTP 확인 | internal product ID와 `/tp/products/` package ID를 구분 |
| 후기 | 25개 상세에서 후기 메타데이터 또는 유효한 빈 결과 확인. 다음 페이지도 실제 재현 | 작성자·원문·첨부 토큰은 보존하지 않음. 12개 후기 컬렉션에 다음 페이지가 남음 |
| 렌터카 | 제주 렌터카 가격순 JSON 1·2페이지 각각 25개. 카니발 상세의 날짜·자차불포함 대표 옵션·89,010원 대조 | 대여 2026-10-22 08:00~23 08:00. 대표 옵션만 HTTP 확인; 모든 보험 옵션 API 미확보 |

HTTP 403의 원인은 확정하지 않았다. 브라우저는 접근되므로 일반 사용자가 해당 사이트를 못 본다는 뜻이 아니다. 와우·회원 할인은 표시 조건으로 남기며 실제 계정 적용가·예약 결제 총액으로 승격하지 않는다. 생성·예약·결제·장바구니·리뷰 쓰기는 0회다.

## 실행

저장소 루트에서 Node.js 24와 설치된 의존성을 사용한다. `--out`은 새 파일만 받는다. 예시 날짜는 관측 당시 값이므로 이후에는 공개 날짜 필드를 현재 목적에 맞게 바꾼 별도 입력 파일을 사용한다.

```powershell
npm run coupang:public -- categories --out=work/coupang-categories.json
npm run coupang:public -- retail-search "--query=무선 마우스" --sorter=salePriceAsc --free-delivery --out=work/retail-search.json
npm run coupang:public -- autocomplete --query=제주 --out=work/travel-autocomplete.json
npm run coupang:public -- search --template=verification/coupang-discovery-2026-10-15/travel-search-request.json --page=2 --results-only --out=work/travel-search.json
npm run coupang:public -- search --template=verification/coupang-discovery-2026-10-15/travel-rental-request.json --page=2 --results-only --out=work/travel-rental.json
npm run coupang:public -- rooms --template=verification/coupang-discovery-2026-10-15/travel-rooms-request.json --out=work/travel-rooms.json
npm run coupang:public -- ticket-options --template=verification/coupang-discovery-2026-10-15/travel-ticket-options-request.json --out=work/travel-ticket-options.json
npm run coupang:public -- reviews --product-id=10000011240833 --page=1 --sort=ORDER_SCORE_ASC --out=work/travel-reviews.json
```

`retail-search`는 일반 상품 Document reader이며 현재 라이브 성공을 보장하지 않는다. `search`는 트래블 JSON reader다. Document는 `document --url=<관측한 공개 주소>`로 읽는다. 허용한 읽기 경로만 전송하며 로그인 HTML·SPA 빈 껍데기·다른 상품 ID·잘못된 페이지를 성공으로 처리하지 않는다. 옵션의 19자리 ID는 응답의 정확한 문자열을 사용한다.

### 방문자 쿠키와 403 진단

앞선 `retail-search-live.json`은 쿠키 없는 진단이었다. 기존 익명 상품 로직은 `GET /n-api/web-adapter/proxy`로 발급된 `PCID`, 언어·시장 쿠키만 메모리에서 재사용한다. 계정 쿠키와 bot-management 쿠키는 포함하지 않는다. 이 로직을 일반 검색·카테고리와 별도 관측된 RSC 범위에 연결했다. `retail-search --anonymous`는 명시적 쿠키 없는 진단이며, `document --visitor`는 허용된 일반 검색·카테고리에만 적용된다.

```powershell
npm run coupang:visitor:check -- --out=work/visitor-check.json
npm run coupang:retail:diagnose -- --compare-403 --out=work/retail-diagnostic.json
```

비교 진단은 사용자 요청에 따른 명시적 실행이다. 한 방문자와 실제 네이티브 fetch 헤더를 유지하며 가격순, 무료배송, 홈 Referer, Node HTTP/2, 카테고리 1·2페이지를 비교한다. 모든 Document 변형은 `AkamaiGHost` 403이었다. 동일 방문자의 offer-list는 비교 전후 `envoy` 200이었다. 후기 JSON의 `envoy` 403은 다른 응답 계열로 보존한다. 일반 수집기는 거부 후 중단하며, 진단도 재발급·방문자 교체·자동 재시도 없이 진행하고 401/418/429 또는 상호작용형 challenge에서 중단한다.

새 탭에서 CDP Network 연결을 복구하고 실제 가격순 클릭의 Fetch 요청·응답을 연결했다. 브라우저 RSC는 `h2`, `envoy`, 200 `text/x-component`였다. 쿠키 이름 관측에는 PCID와 bot-management 상태가 포함됐지만, 특정 쿠키나 TLS 특성이 성공에 필수라고 입증한 것은 아니다. 사용자 계정 로그인이 필요하다는 결론도 아니다. 기존 탭의 React #418과 paused Document 오류는 별도로 기록했다. React #418은 HTTP 상태가 아니라 서버 HTML과 클라이언트 초기 화면의 불일치를 뜻한다. [React 공식 설명](https://react.dev/errors/418).

`scripts/coupang-rsc-probe.mjs`는 `_rsc`와 라우터 헤더를 포함한 관측 입력을 **stdin 메모리**로만 받는다. `--visitor` 유무 두 실행 모두 현재 403이다. `_rsc` 생성·갱신을 구현했다고 주장하지 않는다. `lib/retail/coupang-rsc.mjs`는 RSC 모델의 주요 `products` 배열만 읽고 추천 19개와 광고 추적 정보는 제외한다. 캡처 본문의 한글 디코딩 보정은 DOM 60/60 대조로 검증했으며, 직접 HTTP 파서는 받은 바이트를 UTF-8로 해석한다.

### 브라우저 쿠키 비교 후속 검증

사용자의 명시적 요청으로 `scripts/coupang-browser-cookie-probe.mjs`를 추가했다. 현재 Canary의 가격순 클릭에서 성공한 RSC 요청과 실제 outgoing Cookie 헤더를 함께 관측한 뒤, 독립 Node 프로세스에 stdin으로 전달했다. 동일 URL·RSC 애플리케이션 헤더·PCID에서 쿠키만 바꿨다.

| 쿠키 조건 | 개수 | 직접 HTTP 결과 |
|---|---:|---|
| 브라우저 PCID·시장·언어 | 3 | AkamaiGHost 403 |
| 위 조건 + 관측한 Akamai 쿠키 | 11 | AkamaiGHost 403 |
| 성공한 브라우저의 전체 Cookie 헤더 | 33 | 200 text/x-component, 상품 60개 |

`undici:request:create`에서 실제 전송된 쿠키 문자열이 입력과 같은지 메모리에서 비교했고 세 조건 모두 일치했다. 브라우저 User-Agent, TLS 지문, HTTP/2 옵션을 재현한 실험은 아니다. 쿠키와 요청 입력은 저장하지 않으며 5분의 로컬 입력 신선도 제한을 둔다. 이는 서버의 쿠키 만료 시간이라는 뜻이 아니다. 리디렉션·자동 재시도·방문자 재발급은 없다. 전체 쿠키 성공은 추가 쿠키 중 무엇이 필요한지 또는 소유자 인증이 성립했는지를 증명하지 않는다. 직접 HTTP 결과 60개는 현재 화면의 상품·item·vendor ID, 이름, 표시 가격과 모두 대조했다.

기존 방문자 provider의 허용 범위를 넓히거나 수집기의 기본 쿠키 정책을 변경하지 않았다. 이 비교 runner는 입력 획득에 브라우저가 필요한 명시적 진단 경로다. 재사용 가능한 보호 저장소·쿠키 갱신·프로세스 재시작 후 복구는 이 실행에서 검증하지 않았다.

## 재귀 탐색과 재개

`verification/coupang-discovery-2026-10-15/resource-frontier.json`에 홈페이지 두 곳, 관측 부모 관계, 각 URL의 HTTP 결과·시도 횟수, 날짜/옵션 구분, 다음 페이지와 미처리 옵션을 저장한다. 카테고리 기본 필터의 중복만 합치며 대여/숙박 날짜와 상품 옵션은 별도 자원으로 유지한다. 같은 frontier를 동시에 두 프로세스에서 실행하지 않는다.

```powershell
npm run coupang:crawl -- --phase=travel-navigation --max=60
npm run coupang:crawl -- --phase=travel-pages --max=30
npm run coupang:crawl -- --phase=travel-search-pages --max=20
npm run coupang:crawl -- --phase=travel-details --max=24
npm run coupang:crawl -- --phase=travel-reviews --max=24
```

`max`는 한 실행의 요청 수 한도이며 전체 탐색 완료 조건이 아니다. 한도에 닿으면 다음 자원을 보존한다. Document와 검색 JSON의 다음 페이지는 각각 원래 클라이언트로 재개한다. 401/403/418/429가 나오면 같은 배치를 중단한다. 기존 403 공유 경계에 속한 일반 상품 자원은 무작정 반복하지 않고 `blockedBy`로 보존한다.

현재 수천 개의 목록·상세 자원이 대기 중이다. 일반 상품의 공유 실패 경계, 개별 실패 자원, 별도 읽기 계약 미확보 경로, 렌터카 전체 옵션, 후기 다음 페이지도 유지한다. 날짜가 빠졌던 렌터카 파생 주소 50개는 보정된 상세 주소로 연결하고 `superseded`로 구분했다. 최신 집계는 verifier의 `coverage`에 있다. 이는 **탐색 진행 기록**이며 전체 사이트 완주율이나 백그라운드 실행 상태가 아니다.

## 다섯 검증 상태

| 계약 | captured | client_exists | remnant_free | credential_propagated | live_replay |
|---|---|---|---|---|---|
| 일반 카테고리 메뉴 JSON | true | true | true | 익명, 해당 없음 | true |
| 일반 검색 RSC Fetch | true, 가격순 클릭의 입력·본문 | true | HTTP 전송만; 반복 입력 공급 미완료 | 전체 브라우저 쿠키의 실제 전송 일치 확인; 소유자 인증 미검증 | true, 전체 쿠키 조건에서 200·60개 |
| 일반 검색/카테고리 Document | 현재 요청/응답 쌍 미확보 | true | true | 계정 인증 해당 없음; 방문자 전송 확인 | false, 403 |
| 일반 상품 offer-list | 기존 관측 계약 | true | true | 계정 인증 해당 없음; 방문자 전송 확인 | true, 정확한 SKU·비교 전후 |
| 트래블 category Document 계열 | true | true | true | 익명, 해당 없음 | true, 처리한 자원만 |
| 트래블 home/detail Document | 현재 요청/응답 쌍 미확보 | true | true | 익명, 해당 없음 | true, 처리한 자원만 |
| 트래블 autocomplete/search/rooms/ticket-options/reviews JSON | true | true | true | 익명, 해당 없음 | true, 기록된 입력만 |
| 렌터카 전체 보험 옵션, 항공 iframe | false | false | 해당 없음 | 미검증 | false |

`remnant_free` 범위는 반복 HTTP 읽기 전체다. 최초 UI 발견은 별개다. 초기 라이브 receipt 일부는 후속 메타데이터 보완 전 생성됐으며, verifier의 파일 해시는 **검증 시점 코드**를 나타낸다. 과거 요청이 전부 동일한 최종 코드로 실행됐다고 주장하지 않는다.

## 증거와 온톨로지 출력

```powershell
node --test tests/coupang-public.test.mjs tests/coupang-frontier.test.mjs
node --import ./scripts/coupang-offline-guard.mjs --test tests/coupang-retail-visitor.test.mjs tests/coupang-retail-diagnostic.test.mjs tests/coupang-rsc.test.mjs service-packs/affiliate/apps/affiliate-api-hub/tests/coupang-visitor-context.test.mjs
node --import ./scripts/coupang-offline-guard.mjs --test tests/coupang-browser-cookie-probe.test.mjs
npm run coupang:verify
```

`scripts/verify-coupang-public.mjs`는 저장된 응답의 상태·스키마·공개 데이터 해시, 실패 receipt, 인증/방문자 식별값 누출 여부를 검사한다. 검증 자체는 오프라인이다. 대표 성공 계약 9개와 실제 crawl receipt를 대조하며 당시의 live GET/POST 증거를 새 네트워크 검사로 표현하지 않는다.

- [검증 결과](../verification/coupang-discovery-2026-10-15/verification.json)
- [브라우저 관측](../verification/coupang-discovery-2026-10-15/browser-observations.json): 공개 URL·헤더 이름·필드 구조·요청/응답 상태만 저장
- [재개할 탐색 목록](../verification/coupang-discovery-2026-10-15/resource-frontier.json)
- [대표 온톨로지 투영](../verification/coupang-discovery-2026-10-15/ontology-projections.json), [수집 receipt별 JSONL](../verification/coupang-discovery-2026-10-15/ontology-crawl-projections.jsonl)
- [렌터카 옵션 화면](../verification/coupang-discovery-2026-10-15/travel-rental-options.jpg)
- [방문자 비교 진단](../verification/coupang-discovery-2026-10-15/retail-403-variants-live.json), [RSC 캡처와 DOM 대조](../verification/coupang-discovery-2026-10-15/retail-rsc-capture.json)
- [RSC 쿠키 없는 직접 재현](../verification/coupang-discovery-2026-10-15/retail-rsc-anonymous-replay.json), [방문자 직접 재현](../verification/coupang-discovery-2026-10-15/retail-rsc-visitor-replay.json), [검색 화면](../verification/coupang-discovery-2026-10-15/retail-rsc-browser.jpg)
- [브라우저 쿠키 3조건 직접 HTTP 비교](../verification/coupang-discovery-2026-10-15/retail-browser-cookie-comparison-live.json): 전체 쿠키 200, 60/60 상품·이름·표시 가격 DOM 일치

`projectCoupangTravel`은 `productId`, package ID, vendor item ID를 구분하고 가격마다 날짜·인원·회원 조건·증거 해시를 붙인다. public 가격이 없는 경우 0원으로 채우지 않는다. 데이터베이스 반영은 수행하지 않았으며 `databaseWrites=0`이다. 원시 응답의 session/search tracking, access pass, booking block, 사용자 신원은 출력에서 제외한다.
