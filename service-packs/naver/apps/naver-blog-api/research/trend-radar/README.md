# API-only Trend Radar

## 소스 지도

| 소스 | 역할 | 실행 방식 |
|---|---|---|
| Naver DataLab Shopping Insight | 카테고리별 일·주·월 인기 쇼핑 검색어 | 익명 LCS bootstrap 후 rank XHR을 독립 HTTP로 재생; LCS 발급 세션 쿠키는 NNB 필수, BUC 선택 |
| Naver Search autocomplete | 롱테일·구매 질문·문제 의도 확장 | 관측 JSONP를 독립 HTTP로 호출 |
| Google Trends RSS | 대한민국 현재 급상승 검색어 | 공개 RSS 직접 호출 |
| Naver Search Trend Open API | 후보군 상대 검색 추이·성별·연령·기기 비교 | Client ID/Secret 설정 시 직접 호출 |
| Naver Blog search | 콘텐츠 공급과 상위 글 구조 | 기존 `topic_brief.py` 사용 |
| Coupang Partners | 실제 상품·가격·제휴 링크 | `affiliate-api-hub` 비교 파이프라인 사용 |

## 정상 실행

브라우저를 사용하지 않는다.

```powershell
cd <repo>\apps\naver-blog-api
npm run research:trends

# 관심 seed를 함께 확장
npm run research:trends -- --seed=보조배터리,신혼여행,수납장
```

## 출력

- `latest.json`: 후속 자동화 입력
- `latest.md`: 사람이 검토하는 요약
- `conversion-receipt.json`: XHR → API-only 5단계 상태
- `evidence/trend-radar-*.json`: 시점별 증거

## 익명 bootstrap과 범위

2026-10-15 16:37:43.804Z UTC의 fresh-process replay에서 LCS `GET /m`는 HTTP 200 `image/gif`를 반환하며 NNB와 BUC를 발급했다. 유지 client는 NNB만 세션 쿠키로 전달한다. Rank 요청에는 category selector인 `_datalab_cid`도 포함된다. category `50000003` / `date` 한 조합은 HTTP 200 `application/json;charset=UTF-8`로 검증됐고, 12개 기간에 각 10개 rank가 있었다. [현재 replay](../../../../../../verification/remaining-naver-insight-2026-10-16/ranking-replay.json)와 [별도 NNB/BUC A/B 기록](../../../../../../verification/remaining-naver-insight-2026-10-16/buc-ab-comparison-2026-10-15.json)을 참고한다. 다른 category/timeUnit 조합의 성공을 의미하지 않는다.

Bootstrap 또는 rank 요청이 실패하면 Shopping Insight 각 계약의 실패를 기록하고, 0건/빈 정상 결과로 바꾸지 않는다. `run.mjs`는 그 결과를 받아 다른 trend source를 계속 조회한다. 따라서 해당 실행은 부분 결과일 수 있으며 실패 상태를 함께 검토한다.

## 해석

- Shopping Insight는 **쇼핑 클릭 인기 순위** 신호다. 절대 검색량이 아니다.
- 자동완성은 **함께 검색하는 표현** 신호다. 검색량이 아니다.
- Google RSS는 **급상승 이슈** 신호다. 상품 수익성과는 별개다.
- 최종 소재는 트렌드, 콘텐츠 경쟁, 커뮤니티 문제, 상품 수익성을 합쳐 결정한다.
