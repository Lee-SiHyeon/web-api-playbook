# 인포크 로그인과 보호 계정 조회

2026-10-04 Linux vBee 워커에서 정상 브라우저 로그인 요청을 관측하고,
새 HTTP 세션과 실제 Node.js 실행기로 비밀번호 로그인·계정 대조·세션 재사용을 확인했다.
적용 범위는 로그인과 보호 계정 조회다. 별도 [기능 탐색 및 읽기 실행기](inpock-features.md)에
블록·프로필·통계 조회와 오프라인 카드 후보 준비를 추가했다.
링크 편집, 콘텐츠 작성, 인스타그램 연동의 실제 계정 쓰기는 아직 포함하지 않는다.

## 관측한 계약

웹 진입점은 `https://link.inpock.co.kr/inpockhome`이며 미인증 상태에서는
`/user/login?redirect=/inpockhome`으로 이동한다. API origin은
`https://link-rest.inpock.co.kr`이다.

| 작업 | 요청 | 입력과 판정 |
|---|---|---|
| 비밀번호 로그인 | `POST /login`, `multipart/form-data` | `username,password`; HTTP 201 JSON `{username,token}`. 응답 username도 입력 계정과 대조 |
| 보호 계정 조회 | `GET /v2/users` | 로그인 응답 token을 같은 API origin의 `token` 쿠키로 전달. HTTP 200 JSON의 `id,username` 대조 |

관측된 `Origin`은 `https://link.inpock.co.kr`, `Referer`는 같은 웹 origin의 `/`이다.
독립 HTTP 검증에는 분석용 쿠키, `device_id`, `active_user_id`, 브라우저 세션을 사용하지 않았다.
인증 없이 같은 계정 endpoint를 호출하면 HTTP 401이 반환됐다.
원본 응답의 이메일·전화번호는 결과나 검증 기록에 포함하지 않는다.

## Linux/macOS: 한 프로세스에서 비밀 입력과 실행

루트 README의 Node.js 24 이상과 `npm ci --ignore-scripts` 설치를 먼저 진행한다.
보호 비밀 공급자의 JSON `{username,password}`를 다음 실행기의 stdin에 전달한다.
실제 비밀번호를 명령 인수, 환경변수, JSON 파일에 넣지 않는다.

```bash
# stdin에는 승인된 공급자가 전달한 자격증명 JSON을 연결한다.
node scripts/inpock.mjs ensure --credentials-stdin
node scripts/inpock.mjs owner --credentials-stdin
node scripts/inpock.mjs verify --credentials-stdin
```

직접 터미널에서 숨김 입력을 받아 실제 CLI stdin으로 넘기는 예시는 다음과 같다.
Python은 입력 전달만 담당하며 HTTP 요청은 Node 실행기가 수행한다.

```bash
python3 -c 'import getpass,json,subprocess; credentials={"username":getpass.getpass("Inpock ID: "),"password":getpass.getpass("Inpock password: ")}; result=subprocess.run(["node","scripts/inpock.mjs","verify","--credentials-stdin"],input=json.dumps(credentials),text=True); credentials.clear(); raise SystemExit(result.returncode)'
```

`--credentials-stdin`은 기존 `ProtectedStore`의 명시적 `memory` provider를 사용한다.
비밀번호와 token은 해당 Node 프로세스 메모리에만 보관한다. 프로세스가 종료되면 세션이 사라지며,
다음 실행에는 공급자가 다시 자격증명을 전달해야 한다. 디스크에는 비밀값을 기록하지 않는다.

`verify`는 최초 `ensure` → `health` → 두 번째 `ensure`를 같은 프로세스에서 실행한다.
마지막 단계의 `renewal:"stored_session"`이 세션 재사용 결과다.
빈 메모리 provider의 `health`는 `SESSION_MISSING`으로 종료하며 비밀번호 로그인을 시작하지 않는다.

## Windows: 기존 DPAPI 저장소 사용

처음 한 번 승인된 비밀 공급자의 `{username,password}` JSON을
`node scripts/web-auth-import.mjs inpock-login` stdin으로 전달한다.
직접 입력할 때는 PowerShell의 숨김 비밀번호 입력을 사용할 수 있다.

```powershell
$inpockId = Read-Host 'Inpock ID'
$inpockPassword = Read-Host 'Inpock password' -AsSecureString
$inpockJson = @{ username = $inpockId; password = [System.Net.NetworkCredential]::new('', $inpockPassword).Password } | ConvertTo-Json -Compress
$inpockJson | node scripts/web-auth-import.mjs inpock-login
Remove-Variable inpockJson, inpockPassword

node scripts/web-login.mjs inpock ensure
node scripts/web-login.mjs inpock health
node scripts/web-login.mjs inpock owner
```

저장 비밀번호와 발급된 세션은 기존 Windows DPAPI CurrentUser 경로를 사용한다.
이번 라이브 검증은 Linux 메모리 provider에서 수행했다. Windows에서 이 서비스의 DPAPI 저장 및
프로세스 재시작 후 세션 복원은 아직 라이브 확인하지 않았다.

## 라이브러리

`createInpockAuth`는 기존 `ProtectedStore`, `ScopedSession`, `withSessionLock`을 사용한다.

```js
import { createInpockAuth } from '../lib/web-auth/inpock.mjs';

// Windows의 기존 보호 저장소; 다른 OS는 승인된 store를 명시적으로 전달한다.
const auth = createInpockAuth();
await auth.ensure();
await auth.health();
await auth.withSession(async (session, authReceipt) => {
  // 검증된 계정의 API 전용 HTTP 세션. 새 업무 계약은 별도로 관측·검증한다.
  // session.toJSON()과 원본 응답을 출력하거나 반환하지 않는다.
});
```

로그인과 계정 조회는 API origin만 허용한다. token 쿠키는 host-only로 발급하며,
리다이렉트 재전송을 막고 요청·응답 크기와 시간을 제한한다.
로그인 응답과 보호 조회가 모두 같은 계정을 가리켜야 기존 정상 세션을 교체한다.
`status`는 저장 준비 상태이며 현재 인증을 증명하지 않는다.

관측한 refresh endpoint나 서버 token 수명은 없다. `ensure`의 기존 세션이 명시적 401 또는
쿠키 소멸로 거절되면 비밀번호 로그인 한 번으로 복구하도록 구현했다.
실제 만료 후 복구는 미관측이며, 401·쿠키 삭제 분기는 회귀 테스트에서 검증했다.
403·429·서버 오류·전송 오류에는 자동 재로그인하지 않는다.

실제 실행 증거는 [종합 검증 기록](../verification/inpock-login-2026-10-04.json)과
[Node 실행기 기록](../verification/inpock-runner-2026-10-04.json)을 참고한다.
다섯 전환 상태는 이 로그인·보호 조회 범위에서만 확인했다.
