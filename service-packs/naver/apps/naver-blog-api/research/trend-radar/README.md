# API-only Trend Radar

## 소스 지도

| 소스 | 역할 | 실행 방식 |
|---|---|---|
| Naver DataLab Shopping Insight | 카테고리별 일·주·월 인기 쇼핑 검색어 | 관측 XHR을 독립 HTTP로 재생 |
| Naver Search autocomplete | 롱테일·구매 질문·문제 의도 확장 | 관측 JSONP를 독립 HTTP로 호출 |
| Google Trends RSS | 대한민국 현재 급상승 검색어 | 공개 RSS 직접 호출 |
| Exploding Topics | 해외(주로 미국)에서 막 뜨는 주제·제품의 검색량·증가율 (국내 유입 전 신호) | 공개 `/topic` 목록 HTML 직접 호출, `--no-exploding`으로 끔 |
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

## 해석

- Shopping Insight는 **쇼핑 클릭 인기 순위** 신호다. 절대 검색량이 아니다.
- 자동완성은 **함께 검색하는 표현** 신호다. 검색량이 아니다.
- Google RSS는 **급상승 이슈** 신호다. 상품 수익성과는 별개다.
- 최종 소재는 트렌드, 콘텐츠 경쟁, 커뮤니티 문제, 상품 수익성을 합쳐 결정한다.
