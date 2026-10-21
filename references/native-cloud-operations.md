# Native CLI·MCP 인증과 운영 readback

Vercel·Supabase처럼 공식 CLI가 이미 인증돼 있는 서비스는 그 실행기를 먼저 재사용한다.
이 문서는 2026-10-11 운영 작업에서 얻은 절차이며, 이 저장소에 두 서비스의 새로운
로그인 adapter나 배포 SDK를 추가한 것은 아니다. 다른 컴퓨터의 CLI 인증은 이전되지 않는다.

## 인증·권한을 분리해서 확인

| 확인 | 증명하는 것 | 추가로 필요한 확인 |
|---|---|---|
| CLI 설치·버전 | 실행기 존재 | 현재 실행 사용자의 인증 |
| `vercel whoami`의 실제 계정 반환 | 해당 CLI의 계정 인증 | 지정한 팀·기존 프로젝트 읽기 |
| CLI 프로젝트 조회 | 그 계정의 해당 프로젝트 접근 | Git repo·production branch·deployment SHA |
| MCP OAuth 완료 | 해당 MCP client의 토큰 획득 | 인증된 팀 목록과 지정 프로젝트 조회 |
| MCP 문서 검색 | 문서 조회 기능 | 계정·팀 권한은 증명하지 않음 |
| `supabase projects list` | 해당 CLI의 프로젝트 조회 권한 | 지정 project ref와 DB/RPC 실제 계약 |
| API health 200 | 관측한 health 결과 | endpoint가 공개면 인증 증거가 아님 |

2026-10-11 사례에서 Vercel CLI는 기존 팀·프로젝트를 관리할 수 있었다. 동일 서비스의
MCP OAuth도 완료됐고 문서 검색과 `list_teams` 호출 자체는 성공했지만, 결과가 `teams: []`였고
기존 프로젝트 조회는 거절됐다. 따라서 `MCP authenticated / project access blocked`로
기록한다. 계정별 OAuth client·scope·팀 entitlement는 별도이므로 `connected: true` 하나로
합치거나, CLI가 되는 이유만으로 MCP 권한을 주장하지 않는다. CLI 경로로 필요한 작업을
진행할 수 있으면 MCP 장애 때문에 사용자의 완료된 로그인을 반복 요구하지 않는다.

CLI 종료코드만 검사하지 않는다. 2026-10-17 Windows의 Vercel CLI 62.7.0에서
`whoami`가 `Logged out`을 반환하면서 종료코드는 0이었다. 계정명이 확인되지 않으면
인증되지 않은 상태다. Device Flow 만료는 완료로 취급하지 않으며 만료된 코드를 재사용하지 않는다.

## 공식 setup과 기존 설정 보존

### 배포와 DB 장애를 수집 실패에서 분리

- 프로젝트 목록의 `ACTIVE_HEALTHY`와 DB/REST/Auth/Storage의 실제 service health는
  별도다. 2026-10-17에는 전자는 정상인데 네 서비스가 모두 unhealthy였고, 배포의
  schema preflight와 여러 collector가 동시에 timeout/503/504로 실패했다.
- 같은 실행기의 구조화된 오류 stdout와 stderr를 모두 분류한다. `Initialising login role...`
  한 줄만 보이면 자격 부재로 단정하지 않는다. 실제 오류는 `DbConfigLoginRoleStatusError`
  / HTTP 544 / DB 연결 timeout일 수 있다. 출력 전 토큰·원문 query·개인 데이터를 제거한다.
- DB 계약 검사를 끄거나 `DATA_MODE=demo`로 바꿔 배포 성공을 만들지 않는다. 읽기 전용
  service health/SQL/metrics를 대조하고, 확인된 대상의 제한적인 운영 복구 후 다시 검사한다.
  restart ACK는 복구가 아니다. 상태와 실제 SQL/REST가 돌아왔는지 별도로 읽는다.
- `vercel env run`도 production의 Secret 값을 내보내지 못할 수 있다. 임의 `.env` 작성이나
  legacy key 재활성화로 해결하지 않는다. 이미 승인된 서비스의 native credential provider와
  공식 API를 사용하는 경우에도 정확한 프로젝트·operation을 고정하고 자격은 process memory에만
  두며 파일/로그/커맨드라인으로 내보내지 않는다. 다른 계정·credential target은 탐색하지 않는다.
- 첫 실패 deployment, 복구 작업, 재배포, production SHA, Cron invocation, DB receipt 및
  catalog readback을 각각 남긴다. 성공한 Partners/feed 수집을 실패한 일반몰 검색과 합치지 않는다.

Vercel 작업은 현재 [get-started.md](https://vercel.com/get-started.md)를 먼저 읽는다.
기존 CLI·전역 guidance·MCP entry를 조사하고, 필요한 항목만 추가한다. 최초 전역 setup만으로
새 프로젝트를 만들지 않는다. 이미 연결된 팀·프로젝트·Git branch를 우선 읽는다.
plugin 설치가 실제로 지원되지 않으면 공식 standalone skills 경로를 사용하고 두 경로를
중복 설치하지 않는다. 설치 실패 원인과 fallback은 별도로 기록한다.

Codex는 공식 shared endpoint `https://mcp.vercel.com`을 사용한다. `codex mcp list`로
기존 entry를 확인한 뒤 필요한 경우에만 `codex mcp add vercel --url https://mcp.vercel.com`
또는 `codex mcp login vercel`을 사용한다. 현재 client가 정한 user-wide config를 확인하고
다른 MCP·모델·프로젝트 설정을 보존한다. `.credentials.json`이나 CLI auth 파일을 repository,
plugin config, 임의 `.env`로 복사하지 않는다. MCP mutation의 실제 client 승인 요구는 따른다.

Supabase는 [공식 login 문서](https://supabase.com/docs/reference/cli/supabase-login)를 따른다.
문서상 native credential storage가 없으면 평문 파일 fallback이 가능하므로 실제 저장 provider를
확인한다. 이미 준비된 native store를 평문으로 바꾸지 않는다. Management PAT,
프로젝트 service-role key, anon key, DB password는 서로 다른 자격이며 바꿔 쓰지 않는다.
CLI 로그인만으로 임의 프로젝트 SQL 접근이 증명되는 것도 아니다.

### 2026-10-17 native CLI 적용에서 확인한 추가 경계

- Supabase CLI 2.120.0의 `db query`는 이 환경에서 native 로그인 자격으로
  Management API SQL을 실행했다. 명시적인 project ref를 사용할 때도 `--linked`가
  필요했다. `db query --linked --project-ref <verified-ref> --file <reviewed.sql>`의
  실제 결과를 확인하며, 이를 위해 DB 비밀번호나 PAT를 임의 파일로 추출하지 않는다.
  다른 버전은 해당 실행기의 `--help`를 먼저 확인한다.
- 마이그레이션은 기존 원격 이력·사용할 RPC 계약과 대조한 새 파일만 적용한다.
  관련 없는 과거 pending 파일을 일괄 push하지 않는다. 적용과 migration history를
  같은 transaction에 기록하고, 별도 읽기로 파일 hash·RPC grant·익명 접근 거부를 검증한다.
  적용된 SQL 파일은 수정하지 않고 후속 변경은 별도 migration으로 남긴다.
- Vercel CLI 62.7.0의 `link --yes`는 기존 프로젝트 연결과 함께 `.env.local`에
  OIDC 값을 내려받기도 했다. 연결만 했다고 credential 파일이 없다고 가정하지 않는다.
  값은 출력하지 않고 `.env*`와 `.vercel/`의 Git·배포 제외 여부를 확인한다.
  native 파일을 일반 evidence나 portable skill로 복사하지 않는다.
- `vercel crons run`의 triggered ACK는 수집 완료가 아니다. 저장된 start row, DB lease,
  완료 receipt와 실제 catalog를 별도로 읽는다. 불확실한 ACK를 이유로 같은 작업을
  즉시 다시 보내지 않는다. PC 관측 시간과 cloud/DB 실행 시간은 서로 기록한다.
- GitHub Actions의 결제/사용 한도 때문에 job steps가 시작되지 않은 경우는 코드 검사
  실패와 구분한다. 로컬 검사·Vercel build가 성공해도 GitHub CI가 통과했다고 쓰지 않는다.

실제 반례는 [Coupang 일반몰 Vercel 기록](coupang-retail-vercel-2026-10-17.md)에 둔다.
운영 배포와 native Cron dispatch가 성공해도 source 403, 상품 0개, 세션 없음이면
`deployed / collection blocked`이며 이관 성공이 아니다.

## 원격 환경의 일회용 OAuth callback

브라우저가 사용자의 컴퓨터에서 `127.0.0.1` callback으로 이동하면 페이지가 안 열려도
동의가 완료됐을 수 있다. 현재 CLI가 실제로 기다리는 같은 attempt에 한해 callback을 전달한다.

1. 실행 중인 attempt의 정확한 scheme, loopback host, port, path와 현재 state를 메모리에 둔다.
2. 사용자가 보낸 URL을 URL parser로 해석하고 host·port·path·state를 그 attempt와 대조한다.
   state/code 중복, 다른 attempt, 비어 있는 code와 OAuth error를 거절한다.
3. 주소 끝의 빈 `#`는 fragment이므로 HTTP request에 보내지 않는다. fragment을 query의 code에
   이어 붙이거나 query 전체를 임의 문자열 replace로 변형하지 않는다.
4. 아직 열려 있는 해당 로컬 listener에 한 번만 전달하고 실제 성공 출력을 확인한다.
   완료됐거나 만료된 callback/code를 새로운 attempt에 재사용하지 않는다.
5. callback·state·PKCE verifier·authorization code는 stdin/process memory로만 처리한다.
   shell 인수·history·로그·영수증·Git에 원문을 남기지 않는다. 기존 인증 파일을 임의로 덮어쓰지 않는다.

이는 OAuth를 우회하는 helper 구현이 아니라 공식 client의 현재 pending attempt를 재개하는
절차다. 새 동의가 실제로 필요하면 공식 consent UI를 사용하고, 종료된 세션을 추측으로 복원하지 않는다.

## Proxy·TLS·직접 API 경계

CLI가 인증됐는데 직접 HTTP가 실패하면 credential propagation, proxy/TLS, 계정 권한을
따로 조사한다. 상속된 proxy와 CA를 유지하며, Node 24의 환경 proxy 지원이 필요한 runtime은
`NODE_USE_ENV_PROXY=1`처럼 해당 command에만 적용한다. `-k`, TLS 검증 해제, origin 변경,
다른 계정의 token, 임의 debug port로 해결하지 않는다.

공식 Management API 호출이 꼭 필요하면 기존 provider가 선택한 자격만 process memory로
받아 정확한 API origin에 한정한다. stdout은 status·건수·검증 flag 같은 허용 필드만 출력한다.
DB query 결과·환경변수 조회 결과에는 인증값과 개인정보가 있을 수 있으므로 전체 raw 응답을
`console.log`하거나 evidence에 저장하지 않는다. generic request profile에 모든 cloud token을
변환해 넣을 필요는 없다. [credential propagation](runtime-credential-propagation.md)을 따른다.

## 배포와 데이터 수선의 완료 조건

### 로컬 수집 검증에서 Vercel 세션 소비로 이관할 때

- 로컬 probe는 일회성으로 실행하며 `runtime=local`, `dbWrites=0`을 기록한다.
  가짜 DB가 반환한 accepted 수는 `simulatedAccepted`이지 persisted receipt가 아니다.
  부분 실패·미구성·차단이 하나라도 있으면 비정상 종료코드와 소스별 오류를 유지한다.
  정상적인 빈 목록은 오류와 다르게 기록하고 전체 목록을 읽었다는 뜻으로 바꾸지 않는다.
  운영 orchestrator와 같은 수집기 목록을 참조해 Meta/Threads/TikTok 같은 추가 소스를
  구버전 검사 목록에서 누락하지 않는다. 의도적으로 짧게 제한한 probe의 시간초과는
  운영 runtime의 동일 장애가 입증된 것과 구분한다.
- 패키지를 복사해도 DPAPI 세션은 이전되지 않는다. 현재 사용자의 정확한 store 이름과
  provider 경로를 먼저 검사한다. `C:/Users/다른사용자/...` 하드코딩은 소비 경계 실패다.
  운영 요청 전에 provider/저장 상태/자료 스키마를 검사하고, 준비되지 않았다면 0회 요청으로 끝낸다.
- Lifehack의 `scripts/toss-session-handoff.mjs --check --playbook-root=<checkout>`은
  수정 버전에서 값 읽기 없이 로컬 DPAPI 저장 유무를 확인한다. 실행할 checkout SHA를 함께 기록한다.
  인증된 owner probe, 실제 서명 이관, Vercel의 독립된 다음 invocation 읽기는 각각 별도 증거다.
  기존 ready 세션을 덮어쓰지 않는다. 웹 운영자 쿠키·서명키는 stdin/보호된 메모리로만 전달한다.
  네이버는 `scripts/naver-health-probe.mts --check`와 `brandconnect-state`, 쿠팡은
  서비스 adapter가 실제 사용하는 `coupang-web-state`를 확인한다. 추측한 다른 이름의
  빈 저장 결과를 해당 서비스 전체의 인증 부재로 확대하지 않는다.
- 반복 수집·세션 검증·갱신은 선택한 Vercel runtime에서 수행한다. local/PC 예약 작업을
  새로 만들지 않는다. PC 담당 소스는 동일 범위의 cloud 저장 receipt를 확보한 뒤에만 퇴역시키며,
  세션이 옮겨졌다는 이유만으로 PC-only 목록/대상 링크 추출까지 이관 완료로 보고하지 않는다.
- provider MFA/승인 요구는 자동 갱신 성공과 구분한다. 2FA 필요 상태나 접근 차단을
  조용한 재로그인으로 감추지 말고 기존 pending attempt와 사용자 승인 경계를 유지한다.

코드 배포는 `tested local tree → main SHA → remote main SHA → READY deployment SHA
→ promoted alias → 실제 domain route/readback` 순서로 대조한다. CLI exit 0, Git push,
`READY` 중 하나만으로 사용자 도메인에 변경이 보인다고 보고하지 않는다. build용 계약 점검
script가 `.vercelignore`에서 제외돼 배포가 실패한 사례처럼 실제 업로드 파일과 cloud build log도
확인한다. 같은 commit의 로컬 build와 cloud schema preflight는 서로 다른 증거다.

Cron 등록과 수동 호출 성공도 실제 자동 실행 증거가 아니다. 운영 scheduler의 timestamp,
deployment SHA, 요청 주체, HTTP/application 결과, source별 persisted 상태를 확인한다.
일부 source의 503은 완료한 source까지 실패로 덮지 않고, 전체 응답 200도 sample/cache-only
수집을 실제 저장으로 확대하지 않는다.

기존 운영 행 보완은 [쓰기 대사](write-and-reconcile.md)의 의도 저널과 함께 다음처럼 처리한다.

- 대상 ID·원문 URL·기존 값·활성 조건과 수정할 필드 하나를 검토한 manifest로 고정한다.
- transaction에서 대상 row를 잠근 뒤 현재 값으로 CAS를 확인하고, 한 건이라도 다르면 전부 롤백한다.
- 수정 직전의 전체 행에서 의도한 필드만 뺀 snapshot을 비교한다. 관측 시각·가격·이력·migration
  journal은 별도 불변 조건으로 검사하며 정상 수집기의 transaction 밖 변경과 혼동하지 않는다.
- 예상 변경 건수와 실제 결과를 대조한다. 같은 SQL 재실행은 CAS 불일치로 거절돼야 한다.
- COMMIT 뒤 새로운 독립 조회로 대상별 값과 불변 조건을 확인한다. UI 경로도 별도로 검증한다.

backup은 허용한 table·journal 범위와 hash를 기록하고, 빈 별도 DB의 restore를 검증한다.
몇 개 table의 restore 성공은 Auth·Storage·전체 계정 disaster recovery나 RPO/RTO 보장이 아니다.

공식 근거: [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp),
[Supabase query API](https://supabase.com/docs/reference/api/v1-run-a-query).
이 저장소의 보강·읽기 검증 범위는 [2026-10-11 기록](../verification/playbook-strengthening-2026-10-11.json)을 따른다.
