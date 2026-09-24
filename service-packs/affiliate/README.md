# Affiliate API service pack

마이리얼트립·애드픽·네이버 쇼핑·쿠팡 요청 분석과 올리브영 큐레이터 구현을 함께 사용할 수 있도록 원래 `apps/affiliate-api-hub` / `packages/contracts` 구조를 보존했습니다.

```powershell
cd service-packs/affiliate
npm ci --ignore-scripts
```

원래 프로젝트 전체를 설치할 필요는 없습니다. 이 pack의 루트 package와 lockfile이 포함된 두 workspace를 설치합니다.

## 사용법과 입력

| 기능 | pack 루트 명령 | 입력/계약 문서 |
|---|---|---|
| 파트너 보호 조회 | `npm run --silent partners:probe` | [계정 조회 계약](apps/affiliate-api-hub/references/partner-account-contracts.json), [로그인 경계](apps/affiliate-api-hub/docs/partner-login-http-2026-09-21.md) |
| MyRealTrip | `npm run --silent myrealtrip` | [API 사용법](apps/affiliate-api-hub/docs/myrealtrip-api-only-2026-09-21.md) |
| OliveYoung | `npm run --silent oliveyoung` | [사용법/미검증 경계](apps/affiliate-api-hub/docs/oliveyoung-api-only-2026-09-21.md) |
| 네이버 공개 오늘의 딜 | `npm run naver:today-deals -- <옵션>` | [관측 계약](apps/affiliate-api-hub/references/naver-shopping-observed-contracts-2026-09-21.json) |
| Adpick 공개 카탈로그 | `apps/affiliate-api-hub/tools/research/adpick-affiliate-catalog.mjs` | [과거 공개 replay](apps/affiliate-api-hub/references/adpick-public-malls-replay-2026-09-21.json) |
| Coupang 캡처 분석 | `apps/affiliate-api-hub/scripts/sanitize-coupang-netlog.mjs` 등 | [원래 허브 README](apps/affiliate-api-hub/README.md), [관측 기록](apps/affiliate-api-hub/docs/coupang-partners-api-discovery-2026-09-19.md) |

보호 조회 CLI는 fresh envelope JSON을 **stdin**으로 받습니다. shell에 실제 토큰을 직접 입력해 기록하지 말고 기존 보관함/provider에서 pipe로 전달하세요. 각 adapter의 envelope 계약이 다르므로 core session JSON을 그대로 보내지 않습니다.

원래 README와 개별 문서의 `node scripts/...` 명령은 `apps/affiliate-api-hub` 디렉터리 기준입니다. 위 표의 `npm run`은 이 pack 루트 기준입니다.

## 관측 범위

- MyRealTrip/파트너 read 계약과 Adpick 공개 HTML catalog의 과거 replay 기록을 보존했습니다.
- OliveYoung 파일들은 원본 worktree의 **미커밋 코드 스냅샷**입니다. 구현과 보호 인증 성공은 별개이며, 당시 403/미연동 경계를 그대로 남겼습니다.
- Coupang의 소스 문자열·요청 형태·관측 계약은 분리되어 있습니다. 소스 후보를 곧바로 재현 가능한 SDK operation으로 취급하지 않습니다.
- 개발자 공식 API와 웹 파트너 세션 API는 인증/가입 조건이 다릅니다.
- 별도 로그인 도구와 일부 캡처 스크립트는 Windows 전용입니다. 포터블한 공통 수집은 저장소 루트의 HAR/HTML 도구를 사용할 수 있습니다.

다른 OS에서 실행했다는 주장이나 사이트 전체 로그인 자동화 완료 주장은 이 스냅샷에 포함하지 않습니다.
