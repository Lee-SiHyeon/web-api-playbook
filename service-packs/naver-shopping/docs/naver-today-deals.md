# 네이버 오늘끝딜

기존 affiliate-content-operations PR #11의 오늘끝딜 수집기를 분리한 독립 HTTP 클라이언트입니다. 쇼핑블록 promotion 피드와는 다른 소스입니다.

```bash
# Node.js 24 이상, 저장소 루트
npm ci
npm run --silent naver:deals
npm run --silent naver:deals -- --output evidence/today-deals.json
npm run --silent naver:deals -- --max-pages 5 --max-requests 20
```

JavaScript에서는 `import { collectTodayDeals } from './adapters/naver-shopping-deals.mjs'` 후 `await collectTodayDeals()`를 호출합니다.

## 수집 범위

- GET https://shopping.naver.com/promotion의 HTML `__NEXT_DATA__`에서 기본 행사 레이아웃 ID와 기간을 읽습니다.
- GET https://vertical-api.shopping.naver.com/v1/waffle-maker/layouts/{layoutId}/auto-sort-products 에서 실제 상품 목록을 가져옵니다. 응답의 `hasNext`가 false가 될 때까지 페이지를 읽습니다.
- 레이아웃별 최대 30페이지, 전체 최대 100요청, 요청별 20초 및 응답 4 MiB 상한이 있습니다. 기본 네이티브 HTTP 호출 간 1초 간격을 둡니다.
- 할인 전 표시 가격 `salePrice`, 할인 표시 가격 `discountedPrice`, 표시 할인율 `displayDiscountPercent`, 배송 조건 및 행사 종료 시간을 반환합니다. `listed_active`, `upcoming`, `sold_out`, `expired`, `end_unknown`을 구분합니다.
- `complete: false`는 페이지·요청 상한으로 수집이 끝난 경우입니다. CLI 종료 코드는 완료 0, 호출 실패 1, 부분 수집 2입니다.
- 브라우저, 로그인 쿠키, 프록시, SDK 토큰, 자동 재시도는 실행 경로에 포함하지 않습니다. 418/429는 오류로 반환합니다. search.shopping.naver.com의 삭제된 전용 검색 기능은 포함하지 않습니다.

## 확인 범위와 가격 의미

2026-09-30 10:50 KST 기본 스페셜딜 레이아웃에서 4페이지 70개 상품을 실제 독립 HTTP로 수집했습니다. 당시 판매 중 표시 66개, 품절 4개였으며 각 요청은 HTTP 200이었습니다. 행사·상품·가격은 시간이 지나면 바뀝니다.

표시 할인율은 사이트가 제공한 값입니다. 실제 결제 금액, 회원·카드·쿠폰 적용 가능 여부, 과거 최저가, 전체 시장 최저가를 검증한 것으로 표시하지 않습니다. 다른 행사 탭의 전체 탐색, 키워드 검색, 리뷰 본문, 상품 상세 조회는 이 수집기 범위 밖입니다.

[원본 커밋·계약](../references/naver-today-deals-contracts.json) · [독립 HTTP 조회 기록](../references/naver-today-deals-read-20260930.json)

## 여행 특가와 구분

오늘끝딜의 기본 행사 상품 목록에 대해 여행 전용 카테고리나 여행 할인 조건을 검증한 상태는 아닙니다. 조회 기록의 제목 키워드 후보 수는 분류 근거가 아니며 여행 상품의 전체 존재 여부를 판단하지 않습니다.

현재 여행 클라이언트는 국내 투어·호텔 피드의 시작 가격과 항공 카드 혜택 메타정보를 제공합니다. 기간 한정 여행 특가 여부나 할인 기준 가격의 타당성을 확인한 전용 여행 핫딜 수집기는 아직 없습니다. 기존 PR #11의 2026-09-21 항공사 특가 조사자료는 별도의 조사 이력이며 당시 행사 기간이 현재 유효하다고 주장하지 않습니다.
