# Affiliate API service pack

마이리얼트립·애드픽·네이버 쇼핑·쿠팡 요청 분석과 올리브영 큐레이터 구현을 함께 사용할 수 있도록 원래 `apps/affiliate-api-hub` / `packages/contracts` 구조를 보존했습니다.

```powershell
cd service-packs/affiliate
npm ci --ignore-scripts
```

원래 프로젝트 전체를 설치할 필요는 없습니다. 이 pack의 루트 package와 lockfile이 포함된 두 workspace를 설치합니다.

## 사용법과 입력

2026-09-24에 추가한 보호 저장·로그인·refresh 실행기는 저장소 루트의
[웹 로그인 사용법](../../references/web-login-usage.md)을 따른다.
루트에서 `node scripts/web-login.mjs myrealtrip ensure`를 실행하고,
업무 JSON을 `node scripts/myrealtrip.mjs` stdin으로 넘기면 session을 따로 입력하지 않는다.
아래 pack 원본 CLI의 직접 session envelope 경로도 보존되어 있다.

| 기능 | pack 루트 명령 | 입력/계약 문서 |
|---|---|---|
| 파트너 보호 조회 | `npm run --silent partners:probe` | [계정 조회 계약](apps/affiliate-api-hub/references/partner-account-contracts.json), [로그인 경계](apps/affiliate-api-hub/docs/partner-login-http-2026-09-21.md) |
| MyRealTrip | `npm run --silent myrealtrip` | [API 사용법](apps/affiliate-api-hub/docs/myrealtrip-api-only-2026-09-21.md) |
| OliveYoung | `npm run --silent oliveyoung` | [사용법/미검증 경계](apps/affiliate-api-hub/docs/oliveyoung-api-only-2026-09-21.md) |
| 네이버 공개 오늘의 딜 | `npm run naver:today-deals -- <옵션>` | [관측 계약](apps/affiliate-api-hub/references/naver-shopping-observed-contracts-2026-09-21.json) |
| Adpick 공개 카탈로그 | `apps/affiliate-api-hub/tools/research/adpick-affiliate-catalog.mjs` | [과거 공개 replay](apps/affiliate-api-hub/references/adpick-public-malls-replay-2026-09-21.json) |
| Coupang 캡처 분석 | `apps/affiliate-api-hub/scripts/sanitize-coupang-netlog.mjs` 등 | [원래 허브 README](apps/affiliate-api-hub/README.md), [관측 기록](apps/affiliate-api-hub/docs/coupang-partners-api-discovery-2026-09-19.md) |
| Coupang 상품·와우·배송비 | `npm run --silent coupang:consumer -- offers --url='<정확한 SKU URL>' --visitor`, `npm run --silent coupang:wow -- <옵션>` | [반복 진단과 가격 범위](../../references/coupang-debugging.md) |
| Coupang 공개 가격 목록 검증 | `npm run --silent coupang:prices -- --manifest=<파일> --dry-run` | 같은 문서의 manifest·차단 중단 규칙 |
| Coupang 골드박스·반짝세일 | `npm run --silent coupang:goldbox -- <옵션>`, `npm run --silent coupang:flash-sale` | 정확한 옵션과 공개 행사 가격; 회원 자격과 별도 |
| Coupang 네 번째 조회·쿨다운 진단 | `npm run --silent coupang:read-diagnostic` | 최대 4회, stdin JSON, 같은 문맥, 첫 실패에서 중단 |
| Coupang Partners 보호 상태·링크 | `npm run --silent coupang:partners -- [정확한 SKU URL]` | 무인자는 소유자 조회, URL은 캐시 또는 단일 journaled 발급 |

보호 조회 CLI는 fresh envelope JSON을 **stdin**으로 받습니다. shell에 실제 토큰을 직접 입력해 기록하지 말고 기존 보관함/provider에서 pipe로 전달하세요. 각 adapter의 envelope 계약이 다르므로 core session JSON을 그대로 보내지 않습니다.

원래 README와 개별 문서의 `node scripts/...` 명령은 `apps/affiliate-api-hub` 디렉터리 기준입니다. 위 표의 `npm run`은 이 pack 루트 기준입니다.

## 관측 범위

- MyRealTrip/파트너 read 계약과 Adpick 공개 HTML catalog의 과거 replay 기록을 보존했습니다.
- OliveYoung 파일들은 원본 worktree의 **미커밋 코드 스냅샷**입니다. 구현과 보호 인증 성공은 별개이며, 당시 403/미연동 경계를 그대로 남겼습니다.
- Coupang의 소스 문자열·요청 형태·관측 계약은 분리되어 있습니다. 소스 후보를 곧바로 재현 가능한 SDK operation으로 취급하지 않습니다.
- 개발자 공식 API와 웹 파트너 세션 API는 인증/가입 조건이 다릅니다.
- 별도 로그인 도구와 일부 캡처 스크립트는 Windows 전용입니다. 포터블한 공통 수집은 저장소 루트의 HAR/HTML 도구를 사용할 수 있습니다.

다른 OS에서 실행했다는 주장이나 사이트 전체 로그인 자동화 완료 주장은 이 스냅샷에 포함하지 않습니다.

## 2026-10-04 쿠팡 런타임 보완

최근 디버깅의 consumer·와우·배송비·골드박스·반짝세일·파트너스 구현과 회귀검증을 추가했다. Naver 앱이나 원래 개인 checkout에 의존하던 경로는 pack 내부 및 이 저장소의 공통 보호 인증 런타임으로 연결한다. 최초 로그인 획득과 반복 HTTP 실행, 공개 표시가와 회원 적용가, 가격과 배송비의 완료 여부는 각각 구분한다.

저장소 루트의 `npm run coupang:regress -- --write`는 네트워크와 실제 보호 저장소를 사용하지 않는 회귀검증이다. 현재 인증·상품 가격의 라이브 확인은 별도 CLI 결과로 판정한다. 과거 반짝세일 목록의 고정 SKU 개수나 403 후 방문자 교체를 운영 규칙으로 배포하지 않는다. [진단 문서](../../references/coupang-debugging.md)와 [배포 근거](../../provenance/coupang-debug-pack.json)를 함께 확인한다.
