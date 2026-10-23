# 페이지·커서·GraphQL·mtop 패턴

확인일: 2026-10-14. 목록 수집은 **종료 조건이 검증되기 전까지 완료로 주장하지 않는다.**

## 공통 규칙

- 페이지/커서/next token을 요청에 넣기 전에 스키마에 필드가 있는지 확인한다.
- `hasMore`·`nextPage`·빈 페이지·HTTP 404 중 **관측된** 종료 신호만 쓴다. 배열 길이가 pageSize보다 작다고 끝이라고 단정하지 않는다(마지막 페이지가 가득 찰 수 있음).
- 부분 수집은 영수증에 `complete:false`와 `stopReason`을 남긴다.
- 오프셋이 서버에서 불안정하면(검색 순위 변동) 중복 ID를 제거하고, 전체 카탈로그 완전성을 주장하지 않는다.

## 패턴

| 패턴 | 특징 | 이 저장소에서의 태도 |
|---|---|---|
| page / page_size | 1-based 또는 0-based | AliExpress Affiliate·여러 커머스 어댑터가 사용. 최대 page를 문서·응답으로 확인 |
| cursor / continuation | opaque token | 토큰을 로그에 장기로 저장하지 않는다. 만료 시 처음부터 |
| GraphQL + persisted query | Ulta 등 `/dxl/graphql` | HTML 부트스트랩으로 공개 키·sha256을 **현재** HTTP로 얻고 메모리에만 둔다. 키를 레포에 고정하지 않는다 |
| mtop / JSONP (AliExpress 등) | `sign`, appKey, t | **스토어프런트 mtop 서명은 역공학하지 않는다.** 공식 Affiliate sync API만 사용 |
| 링크 헤더 / sitemap | `Link: rel=next` | 있으면 따르고, 없으면 미구현으로 둔다 |

## 금지

- 종료 조건을 모른 채 page++ 무한 루프.
- 챌린지 페이지를 “빈 목록”으로 파싱.
- GraphQL introspection을 막아 둔 서비스에서 스키마를 추측해 mutation을 보내기.

## 관련

- [anti-bot-boundaries.md](anti-bot-boundaries.md)
- [rate-limit-backoff.md](rate-limit-backoff.md)
- [catalog-read-apis.md](catalog-read-apis.md)
