# 쿠팡 일반 상품과 트래블 HTTP 탐색

2026-10-15 Canary의 실제 메뉴·상품 클릭으로 일반 검색, 정렬/필터, 홈 탭과 트래블을 관측하고 독립 Node HTTP reader를 추가했다. 브라우저는 계약 발견과 화면 대조에만 사용한다. 반복 수집 경로는 `fetch`와 HTML/JSON 파서이며 브라우저·쿠키·인증 공급자를 사용하지 않는다.

**전체 탐색은 부분 완료다.** 일반 검색의 익명 Document GET은 403이고, 브라우저에서 관측한 RSC 응답의 전체 본문·입력 계약도 확보하지 못했다. 트래블의 사용 가능한 계약은 실제 하위 카테고리, 다음 페이지, 상세·옵션·후기에 적용했다. 미처리 목록은 저장돼 있으며 백그라운드 작업이 실행 중인 것은 아니다.

## 현재 확인 범위

| 범위 | 실제 확인 | 남은 경계 |
|---|---|---|
| 홈 카테고리 | 공개 `category-list` JSON 200, 메뉴 노드 3,228개 | 메뉴 수는 상품 목록 수가 아니다 |
| 일반 상품 검색 | `무선 마우스` 결과, 낮은가격순, 무료배송을 UI로 확인; Fetch 200 `text/x-component` 관측 | RSC 본문·완전한 입력값 미확보. 별도 Document 클라이언트의 실제 익명 요청은 403 |
| 일반 카테고리 | 가전디지털 목록과 다음 링크로 2페이지 UI 확인 | 익명 Document GET 403. 저장된 `coupang-search`/`coupang-consumer` 공급자 없음; 인증 세션을 사용한 재현은 미검증 |
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
| 일반 검색 RSC Fetch | 메타데이터만; 필수 입력·본문 미완료 | false | 해당 없음 | 미검증 | false |
| 일반 검색/카테고리 Document | 현재 요청/응답 쌍 미확보 | true | true | 익명, 해당 없음 | false, 403 |
| 트래블 category Document 계열 | true | true | true | 익명, 해당 없음 | true, 처리한 자원만 |
| 트래블 home/detail Document | 현재 요청/응답 쌍 미확보 | true | true | 익명, 해당 없음 | true, 처리한 자원만 |
| 트래블 autocomplete/search/rooms/ticket-options/reviews JSON | true | true | true | 익명, 해당 없음 | true, 기록된 입력만 |
| 렌터카 전체 보험 옵션, 항공 iframe | false | false | 해당 없음 | 미검증 | false |

`remnant_free` 범위는 반복 HTTP 읽기 전체다. 최초 UI 발견은 별개다. 초기 라이브 receipt 일부는 후속 메타데이터 보완 전 생성됐으며, verifier의 파일 해시는 **검증 시점 코드**를 나타낸다. 과거 요청이 전부 동일한 최종 코드로 실행됐다고 주장하지 않는다.

## 증거와 온톨로지 출력

```powershell
node --test tests/coupang-public.test.mjs tests/coupang-frontier.test.mjs
npm run coupang:verify
```

`scripts/verify-coupang-public.mjs`는 저장된 응답의 상태·스키마·공개 데이터 해시, 실패 receipt, 인증/방문자 식별값 누출 여부를 검사한다. 검증 자체는 오프라인이다. 대표 성공 계약 9개와 실제 crawl receipt를 대조하며 당시의 live GET/POST 증거를 새 네트워크 검사로 표현하지 않는다.

- [검증 결과](../verification/coupang-discovery-2026-10-15/verification.json)
- [브라우저 관측](../verification/coupang-discovery-2026-10-15/browser-observations.json): 공개 URL·헤더 이름·필드 구조·요청/응답 상태만 저장
- [재개할 탐색 목록](../verification/coupang-discovery-2026-10-15/resource-frontier.json)
- [대표 온톨로지 투영](../verification/coupang-discovery-2026-10-15/ontology-projections.json), [수집 receipt별 JSONL](../verification/coupang-discovery-2026-10-15/ontology-crawl-projections.jsonl)
- [렌터카 옵션 화면](../verification/coupang-discovery-2026-10-15/travel-rental-options.jpg)

`projectCoupangTravel`은 `productId`, package ID, vendor item ID를 구분하고 가격마다 날짜·인원·회원 조건·증거 해시를 붙인다. public 가격이 없는 경우 0원으로 채우지 않는다. 데이터베이스 반영은 수행하지 않았으며 `databaseWrites=0`이다. 원시 응답의 session/search tracking, access pass, booking block, 사용자 신원은 출력에서 제외한다.
