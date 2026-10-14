# Naver Blog API 구현

이 폴더는 독립 저장소의 로그인·통계·발행·미디어 구현입니다.

**설치와 실행은 [저장소 루트 README](../../README.md)를 따라 저장소 루트에서 진행하세요.** 루트의 `publisher:*` 명령이 Windows DPAPI에 저장된 인증을 이 앱으로 전달합니다. 이 폴더의 `npm run publisher:api`는 하위 CLI를 직접 호출하므로 루트 런처와 인증 동작이 다릅니다.

| 필요한 작업 | 문서 |
|---|---|
| 설치, 최초 로그인, 세션 재사용, 통계, 게시글 읽기 | [루트 사용법](../../README.md) |
| 이미지·MP4/WebM 업로드와 캡션 | [루트 미디어 사용법](../../README.md#5-이미지와-영상-업로드) |
| 신규 글 발행·기존 글 수정·대사 | [발행 가이드](../../docs/publishing-usage.md) |
| 동적 글 품질 계획과 리뷰 | [adaptive AI 설계](../../docs/adaptive-blog-publishing.md) |
| 원본 반입 범위·추가 도구 의존성 | [통합본 설명](../../docs/current-implementation.md) |

코드는 `scripts/`, `workflows/`, `tools/discovery/`로 나뉩니다. 인증값과 실행 산출물은 Git에 포함하지 않습니다. 관측된 요청 계약은 `references/`에 있습니다.

이전 README의 로그인 미구현·공개 신규 발행 차단 설명과 테스트 횟수는 각 실행 당시 기록입니다. [정리 전 원본은 Git 이력](https://github.com/Lee-SiHyeon/naver-blog-api-only/blob/1455287ae5d988cd0af2e2f751e9bea16b63c599/apps/naver-blog-api/README.md)에 남아 있습니다.

## Consolidation (2026-10-14)

This pack is the single source of truth for Naver Blog HTTP code. Consumers vendor it with
`node scripts/vendor-pack.mjs --pack naver [--subdir apps/naver-blog-api] --dest <consumer>`.
Ported from affiliate-content-operations/apps/naver-blog-api (2026-10-05): session lock and reuse,
handoff options/persistence, relogin cooldown, HTTP session rotation persistence, login HTTP handoff
utilities, the reworked session client/vault/health/login CLI, DataLab trend web + Exploding Topics
trend-radar sources, and the stat client guard that refuses to persist a rotation which deletes
NID_AUT/NID_SES (`tests/client-auth-rotation.test.mjs`).
