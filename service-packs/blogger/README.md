# Blogger pack (Google Blogger)

Node 24. 저장소 루트 의존성만 사용합니다(`lib/write-journal.mjs`). 추가 npm 의존성 없음.

## Transport 선택

| Transport | 인증 | 범위 | 상태 |
|---|---|---|---|
| `web` (기본) | 박스 Chrome 로그인 세션 쿠키 → `www.blogger.com`에만 전송 | 블로그 목록, 글 목록(상태·라벨·조회수·댓글수), 글 메타, 대시보드 조회수 합계 | 2026-10-14 캡처 + pure HTTP 라이브 read 검증 |
| `feed` | 없음 (공개) | 공개된 글 본문 get/list (`*.blogspot.com/feeds/posts/default`) | 라이브 read 검증 |
| `api` | 공식 Blogger API v3 OAuth bearer → `www.googleapis.com`에만 전송 | list/get/pageviews + **쓰기(create-draft/publish/update)** | 코드·mock 테스트만. 박스에 OAuth client/token 없음 → 라이브 미검증 |

**쓰기는 공식 API만 사용합니다.** 대시보드 웹 쓰기(batchexecute rpcid)는 실제 글을 만들어야 관측 가능하므로 캡처하지 않았고, 추측한 payload로 구현하지 않았습니다. 공식 API는 버전 고정·문서화돼 있어 rpcid/`bl` 빌드 라벨 변경에 영향받지 않습니다. 웹 경로는 쿠키만으로 OAuth 설정 없이 바로 읽기가 되는 장점이 있습니다.

## 세션 / 토큰 (git 밖, 0600)

- `npm run session:import` : 이미 로그인된 박스 Chrome의 DevTools(기본 `http://127.0.0.1:9225`, loopback만 허용)에서 `Storage.getCookies`로 google.com/blogger.com 쿠키만 가져와 `~/.config/web-api-playbook/blogger/session.json`(디렉터리 0700, 파일 0600)에 저장. 권한이 넓으면 로드 거부. 값은 출력하지 않고 이름만 출력.
- OAuth: `BLOGGER_OAUTH_ACCESS_TOKEN` 또는 `~/.config/web-api-playbook/blogger/oauth.json`(0600; `access_token` 또는 `refresh_token`+`client_id`+`client_secret`). scope `https://www.googleapis.com/auth/blogger`.
- `BLOGGER_STATE_DIR`로 위치 변경 가능.

## CLI

```
node scripts/cli.mjs list-blogs  --blog=<seedBlogId>              # web
node scripts/cli.mjs list-posts  --blog=<id> [--transport=api --status=draft]
node scripts/cli.mjs get-post    --blog=<id> --post=<id>          # web 메타
node scripts/cli.mjs get-post    --transport=feed --blog-url=https://x.blogspot.com --post=<id>
node scripts/cli.mjs stats       --blog=<id> [--transport=api --range=30DAYS]
node scripts/cli.mjs create-draft --blog=<id> --file=post.json [--execute]
node scripts/cli.mjs publish      --blog=<id> --post=<id> [--execute]
node scripts/cli.mjs update       --blog=<id> --post=<id> --file=post.json [--execute]
```

`--execute` 없으면 dry-run 계획만 출력. 쓰기 순서: journal `reserve`(wx, 제목/본문은 sha256만) → 1회 전송 → `finish`.
- ACK → `acknowledged_requires_readback` (get-post로 readback 후 `journal.reconcile`)
- 4xx → `rejected`
- timeout/네트워크/5xx → `needs-reconciliation` (결과 불명; **자동 재시도 없음**, 같은 의도는 `WRITE_JOURNAL_EXISTS`로 차단)

## Phase / 실행 모드

| Phase | 모드 |
|---|---|
| login acquisition | 박스 Chrome 기존 로그인(브라우저) → CDP 쿠키 import 1회 |
| request-input preparation | 없음 (web read는 쿠키만, `at` 토큰 불필요) |
| business request | `pure_http` |
| readback | `pure_http` (web / feed / api) |

## 다섯 상태 (2026-10-14)

| State | web read | feed read | api read | api write |
|---|---|---|---|---|
| captured | yes (posts dashboard HTML) | yes | not_applicable (공식 문서) | no |
| client_exists | yes | yes | yes | yes |
| credential_propagated | yes (owner blog 목록·글 11개 read) | not_applicable | unknown (토큰 없음) | unknown |
| remnant_free | yes (login phase 제외) | yes | yes | yes |
| live_replay | yes (read) | yes (read) | unknown | unknown — 사용자 승인 필요 |

## 한계

- `/blog/stats/:id` 대시보드 통계 데이터 출처 미식별; `stats`(web)는 글 목록의 글별 조회수/댓글수 합계(전체 기간 추정)만 제공.
- 글 목록 2페이지 이상 pagination 미관측(현재 11개 단일 페이지). `complete` 필드로 표시.
- 세션 쿠키 갱신(rotation) 미구현: 만료 시 `BLOGGER_AUTH_EXPIRED` → 다시 `session:import`.
- 중복: `affiliate-content-operations/apps/blogger-api`는 2026-10-02 기준 캡처 0건의 미완성 초안(Windows DPAPI 저장). 이 pack이 대체 후보이며 해당 레포는 변경하지 않았음.

계약 스냅샷: [contracts/blogger-contracts-2026-10-14.json](contracts/blogger-contracts-2026-10-14.json)
