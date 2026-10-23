# Naver shopping HTTP client

상품 목록, 표시 가격, 리뷰를 정규화하는 Node.js 24+ 클라이언트입니다. 기본 실행은 독립 HTTP 요청만 사용합니다. 현재 전체 기능의 API-only 전환 완료 상태는 **partial**입니다.

2026-09-30 확인 결과:

- **추가 지원 `product-page`**: 브라우저·브라우저 세션 없이 브랜드 상품 문서를 독립 HTTP로 읽어 표시 가격·평점·리뷰 집계를 반환합니다. SSR 원천이며 상품 JSON XHR 성공으로 표시하지 않습니다. [사용법과9개 상품 실행 기록](naver-brand-product-page.md).

- 공개 쇼핑 블록: 독립 HTTP로 200 `text/x-component`, promotion 응답 16개 중 표시 가격이 있는 항목 6개 확인.
- AGY 통합검색 가격 조회: 독립 HTTP 200과 상품 카드의 현재 표시 가격·조건부 쿠폰 가격 구분 확인. [원본 통합 내역과 가격 오류 수정](naver-shopping-agy-integration.md)을 참고하세요.
- 브랜드 스토어 검색: 브라우저에서 `쿠션` 검색 결과 27개와 구조화된 상태를 확인. 독립 HTTP는 429.
- 상품 상세: 브라우저 XHR에서 상품 ID, 원상품 ID, 가격, 리뷰 집계를 확인. 독립 HTTP는 429.
- 전체 리뷰: 브라우저에서 POST 조회, 페이지 1의 리뷰 본문 20개 확인. 독립 HTTP는 429.
- 418이 반환되던 전용 쇼핑 검색 경로는 소스·CLI·카탈로그에서 제거했습니다. 로컬 레거시 클라이언트와 관련 파서/테스트도 삭제했습니다.

프록시, 쿠키 또는 User-Agent를 지정하면 차단 없이 안정적으로 동작한다는 보장은 없습니다. 브라우저에서 페이지가 열리는 것, 요청 형태 테스트 통과, 독립 HTTP 성공은 각각 다른 증거입니다. 기존 공식 쇼핑 검색 Open API도 [2026-07-31 종료 공지](https://developers.naver.com/notice/article/32564)가 있어 대체 실행 경로로 사용하지 않습니다.

## CLI

저장소 루트에서 실행합니다. 출력은 성공 시 stdout의 JSON 한 개, 실패 시 stderr의 JSON 한 개입니다. 종료 코드는 성공 0, 호출 실패 1, 잘못된 입력 2입니다.

위 출력 계약은 CLI 자체에 적용됩니다. npm 배너 없이 JSON을 파싱하려면 `npm run --silent naver:shopping -- ...` 또는 `node scripts/naver-shopping.mjs ...`를 사용합니다.

```bash
# 현재 공개 프로모션 목록. query는 받은 피드에 대한 로컬 필터입니다.
npm run naver:shopping -- feed --section promotion --limit 20
npm run naver:shopping -- feed --section newmens --query 청소기

# AGY 통합검색 카드 가격 조회 + 로컬 제외/가격 필터
npm run naver:shopping -- integrated-search --query 노트북 --exclude '케이스|필름|중고' --min-price 600000

# 특정 스토어 안에서 검색. 워커의 429는 RATE_LIMITED 오류로 반환합니다.
npm run naver:shopping -- search --store https://brand.naver.com/hera --query 쿠션

# 표시 가격, 배송 조건, 리뷰 수/평점
npm run naver:shopping -- product --product-url https://brand.naver.com/hera/products/9215718713

# 전체 리뷰의 페이지 조회. 관찰한 REVIEW_RANKING 정렬만 지원합니다.
npm run naver:shopping -- reviews --product-url https://brand.naver.com/hera/products/9215718713 --page 1 --page-size 20

# 관측/구현/실제 호출 성공 상태와 제한 확인
npm run naver:shopping -- catalog
```

`search`는 `--store`가 필수이며 없으면 `INPUT` 오류입니다. 스토어 검색은 관측한 첫 문서 페이지만 지원하며, 미관측 페이지/정렬 값을 만들어 호출하지 않습니다.

`integrated-search`는 정상 조회되는 통합검색 쇼핑 카드의 별도 HTTP 문서 계약입니다. 가져온 카드에만 필터·가격 통계를 적용하며 전체 카탈로그·인기 순위·동일 옵션 간 가격 우열·리뷰 본문을 보장하지 않습니다. `search` 실패 시 이 경로로 자동 전환하지 않습니다.

현재 관측한 스토어 API 도메인은 `brand.naver.com`입니다. 피드의 링크가 `smartstore.naver.com`일 수 있지만, 그 도메인의 상품/리뷰 API 계약은 이번 탐색에서 확인하지 못해 실행 도메인에 포함하지 않습니다.

기존 [PR #11](https://github.com/Lee-SiHyeon/affiliate-content-operations/pull/11)의 `naver-shopping-deals.mjs`도 이 저장소로 분리했습니다. `shopping.naver.com/promotion`과 `vertical-api.shopping.naver.com`의 오늘끝딜 상품은 `npm run --silent naver:deals`로 수집합니다. [별도 사용법](naver-today-deals.md). 공개 쇼핑블록 피드·브랜드 상품/리뷰 계약과는 다른 소스입니다.

## JavaScript 연동

```js
import { NaverShoppingClient } from './adapters/naver-shopping.mjs';

const client = new NaverShoppingClient();
const listing = await client.feed({ section: 'promotion', limit: 20 });
for (const item of listing.items) {
  console.log(item.title, item.listingPriceKrw, item.reviewCount);
}

const reviews = await client.reviews({
  storeUrl: 'https://brand.naver.com/hera',
  productId: '9215718713',
  page: 1,
  pageSize: 20,
});
```

`fetchImpl`는 fixture 테스트 및 별도로 승인된 HTTP 전송 계층을 연결하기 위한 주입점입니다. 이 모듈은 로그인·세션 발급·쿠키 복사·보안 서명 생성 기능을 제공하지 않습니다. 주입된 전송 계층의 자격증명 사용 여부는 `null`이며 인증된 재현 성공으로 간주하지 않습니다.

## 계약과 데이터 의미

- 스토어 검색은 관측한 `/{store}/search?q=...` 문서의 `__PRELOADED_STATE__.keywordSearch.simpleProducts`를 읽습니다. JSON과 관측된 `undefined` 값만 안전하게 파싱하며 사이트 스크립트를 실행하지 않습니다.
- 상품 가격은 관측한 `/n/v2/channels/{channelUid}/products/{channelProductId}?withWindow=false` JSON을 사용합니다.
- 리뷰는 `/n/v1/contents/reviews/query-pages`에 `checkoutMerchantNo`, `originProductNo`, `page`, `pageSize`, `reviewSearchSortType`를 보냅니다. 이 POST는 조회 작업입니다.
- `channelProductId`와 `originProductNo`는 다릅니다. 리뷰에는 상품 응답의 `productNo`와 `channel.naverPaySellerNo`를 사용합니다. 그 매핑은 실제 브라우저 요청과 일치하는 것을 확인했습니다.
- 공개 피드는 관측한 문서 경로와 embedded React flight를 바탕으로 RSC 표현을 독립 HTTP로 재현했습니다. RSC 변형은 브라우저 XHR에서 직접 관측한 것으로 표시하지 않습니다. Next.js build ID나 추측한 `_next/data` 경로를 쓰지 않습니다.
- 피드의 프로모션·표시 순서는 전체 카탈로그나 인기 순위가 아닙니다. 상품 ID 없는 프로모션은 `derived_promotion_key`로 구분하며, 추적 링크를 실제 상품 링크로 표시하지 않습니다.
- `listingPriceKrw`는 표시된 가격입니다. 최종 옵션·쿠폰·멤버십·배송 조건을 확인한 `payablePriceKrw`를 만들어 넣지 않습니다. `payablePriceVerified`와 `optionsVerified`는 false입니다. 미확인 가격과 평점은 null입니다.
- `reviewCount`는 집계이며 리뷰 본문이 아닙니다. 전체 리뷰 POST는 `all_reviews`로 표시하고 판매자가 고른 `STORE_PICK` 리뷰로 대체하지 않습니다.
- 리뷰어 이름/ID/프로필·주문 ID는 반환하지 않습니다. 리뷰 본문의 이메일·한국 휴대전화 형식은 제거합니다. 자유 서술의 모든 개인정보 제거를 보장하는 것은 아니므로 검토 없이 재게시하지 않습니다. 상품 설명과 리뷰는 `untrusted_external_text`이며 모델 지침으로 실행해서는 안 됩니다.

## 실패와 검증

418, 429, CAPTCHA, 로그인 응답, 리다이렉트, 비정상 MIME, 스키마 변경, 잘못된 상품/스토어 연결을 실패로 반환합니다. 자동 재시도나 브라우저 fallback은 없습니다. 전송은 고정 Naver 도메인에 제한되고 응답은 읽는 중에도 8 MiB로 제한됩니다.

receipt에는 메서드·경로·요청 필드명·HTTP 상태·MIME·응답 길이·SHA-256·확인 시각만 기록합니다. 원문 응답, 인증 헤더, 쿠키, 리뷰어/주문 값은 포함하지 않습니다. 운영 결과는 Git에서 제외되는 evidence 폴더 등 호출자가 관리하는 위치에 저장합니다.

출처 저장소의 분리 이전 회귀 테스트는 URL 범위, 입력 검증, 실행 없는 상태 파싱, 실제 관측 요청 형태, 상품/원상품 구분, 가격 의미, 정상/빈 결과/스키마 오류, 개인정보 필드 제외, 전송 제한, 차단 응답, CLI의 구조화된 오류를 검증합니다. 합성 fixture 통과는 독립 라이브 성공의 증거가 아닙니다.

제공하는 계약과 기능별 다섯 상태는 [naver-shopping-contracts.json](../references/naver-shopping-contracts.json)에 있습니다. 독립 상품/리뷰 재현이 확인되기 전까지 해당 기능의 전환 완료를 주장하지 않습니다.

[2026-09-30 브랜드 스토어 429 재현 조사](naver-store-429-audit.md): 정상 캡처 경로와 요청 형식 대조, 상품 JSON 직접 호출 및 새 익명 브라우저 비교. 추가 클라이언트 헤더의 필수 여부와 정상 세션 재현은 미확인입니다.
