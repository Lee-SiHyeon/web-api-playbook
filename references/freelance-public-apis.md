# 공개 프리랜서 마켓플레이스 읽기

현재 공통 `freelance-public` 서비스는 크몽·숨고의 제한된 공개 서비스 읽기와 Upwork의 승인 토큰 기반 공식 GraphQL 리더를 제공합니다. 서비스 목록이 이 공통 리더에 연결된 것은 각 계정 기능, 견적 생성, 거래 쓰기가 모두 구현됐다는 뜻이 아닙니다.

## 빠른 시작

```bash
node scripts/freelance.mjs kmong home
node scripts/freelance.mjs kmong categories
node scripts/freelance.mjs kmong search --keyword=로고 --page=1
node scripts/freelance.mjs kmong detail --id=705123
node scripts/freelance.mjs kmong reviews --id=705123 --page=1
# bounded collection; fresh live replay is tracked separately
node scripts/freelance.mjs kmong search-collect --keyword=번역 --max-pages=1 --output=work/kmong-search.json
node scripts/freelance.mjs kmong reviews-collect --id=466087 --max-pages=1 --output=work/kmong-reviews.json
# resume the matching collection with its previous full result or state JSON
node scripts/freelance.mjs kmong search-collect --keyword=번역 --max-pages=1 --input=work/kmong-search.json --output=work/kmong-search-resumed.json
node scripts/freelance.mjs soomgo categories
node scripts/freelance.mjs soomgo subcategories --category-1=이사-청소A
node scripts/freelance.mjs soomgo search --category-1=이사-청소A --category-2=이사A --limit=5
node scripts/jobs.mjs upwork search --credentials-stdin --query="web developer"
```

The sample Kmong gig ID and category slugs are examples: use a visible gig ID or the category slug returned by the preceding read. The `search` operation reads one page of 40 results; `search-collect` walks up to five pages per call and can resume from a matching checkpoint. This still does not claim a complete marketplace catalogue. The first-party bundle and `dynamic-env.js` supply the route configuration. Each returned search price is only a seller-displayed starting amount, not a confirmed purchase amount. Upwork expects a tagged hidden-stdin JSON object such as `{ "provider": "upwork", "accessToken": "..." }` from the caller's approved app; do not put the key in arguments or a URL. The client does not complete OAuth or request approval.

## 크몽

로그인한 본인의 계정 조회와 Windows 암호화 세션 재사용은 별도 [인증 가이드](kmong-auth.md)의 `scripts/kmong-account.mjs`를 사용합니다. 아래 명령은 공개 조회용입니다.

`createKmongClient()`는 홈페이지에서 확인한 링크로 제한된 서비스 목록과 카테고리를 읽고, first-party bundle에서 확인한 keyword-search 계약으로 한 페이지(40건)를 읽습니다. 호출자가 정확한 `/gig/{id}`를 지정하면 그 상세 페이지에 바인딩된 공개 가격 구조를 반환합니다. `gig.pricingType`은 `package_table`, `single_price_card`, `unknown` 중 하나입니다. 3단계 상품은 기존 `gig.packages` 목록을 유지하며 각 `packages[].price.basis`는 `listed_package_price`입니다. 단일 가격 카드에서는 실제 SSR 카드에 가격 문자가 없을 수 있으므로 화면 가격을 만들어 내지 않습니다. SKU가 일치하는 Product JSON-LD `AggregateOffer`가 있으면 `gig.pricing.priceRange`에 `aggregate_offer_range`와 KRW 통화를 보존하고, `aggregateOfferCount`는 별도 집계 필드로 둡니다. 범위의 최소·최대값이 같아도 최종 결제액 검증으로 바뀌지 않으며 `finalCheckoutAmountVerified`는 `false`입니다. 구조가 없거나 읽히지 않는 가격은 0원이나 가짜 패키지가 아니라 `null`/`unknown`으로 남습니다.

리뷰 조회는 가격 표 해석에 의존하지 않습니다. 정확한 `/gig/{id}` 응답의 Product SKU로 서비스를 바인딩하고, 응답에 삽입된 해당 ID의 first-party 리뷰 API 주소만 사용합니다. 상세 결과는 `reviewSourceAvailability`를 `observed` 또는 `not_observed`로 표시하며, 주소가 관측되지 않으면 `reviews` 요청은 `KMONG_REVIEW_LINK_NOT_OBSERVED`로 끝납니다. 한 번의 `reviews` 호출은 한 페이지(현재 5개), `reviews-collect`는 호출당 최대 5페이지를 읽습니다. 응답의 전체 리뷰 수가 있더라도 전체 리뷰 수집을 뜻하지 않습니다.

### 제한 수집과 재개

2026-10-26에 140.228에서 native CLI 15/15, common CLI 4/4를 검증했습니다. 검색은 3페이지·120개, 리뷰는 3페이지·15개까지 이어 읽었고, 다음 페이지가 남아 `partial`을 유지했습니다. 서비스 ID·응답 해시·코드 해시는 [검증 기록](../verification/jobs-freelance-2026-10-26/README.md)에 있습니다.

```bash
node scripts/freelance.mjs kmong search-collect --keyword=번역 --max-pages=1 --output=work/kmong-search.json
node scripts/freelance.mjs kmong reviews-collect --id=466087 --max-pages=1 --output=work/kmong-reviews.json

# 이전 결과의 다음 페이지부터 재개한다. 출력 파일은 새 경로를 사용한다.
node scripts/freelance.mjs kmong search-collect --keyword=번역 --max-pages=1 --input=work/kmong-search.json --output=work/kmong-search-next.json
node scripts/freelance.mjs kmong reviews-collect --id=466087 --max-pages=1 --input=work/kmong-reviews.json --output=work/kmong-reviews-next.json
```

호출당 `--max-pages`는 1~5, 기본값은 1입니다. 검색은 페이지당 40개, 리뷰는 5개를 읽습니다. 재개할 때 검색어 또는 gig ID를 다시 지정해야 하며 checkpoint의 `scope`와 다르면 요청 전에 거부합니다. native `--input`은 이전 native 결과 전체 또는 raw state JSON을 받습니다.

정상적으로 페이지 한도까지 읽으면 `status=partial`과 다음 페이지를 저장하고 종료 코드 0을 반환합니다. 공급자 HTTP/전송 오류나 중복·페이지 수 변동으로 중단하면 오류와 완료된 페이지의 checkpoint를 저장하며 종료 코드는 1입니다. `state.resumeAllowed=false`이면 재개할 수 없습니다. 사용자/MCP 취소나 프로세스 종료는 현재 호출의 checkpoint 반환을 보장하지 않으므로 이전 완료 출력 파일을 유지해야 합니다.

공통 operation `kmong-search-collect`는 `query:{keyword,maxPages}`를, `kmong-reviews-collect`는 `path:{id}`와 `query:{maxPages}`를 받습니다. 재개하려면 `body:{state}`에 raw state를 넣습니다. 성공 결과의 state는 `data.state`, 검증된 collection 오류의 state는 `partialResult.data.state`에 있습니다. common CLI는 오류도 `--output` 파일에 기록하고 종료 코드 1을 유지하며, MCP는 `isError:true`와 `structuredContent`로 반환합니다. 일반 오류의 임의 `receipt`는 출력하지 않습니다.

공통 실행기는 누적 검색 30페이지, 리뷰 100페이지에서 멈추고 `canResumeInCommonRegistry=false`를 표시합니다. `nativeCheckpointResumable=true`와 `state.resumeAllowed=true`이면 오류 envelope에서 `partialResult.data.state`만 JSON 파일로 추출하여 native `--input`으로 넘길 수 있습니다. common 오류 envelope 전체를 native 입력으로 사용하지 않습니다.

완료된 checkpoint만 읽은 결과는 `networkUsed=false`, `observedAt=null`, `checkpointProvenance=caller_supplied`입니다. 새 외부 조회를 뜻하지 않습니다. 검색은 원천 페이지 범위가 완결돼도 `completeCatalog=false`를 유지합니다. 리뷰 중복 판정은 점수·날짜·정제 본문 해시를 사용하며 공급자가 발급한 고유 리뷰 ID는 아닙니다.

리뷰 결과와 checkpoint에는 정제된 본문·판매자 답변이 들어갈 수 있습니다. 비공개 로컬 파일에 저장하고 Git에 추가하지 마세요. native CLI는 `--output` 사용 시 stdout에 요약만 남기며 기존 파일을 덮어쓰지 않습니다. common CLI 성공 출력과 MCP 응답에는 요청한 데이터가 포함됩니다. 저장소의 검증 자료에는 리뷰 전문 대신 해시만 기록합니다.

판매자 메시지, 견적, 주문, 결제, 서비스 등록·수정은 구현 범위가 아닙니다. 링크·상품 소개 문서 및 공개 응답은 각각 `first_party_document` 또는 관측한 응답 계약으로 표시하고, 이를 XHR 캡처나 공개 공식 API라고 부르지 않습니다. 크몽은 가이드에서 상품·전문가 정보 스크래핑을 금지한다고 안내합니다. 현재 이용 목적이 그 조건에 부합한다고 검증되지 않았으므로 저장소의 공개 읽기 구현과 성공한 HTTP 실측은 기술적 계약 증거이며, 배포·반복 운용 권한의 증거가 아닙니다. [크몽 이용 안내](https://kmong.com/article/709--%ED%81%AC%EB%AA%BD-%EA%B0%80%EC%9D%B4%EB%93%9C-%7C-%ED%81%AC%EB%AA%BD-%EC%84%9C%EB%B9%84%EC%8A%A4-%EC%9D%B4%EC%9A%A9-%EB%B0%A9%EB%B2%95) · [고객센터 약관](https://kmong.com/support/customer-center/posts/179)

## 숨고

사용 가능한 CLI 필터는 `--category-1`, `--category-2`, `--service-slug`, `--address1`, `--address2`, `--keyword`, `--sort`, `--cursor`, `--limit`입니다. 컬렉션은 `--max-pages`로 상한을 둡니다.

`api.soomgo.com` 공개 카테고리와 전문가 검색은 2026-10-26에 직접 재생됐습니다. 2026-10-27에는 140.228에서 native CLI 24/24, common CLI 5/5가 종료 코드 0으로 끝났습니다. 익명 프로필·폼·주소 조회와 Naver 로그인 후 소유자·요청·채팅 읽기를 확인했으며, portfolio walk는 선택 프로필의 20/20개를 3페이지에서 완료했고 review walk는 6개/2페이지로 부분 범위를 유지했습니다. 요청 준비는 로컬 전용이며 실제 서비스 요청, 견적 발송, 메시지, 예약·결제는 보내지 않았습니다. 세부 상태와 증거 경계는 [숨고 capability frontier](soomgo-frontier.md)와 [2026-10-27 실행 기록](../verification/jobs-freelance-2026-10-27/README.md)에 있습니다.

## Upwork

`createUpworkClient()`는 Marketplace Job Postings 공식 GraphQL의 검색·상세 조회 계약을 사용합니다. CLI는 `jobs upwork search|detail|collect` 또는 `freelance upwork search|detail|collect --credentials-stdin` 경로를 받습니다. 호출자는 자신의 승인된 OAuth API access token을 메모리에서 공급해야 합니다. 이 저장소는 OAuth 등록, 키 발급, 승인 절차 또는 API 호출을 수행하지 않았으므로 Upwork 기능 상태는 `pending_live`입니다. 테스트는 요청 형태·응답 스키마 검증이며 실 계정 권한이나 현재 API 응답의 증거가 아닙니다. 지원 제출, 후보자 계정, 메시지, 제안서 생성은 범위 밖입니다. [공식 GraphQL 문서](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html) · [자동화 안내](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly)

## 기록·보호 범위

프리랜서 서비스 정보는 호출자가 정한 작은 페이지 예산으로 제한합니다. 리뷰의 이름·연락처·주문 식별자 같은 개인정보는 표준화 결과에 싣지 않습니다. 화면에 표시된 시작가·패키지 가격·견적형 가격은 서로 다른 값입니다. 공급자 응답이 최종 가격을 확정하지 않으면 결제 총액으로 취급하지 않습니다. [2026-10-23 실행 기록](../verification/jobs-freelance-2026-10-23/README.md)은 이전 코드 해시의 역사 자료입니다. [2026-10-26 검증 기록](../verification/jobs-freelance-2026-10-26/README.md)은 이 날짜의 검증 범위를 기록합니다. 기본 `npm run verify:jobs-freelance`는 2026-10-27 manifest를 오프라인 재검증하며, 현재 원격 상태를 새로 조회하지 않습니다.

Fiverr와 LinkedIn은 이번 변경에서 서비스 클라이언트를 만들지 않았습니다. Fiverr의 약관과 LinkedIn의 자동화 제한에 대한 조사만 진행했으며, 이번에 구현한 프리랜서·채용 공고 읽기와 동일한 허가를 가정하지 않습니다.
