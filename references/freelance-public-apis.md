# 공개 프리랜서 마켓플레이스 읽기

현재 공통 `freelance-public` 서비스는 크몽·숨고의 제한된 공개 서비스 읽기와 Upwork의 승인 토큰 기반 공식 GraphQL 리더를 제공합니다. 서비스 목록이 이 공통 리더에 연결된 것은 각 계정 기능, 견적 생성, 거래 쓰기가 모두 구현됐다는 뜻이 아닙니다.

## 빠른 시작

```bash
node scripts/freelance.mjs kmong home
node scripts/freelance.mjs kmong categories
node scripts/freelance.mjs kmong search --keyword=로고 --page=1
node scripts/freelance.mjs kmong detail --id=705123
node scripts/freelance.mjs kmong reviews --id=705123 --page=1
node scripts/freelance.mjs soomgo categories
node scripts/freelance.mjs soomgo subcategories --category-1=이사-청소A
node scripts/freelance.mjs soomgo search --category-1=이사-청소A --category-2=이사A --limit=5
node scripts/jobs.mjs upwork search --credentials-stdin --query="web developer"
```

The sample Kmong gig ID and category slugs are examples: use a visible gig ID or the category slug returned by the preceding read. Kmong keyword search reads one page of 40 results. Its first-party bundle and `dynamic-env.js` supply the route configuration; pagination is not automatically walked. Each returned price is only a seller-displayed starting amount, not a confirmed purchase amount. Upwork expects a tagged hidden-stdin JSON object such as `{ "provider": "upwork", "accessToken": "..." }` from the caller's approved app; do not put the key in arguments or a URL. The client does not complete OAuth or request approval.

## 크몽

`createKmongClient()`는 홈페이지에서 확인한 링크로 제한된 서비스 목록과 카테고리를 읽고, 첫-party bundle에서 확인한 keyword-search 계약으로 한 페이지(40건)를 읽으며, 호출자가 정확한 `/gig/{id}`를 지정하면 해당 상세 페이지의 판매자 표시 정보와 Standard·Deluxe·Premium 패키지 가격을 반환합니다. 가격은 페이지에 표시된 값이며 최종 결제액·부가서비스 포함 여부를 검증하지 않습니다. 리뷰 요청 주소는 해당 상세 문서에 삽입된 값을 대상으로 하고, 한 번의 실행에서 요청한 페이지(현재 5개)만 반환합니다. 응답의 전체 리뷰 수가 있더라도 전체 리뷰 수집을 의미하지 않습니다.

검색 페이지 링크를 먼저 확인하지 않은 임의 ID를 발견·수집하는 API, 검색은 `GET /gig-app/gig/v2/gigs/search`의 1페이지 결과이며, 40건이라는 page-size와 검색 결과를 전부 읽었다는 주장을 혼동하지 않습니다. 검색/상세 응답 URL이 실제 서비스에 제공되지 않으면 slug를 만들지 않습니다. 판매자 메시지, 견적, 주문, 결제, 서비스 등록·수정은 구현 범위가 아닙니다. 링크·상품 소개 문서 및 공개 응답은 각각 `first_party_document` 또는 관측한 응답 계약으로 표시하고, 이를 XHR 캡처나 공개 공식 API라고 부르지 않습니다. 크몽은 가이드에서 상품·전문가 정보 스크래핑을 금지한다고 안내합니다. 현재 이용 목적이 그 조건에 부합한다고 검증되지 않았으므로 저장소의 공개 읽기 구현과 성공한 HTTP 실측은 기술적 계약 증거이며, 배포·반복 운용 권한의 증거가 아닙니다. [크몽 이용 안내](https://kmong.com/article/709--%ED%81%AC%EB%AA%BD-%EA%B0%80%EC%9D%B4%EB%93%9C-%7C-%ED%81%AC%EB%AA%BD-%EC%84%9C%EB%B9%84%EC%8A%A4-%EC%9D%B4%EC%9A%A9-%EB%B0%A9%EB%B2%95) · [고객센터 약관](https://kmong.com/support/customer-center/posts/179)

## 숨고

사용 가능한 CLI 필터는 `--category-1`, `--category-2`, `--service-slug`, `--address1`, `--address2`, `--keyword`, `--sort`, `--cursor`, `--limit`입니다. 컬렉션은 `--max-pages`로 상한을 둡니다.

클라이언트에서 사용한 `api.soomgo.com` 계약은 배포된 자사 JS 번들 SHA-256으로 식별합니다. 상위/하위 카테고리와 서비스 목록을 읽은 뒤, 그 응답에서 받은 서비스 slug와 지역·정렬 조건으로 공개 전문가 요약 검색을 합니다. 검색 결과에는 전체 개수와 이어받을 cursor가 있을 수 있습니다. 수집은 작은 페이지 수로 제한되며 미완료 cursor가 남으면 `complete=false`입니다. 서비스 견적·요청, 사용자 연락처, 메시지, 예약·결제는 실행하지 않습니다. 이 API 계약은 공급자의 일반 공개 API 문서가 아니며 first-party bundle 관측에 근거합니다. 프로필 상세 경로는 별도 정확한 read contract와 신원 바인딩을 확인하기 전까지 읽기 기능으로 가정하지 않습니다.

## Upwork

`createUpworkClient()`는 Marketplace Job Postings 공식 GraphQL의 검색·상세 조회 계약을 사용합니다. CLI는 `jobs upwork search|detail|collect` 또는 `freelance upwork search|detail|collect --credentials-stdin` 경로를 받습니다. 호출자는 자신의 승인된 OAuth API access token을 메모리에서 공급해야 합니다. 이 저장소는 OAuth 등록, 키 발급, 승인 절차 또는 API 호출을 수행하지 않았으므로 Upwork 기능 상태는 `pending_live`입니다. 테스트는 요청 형태·응답 스키마 검증이며 실 계정 권한이나 현재 API 응답의 증거가 아닙니다. 지원 제출, 후보자 계정, 메시지, 제안서 생성은 범위 밖입니다. [공식 GraphQL 문서](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html) · [자동화 안내](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly)

## 기록·보호 범위

프리랜서 서비스 정보는 공개된 단일 페이지의 결과로 제한합니다. 리뷰의 이름·연락처·주문 식별자 같은 개인정보는 표준화 결과에 싣지 않습니다. 화면에 표시된 시작가·패키지 가격·견적형 가격은 서로 다른 값입니다. 공급자 응답이 최종 가격을 확정하지 않으면 결제 총액으로 취급하지 않습니다. [기록된 실행과 코드 해시](../verification/jobs-freelance-2026-10-23/README.md)는 크몽 검색·상세·리뷰와 숨고 카테고리·두 페이지 전문가 검색을 연결합니다. `npm run verify:jobs-freelance`는 이 날짜의 기록을 오프라인 재검증하며, 현재 원격 상태를 다시 조회하지 않습니다.

Fiverr와 LinkedIn은 이번 변경에서 서비스 클라이언트를 만들지 않았습니다. Fiverr의 약관과 LinkedIn의 자동화 제한에 대한 조사만 진행했으며, 이번에 구현한 프리랜서·채용 공고 읽기와 동일한 허가를 가정하지 않습니다.
