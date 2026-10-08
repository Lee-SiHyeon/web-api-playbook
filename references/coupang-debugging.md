# 쿠팡 HTTP 수집·파트너스 반복 진단

최근 디버깅에서 사용한 상품·오퍼 파서, 와우 가격 검증기, 배송비 검증, 골드박스·반짝세일 수집, 파트너스 링크 발급을 [affiliate 서비스팩](../service-packs/affiliate/README.md)에 포함했다. 개인 프로젝트 경로나 별도 checkout 없이 저장소 루트의 보호 인증 런타임과 함께 실행한다. 로그인 정보는 배포하지 않는다.

## 설치와 오프라인 회귀검증

저장소 루트에서 Node 24 이상으로 실행한다.

```powershell
npm ci --ignore-scripts
npm run coupang:regress -- --write
```

회귀 실행기는 필수 파일을 먼저 확인하고 쿠팡 파서·가격·배송비·목록·링크 테스트와 공통 인증 테스트, JavaScript 문법을 검증한다. skip/todo도 전체 통과로 인정하지 않는다. 테스트 프로세스의 기본 `fetch`와 기본 보호 저장소가 쓰는 DPAPI helper `execFileSync` 호출을 차단한다. 이는 프로세스 내부 가드이며 OS 전체의 네트워크·파일 격리는 아니다. 테스트는 임시 저장소와 합성 응답을 사용한다. 결과는 `work/coupang-regression/`에 저장하며 Git에 넣지 않는다. 이 결과의 `live_replay`는 항상 `false`다. 통과가 현재 쿠팡 로그인이나 전체 상품의 수집 성공을 뜻하지 않는다.

서비스팩 명령은 다음 디렉터리에서 실행한다. 루트에서 설치한 의존성으로 실행할 수 있으며, pack 자체 설치를 원하는 경우에는 해당 디렉터리에서 `npm ci --ignore-scripts`를 실행한다.

```powershell
cd service-packs/affiliate
```

| 명령 | 검증할 경계 |
| --- | --- |
| `npm run --silent coupang:consumer -- offers --url='<정확한 상품 URL>' --visitor` | 정확한 SKU의 공개 오퍼 읽기; 상품·리뷰·회원 가격은 각각 별도 operation |
| `npm run --silent coupang:wow -- <옵션>` | 공개 일반가·와우 표시가·회원 적용가·배송비를 구분 |
| `npm run --silent coupang:prices -- --manifest=<파일> --dry-run` | 정확한 SKU 목록의 입력 검증; HTTP 호출 없음 |
| `npm run --silent coupang:prices -- --manifest=<파일> --live --write` | 같은 문맥의 공개 일반가 조회; 차단 이후 남은 SKU 보류 |
| `npm run --silent coupang:goldbox -- <옵션>` | 공개 골드박스의 가격·옵션 매핑·부분 수집 상태 |
| `npm run --silent coupang:flash-sale` | 반짝세일의 공개 행사 목록·가격·시간 상태·페이지 커버리지 |
| `npm run --silent coupang:read-diagnostic` | stdin의 최대 네 공개 오퍼 요청으로 순서·동일 SKU·대기 시간 비교 |
| `npm run --silent coupang:partners` | 현재 보호 세션의 대시보드 소유자 확인만 실행 |
| `npm run --silent coupang:partners -- '<정확한 상품 URL>'` | 소유자 확인 후 캐시 조회 또는 한 번의 journaled 링크 발급 |

각 CLI의 옵션과 입력은 구현 파일의 parser를 따른다. 소비자·와우 세션과 파트너스 세션은 다른 서비스 범위다. 파트너스 인증 성공을 소비자 와우 자격의 증거로 사용하지 않는다.

## 가격·배송비·행사 판정

- 상품 URL의 `productId`, `itemId`, `vendorItemId` 세 값을 고정한다. 첫 옵션이나 같은 상품의 다른 판매 옵션으로 바꾸지 않는다.
- `offer-list` 공개 일반가, 골드박스·반짝세일의 표시 행사 가격, 공개 와우 표시가, 현재 계정에 적용된 회원 가격을 별도 값과 출처로 보존한다. 회원 자격을 검증하지 못한 표시가는 회원 적용가로 승격하지 않는다.
- 배송비 누락·필드 충돌·조건부 무료배송은 `null` 또는 미확인 상태다. 명시적으로 검증된 0원만 무료배송으로 확정한다. 가격과 배송비의 SKU·일반가 견적이 다르면 비교에 합치지 않는다.
- 페이지 순회 완료, 정확한 옵션 매핑 완료, 가격 검증 완료, 배송비 검증 완료는 각각 계산한다. HTTP 200이나 목록 개수만으로 전체 수집 완료를 주장하지 않는다.
- 반짝세일은 별도 공개 행사 경로다. 활성 상태·품절·남은 시간과 공개 가격을 보존하며, 쿠폰·회원 적용 조건은 별도 검증 전까지 미확인이다. 일반 파트너스 발급기는 정확한 상품 URL을 받으므로 행사 상품도 같은 소유자·목적지·귀속 검증을 거친다. 과거 목록의 101개 상품/286개 SKU를 현재 고정 개수로 사용하지 않는다.

## 네 번째 요청·쿨다운 진단

다음 JSON을 UTF-8 파일로 준비하여 stdin으로 전달할 수 있다. 한 URL에 `repeat:4`이면 같은 판매 옵션을 네 번 읽는다. 서로 다른 URL 네 개를 `targets`로 주면 해당 순서로 읽는다.

```json
{
  "targets": ["https://www.coupang.com/vp/products/6247736560?itemId=12646874013&vendorItemId=79914317500"],
  "repeat": 4,
  "intervalMs": 1000,
  "fourthDelaySeconds": 30
}
```

```powershell
Get-Content -Raw -Encoding UTF8 .\diagnostic.json | npm run --silent coupang:read-diagnostic
```

대기 시간은 세 번째 응답 완료부터 측정한다. 같은 자연 발급 문맥을 유지하고 실제 쿠키 만료와 문맥 유효기간을 검사한다. 첫 거절·챌린지·전송/스키마 실패에서 중단하며 방문자를 교체하거나 요청을 재시도하지 않는다. 네 번째가 없으면 상태와 미시도 개수를 그대로 기록한다. 입력의 상품명이나 분류를 확인된 서버 카테고리 ID로 취급하지 않는다.

2026-10-04의 제한된 과거 시험에서 같은 우유롤·커피 각각의 네 번째 공개 가격 요청이 403이었다. 별도 대기 시험의 15·30·60·120·240·600초 모두 네 번째 요청이 403이었다. 이 결과는 고정 서버 한도, 카테고리별 제한 또는 성공 쿨다운 시간을 확정하지 않는다. 병렬 방문자 확대·차단 후 재발급·챌린지 우회는 이 반복 진단의 동작에 포함하지 않는다.

## 새 프로세스 파트너스 소유자 바인딩

2026-10-04에 새 Node 프로세스가 정상 대시보드 응답을 받은 뒤 `COUPANG_OWNER_BINDING_INVALID`로 실패했다. 만료된 `web-session-id`가 outgoing Cookie 계산 중 jar에서도 삭제되고, 대시보드의 정상 `CT_AT` 회전이 기존 HMAC과 달라진 것이 각각 원인이었다.

공통 인증 런타임은 기존 HMAC을 먼저 검사한다. 만료 쿠키는 wire에서 제외하되 바인딩 증거는 보존한다. 대시보드의 HTTP·애플리케이션 코드·스키마·유효 AFATK를 검증한 뒤 그 응답에서 실제 적용된 `CT_AT`/`CT_JKTH`의 값 회전만 허용한다. 범위 변경·삭제·중복·계정 anchor 변경·응답 증거 없는 변경은 거부한다. 정확히 저장할 최종 필터링 세션도 다시 검증한다.

후속 실행은 현재 Windows 사용자의 DPAPI `coupang-web-state`를 재사용한다. 보호 상태·쿠키·토큰 값은 진단 결과에 출력하지 않는다. 파트너스 체크는 이름만 남기는 쿠키 회전 메타데이터와 안전한 링크 영수증을 저장한다. 새 프로세스 테스트는 실제 Node 실행 경계를 별도로 검증한다.

보호 저장소 helper는 바쁜 Windows 호스트를 고려한 180초의 상한을 사용한다. 저장 단계 실패는 HTTP 인증 실패와 별도로 기록한다. CLI의 `providerFailure`에는 허용된 단계 이름·시간 초과 여부·제한된 종료 코드만 남기며 stdin·stdout·stderr·인증 값은 제외한다. 저장 실패 후 링크 발급을 자동 재전송하지 않는다.

링크 발급은 관측된 `GET /api/v1/url/any`이지만 상태를 만드는 작업이다. 발급 전 journal을 쓰고 한 번만 전송한다. 불확실한 결과는 같은 journal을 대조하기 전 다시 발급하지 않는다. 생성 응답의 목적지·귀속 검증과 독립적인 readback은 구분하며, 검증 목적으로 affiliate 링크를 열지 않는다.

보호 세션의 최초 획득과 이후 HTTP 업무 실행도 구분한다. 최초 비밀번호 로그인 전체의 순수 HTTP 구현과 만료 AFATK의 자동 갱신은 검증되지 않았다. 정상 갱신 계약이 없으면 재인증 필요로 종료한다. HTTP 200 로그인 페이지나 이전 성공 영수증으로 현재 인증을 대신하지 않는다.

## Linux process-memory provider

`coupang-partners-check.mjs`는 Windows에서 기존 DPAPI 기본 흐름을 유지한다. Linux에서는 저장소를 암묵적으로 만들지 않고 명시적인 provider를 요구한다.

```bash
npm run --silent coupang:partners -- --provider memory
```

비어 있는 memory store라면 실제 인증 요청을 보내지 않고 다음 상태를 반환한다:
`credentialProvider=process-memory`, `authenticationStatus=session_missing`, `httpStatus=0`, `requests=[]`.
이는 현재 메모리 영역에 `coupang-web-state`가 없다는 뜻이지, HTTP 403·로그아웃·잘못된 owner 증거가 아니다.

현재 Linux 호스트의 보호 세션 제공자는 완성된 version 1 또는 owner-bound version 2 JSON 상태를 same-host pipe의 stdin으로 넘길 수 있다. CLI는 `--state-stdin`을 받으면 TTY 입력을 거부하고 UTF-8/JSON 입력을 1 MiB로 제한하며, version·email·affiliateCode·session scope·cookie-jar shape를 먼저 검사한다. 이후 `createCoupangAuth`가 실제 owner health를 검증하고, 상품 URL을 받은 경우 원래 `issueCoupangLink` 어댑터도 같은 memory store와 bound-session dependency를 사용한다. JSON·쿠키·owner 이메일·affiliateCode는 출력하거나 파일로 저장하지 않는다. stdin state를 임시 JSON 파일·명령행 인자·환경변수로 우회하지 않는다.

운영 입력 형태는 다음과 같다. `<same-host-protected-state-provider>`는 설치돼 검토된 경우에만 그 실제 명령으로 바꾸며,
state 자체나 credentials를 터미널·파일·명령행에 입력하지 않는다. 현재 checkout에는 이 외부 provider가 포함되지 않았으므로
provider 준비 전에는 memory health가 `SESSION_MISSING`으로 끝나는 것이 맞다.

```bash
<same-host-protected-state-provider> | npm run --silent coupang:partners -- --provider memory --state-stdin '<정확한 상품 URL>'
```

Memory provider에서 issue/journal 재진입을 위해 저장하는 것은 전용 `$HOME/.nad-scratch/web-api-playbook/coupang-partners/` 아래의 링크 cache/journal과 sanitized run receipt뿐이다. 디렉터리 권한은 0700, 파일은 0600으로 낮춘다. Session state 자체는 process-local memory에만 남는다. Memory provider의 stdout와 receipt에서 product URL 및 단축 URL 값은 생략하고 검증 상태만 기록한다. 기존 Windows DPAPI 명령의 receipt 형식과 저장 흐름은 바꾸지 않았다.

Linux memory provider에 실제 owner 세션이 공급되지 않은 실행은 `SESSION_MISSING`과 HTTP 0으로 끝난다. 이 상태에서 인증 성공이나 파트너 링크 발급을 주장하지 않는다.

2026-10-08 07:36 UTC의 실제 Linux CLI 실행은 `--provider memory`에 빈 process-memory store를 사용했다. 결과는 `SESSION_MISSING`,
`httpStatus=0`, 요청 0건, `credentialProvider=process-memory`, `sessionStatePersisted=false`였다. 쿠팡 요청·링크 발급은 전혀 발생하지 않았고,
실제 계정 인증은 아직 제공되지 않았으므로 이 영수증은 provider 누락 상태만 입증한다.

## Linux 런타임과 인증 건강 확인 경계

이 서비스팩에는 Linux용 영구 Coupang 인증 저장소가 포함되어 있지 않다. `ProtectedStore`는 Windows에서 현재 사용자 DPAPI를 기본 사용하고, 다른 플랫폼에서는 provider를 명시해야 한다. `provider: "memory"`는 현재 Node 프로세스 메모리만 사용하므로 새 프로세스에서 비어 있으며 재시작 사이에 세션을 보존하지 않는다.

인증 CLI의 `status()`는 저장된 세션의 존재만 알려 주며 `currentAuthentication: "not_checked"`를 반환한다. 명시적 빈 Memory provider의 `health()`는 `SESSION_MISSING`으로 끝나고 파트너 API 요청을 보내지 않는다. 이 결과는 파트너 API가 401/403을 반환했다는 증거가 아니다. `scripts/coupang-partners-check.mjs`의 기본 경로도 Linux에서 `PROTECTED_STORE_PROVIDER_REQUIRED`로 HTTP 전에 끝날 수 있다. 현재 체크 스크립트의 `credentialProvider` 표시는 `windows_dpapi_current_user`로 고정되어 있어 Linux 진단에서는 실제 사용 provider로 해석하면 안 된다. `requests`가 비어 있으면 해당 실행은 파트너 HTTP 경계에 도달하지 않은 것이다.

위 내용 가운데 CLI 기본 provider와 `credentialProvider` 표시는 과거 상태다. 현재 Linux CLI는 `--provider memory`를 요구하고 actual provider를 `process-memory`로 표시한다. 빈 store의 실제 결과는 위에 기록한 대로 `SESSION_MISSING`/HTTP 0/요청 0건이다. `--state-stdin`은 same-host의 trusted state provider가 주는 bounded record을 이번 process의 memory store에만 넣는다.

라이브러리 수준의 주입점은 `createCoupangAuth({ store, fetchImpl })`이며 `store`는 `directory`, 동기 `read(name)`, `write(name, value)`, `status(name)` 계약을 제공해야 한다. 링크 어댑터는 `issueCoupangLink(productUrl, { dependencies })`로 저장소·세션 역직렬화·잠금·소유자 검증 의존성을 받는다. 체크 CLI는 이를 사용해 동일 store로 owner health를 확인한 다음 link adapter에 같은 process-memory store를 넘긴다. 이 API와 provider flag가 있어도 현재 쿠팡 세션 존재나 owner 인증을 뜻하지 않는다.

브라우저의 로그인 제출에서 `/login/v2/signin` 403을 관측한 경우에는 그 로그인 경계의 실패로 기록한다. 해당 실행의 요청 기록에 `/api/v1/config` 또는 `/api/v1/dashboard`가 없으면 파트너 업무 API의 응답 상태는 미확인이다. v1 소유자 검증은 파트너 `/api/v1/config`의 실제 이메일·제휴 코드를 기대 소유자와 비교한다. v2는 직전의 승인된 config 응답에서 수집한 증거와 HMAC 소유자 바인딩, AFATK 유효성, `/api/v1/dashboard` 응답을 결합하며 `freshHttpIdentityRead`를 `false`로 보고한다.

이 체크 CLI는 개발·디버그용이다. 세션/cookie/state를 Vercel 환경 변수나 배포 런타임으로 복사하지 않으며, Vercel 운영 크론에서 실행하지 않는다. 현재 Linux account session이 없으면 memory 검사는 계속 `SESSION_MISSING`으로 끝나고 파트너 link operation은 실행되지 않는다.

## 보존 범위

원본은 `affiliate-content-operations`의 2026-10-04 커밋 `c6c8c146ad3e1e4cfbb169dd2ccab12ba202018e`까지의 쿠팡 구현이다. 공통 세션 수정은 이 저장소 커밋 `0907cb699bfaf46d7bf9a143b186c605fb72fdab`에 있다. 상대 경로와 공통 런타임 연결을 조정했고, 일회성 고정 목록·개인 경로·브라우저 handoff worker는 반복 실행 필수 의존성에서 제외했다. 배포 파일의 hash와 변환 내역은 `provenance/coupang-debug-pack.json`에 기록한다.
