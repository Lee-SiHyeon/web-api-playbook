# 세션 경험 색인

원문 대화·계정 비밀을 통째로 복사하는 대신, 재사용할 수 있는 **증상 → 관측 → 수정 → 결과 → 남은 경계**로 정리했습니다. 과거에 관측된 결과이며 이 저장소 배포 때 모든 사이트를 다시 호출한 것은 아닙니다.

| 문제/질문 | 먼저 읽을 곳 | 구현 |
|---|---|---|
| 로그인됐는데 `AUTH_MISSING` | [전달 경계](../references/runtime-credential-propagation.md), [Naver](naver.md) | `scripts/session.mjs`, `scripts/request.mjs`, pack별 provider |
| 쿠키·토큰 저장/회전/재시작 | [런타임 모듈](../references/runtime-modules.md), [로그인 단계](../references/browserless-login-flow.md) | `lib/protected-store.mjs`, `lib/scoped-session.mjs`, pack session vault |
| CDP port는 열렸는데 attach timeout | [브라우저 발견](../references/browser-discovery.md), [Naver](naver.md) | 실행 host/provider의 supported attach, 기존 saved session reuse |
| POST가 끊겨 중복 게시 우려 | [쓰기와 대사](../references/write-and-reconcile.md), [Tistory 사례](non-naver.md) | `lib/write-journal.mjs`, pack별 publishing journal |
| 링크/iframe 수를 API 수로 혼동 | [재귀 탐색](../references/recursive-discovery.md) | `lib/contracts.mjs`, `lib/frontier.mjs` |
| 소스에서 찾은 endpoint가 호출 실패 | [서비스 사례](non-naver.md), [Coupang](coupang.md) | affiliate 관측/후보 catalog, X contract discovery |
| 이미지 403, 첨부만 있고 재생 안 됨 | [미디어](../references/media-and-publishing.md) | Tistory media library, Naver upload/reconcile |
| 다른 PC에서 JSON 한글/DPAPI 실패 | [이식 안내](../references/portability.md) | `scripts/dpapi-store.ps1`, `scripts/doctor.mjs` |

전체 과거 세션의 완전한 아카이브는 아닙니다. 현재 접근할 수 있는 관련 구현·계약·증거에서 추출한 사례이며, 소스가 없거나 인증/재현을 확인하지 못한 부분은 미확인으로 남깁니다.
