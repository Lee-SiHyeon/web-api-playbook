# 공통 HTTP 런타임 모듈

이 문서는 `lib/`의 재사용 가능한 범용 런타임 계약을 설명합니다. Node.js 24 이상, ESM, `tough-cookie@5.1.2`를 사용합니다. 도메인별 URL, 계정 선택, 요청 본문, 응답 검증은 서비스 adapter/profile이 정합니다. 모듈은 로그인·갱신·업무 요청을 스스로 실행하거나 재시도하지 않습니다.

## `ScopedSession`

```js
import { ScopedSession } from '../lib/scoped-session.mjs';

const session = new ScopedSession({
  allowedOrigins: ['https://api.example.invalid'],
  cookieOrigins: ['https://api.example.invalid'],
  defaultHeaders: { accept: 'application/json', 'user-agent': 'my-client/1.0' },
  headersByOrigin: {
    'https://api.example.invalid': { authorization: 'Bearer <메모리에서 주입>' },
  },
});

const response = await session.request('https://api.example.invalid/v1/items', {
  method: 'GET',
});
// { status, headers, raw }
```

생성 옵션:

| 옵션 | 계약 |
|---|---|
| `allowedOrigins` | 필수. 정규화된 origin 문자열 배열이며 scheme/host/port가 정확히 일치해야 합니다. path, query, fragment는 허용하지 않습니다. HTTPS만 기본 허용합니다. |
| `cookieOrigins` | 선택. 기본 `[]`. `allowedOrigins`의 부분집합입니다. 쿠키 seed, Cookie 헤더 전송, Set-Cookie 회전은 이 origin에서만 수행합니다. |
| `cookies` | 선택. `{ url, setCookie }` 배열 또는 browser-cookie `{ name, value, domain, path, expires, hostOnly, secure, httpOnly, sameSite }` 배열입니다. seed origin/domain은 `cookieOrigins` 안의 host와 일치해야 합니다. 쿠키 도메인 검증은 tough-cookie가 수행합니다. 원문 값은 보호저장소에 넣기 전까지 메모리에서만 다룹니다. |
| `defaultHeaders` | 선택. 모든 허용 origin에 적용되는 비밀이 아닌 기본 헤더입니다. Accept/User-Agent 같은 값만 사용합니다. Cookie, Authorization, API key, token, session, CSRF 등 비밀 이름은 거부됩니다. |
| `headersByOrigin` | 선택. `{ [exactOrigin]: headers }`. 인증·서명 등 origin 전용 헤더를 이곳에 넣습니다. 해당 origin 요청에만 붙고 redirect 대상에는 그 대상 origin의 설정만 적용됩니다. `Cookie`는 이곳에서도 금지하고 CookieJar를 사용합니다. |
| `fetchImpl` | 선택. 요청 주입점. 기본값은 Node의 `fetch`입니다. |
| `timeoutMs` | 선택. 기본 20초, 요청과 redirect chain 전체 제한입니다. |
| `maxRequestBytes`, `maxResponseBytes` | 선택. 각각 기본 4 MiB이며 최대 64 MiB입니다. 지원하는 요청 본문은 문자열, 바이트 배열, URLSearchParams, Blob입니다. 스트림/FormData는 크기 상한을 보장할 수 없어 거부됩니다. |
| `maxRedirects` | 선택. 기본 8, 최대 20입니다. |
| `allowLoopbackHttp` | 기본 `false`. `true`일 때만 `http://localhost`, `http://127.0.0.1`, `http://[::1]`을 허용합니다. 그 외 HTTP origin은 계속 거부됩니다. 테스트나 로컬 callback에만 쓰고, profile에서도 별도로 허용 여부를 검사하세요. |

`request(url, init)`은 `{ status, headers, raw }`를 반환합니다. 요청마다 origin을 검사하고 Fetch 자동 redirect를 끈 뒤, 301/302/303/307/308의 각 목적지를 다시 검사합니다. 허용 목록 밖으로 나가는 redirect는 요청 전에 거부됩니다. Origin이 바뀌면 이전 URL의 `headersByOrigin` 인증값은 전달하지 않습니다. 비-idempotent 요청의 307/308 redirect는 본문을 다른 경로에 재전송하지 않도록 차단합니다. 제한을 넘은 요청/응답 본문, timeout, scope 실패는 코드가 있는 `SCOPED_SESSION_*` 오류로 끝납니다. 모듈은 URL, 헤더, 쿠키, 본문을 로그에 쓰지 않습니다. `raw`는 서비스 응답 본문 그대로이므로 호출자가 민감 값으로 취급해 출력·공용 파일 저장을 피해야 합니다.

```js
const storedSession = session.toJSON();
// cookies와 headersByOrigin의 bearer 등이 포함된 민감 객체입니다.
// console 출력, 일반 파일 저장, 환경변수 저장을 하지 마세요.
const restored = ScopedSession.fromJSON(storedSession, { fetchImpl: globalThis.fetch });
```

`toJSON()`은 `{version, allowedOrigins, cookieOrigins, allowLoopbackHttp, defaultHeaders, headersByOrigin, cookieJar, timeoutMs, maxRequestBytes, maxResponseBytes, maxRedirects}`를 반환합니다. 여기에는 쿠키 값과 인증 헤더가 들어갑니다. `ProtectedStore`로 보호한 값만 저장하고, 재생성 시 service profile의 origin scope와 직렬화 상태가 일치하는지 adapter가 대조해야 합니다.

## `ProtectedStore`

```js
import { ProtectedStore } from '../lib/protected-store.mjs';

const store = new ProtectedStore({ directory: 'C:/Users/Me/AppData/Local/my-client/credentials' });
store.write('example-session', JSON.stringify(session.toJSON()));
const serialized = store.read('example-session');
const state = serialized === null ? null : JSON.parse(serialized);
const status = store.status('example-session');
```

`read(name)`, `write(name, value)`, `status(name)`은 동기 메서드입니다. `directory`는 선택 가능하며 `store.directory`에서 정규화된 절대 경로를 읽을 수 있습니다. 이름은 `^[a-z0-9][a-z0-9.-]{0,63}$`여야 합니다. 값은 UTF-8 문자열이며 최대 1 MiB입니다. Secret 값은 명령 인자나 환경변수로 넘기지 않고 PowerShell helper의 stdin으로만 전달합니다.

Windows에서는 provider를 지정하지 않으면 Windows DPAPI CurrentUser를 사용합니다. 파일 내용은 DPAPI 암호문입니다. 새 저장 디렉터리는 현재 사용자 ACL로 만들고, 이미 존재하는 사용자 지정 디렉터리의 ACL은 변경하지 않으므로 전용 경로를 지정하세요. DPAPI는 같은 Windows 사용자 컨텍스트에서만 복호화됩니다. 다른 OS에서는 기본값이 없습니다(`PROTECTED_STORE_PROVIDER_REQUIRED`). 명시적으로 `{ provider: 'memory' }`를 선택하면 현재 Node 프로세스 메모리에만 보관되며 재시작 후 사라집니다.

Linux/macOS 지속 저장은 opt-in `{ provider: 'file' }` 또는 환경변수 `PROTECTED_STORE_PROVIDER=file`입니다(인자 없이 `new ProtectedStore()`를 쓰는 기존 봇은 환경변수로 켭니다). 값마다 AES-256-GCM으로 봉인해 `<directory>/<name>.sealed`(0600, 디렉터리 0700)에 원자적으로 씁니다. 자격 증명 이름을 AAD로 묶어 다른 이름으로 파일을 바꿔치기하면 복호화가 실패합니다. 키는 `PROTECTED_STORE_KEY`(base64 32바이트, 서버리스·CI용) 또는 `PROTECTED_STORE_KEY_FILE`(기본 `~/.config/xhr-to-api-only/protected-store.key`, 첫 사용 시 0600으로 생성)입니다. 키 파일과 봉인 파일이 같은 사용자 계정에 있으므로 DPAPI CurrentUser와 같은 수준(같은 OS 사용자면 복호화 가능)이며, 키를 git·로그에 넣지 마세요. receipt provider는 `Linux AES-256-GCM file`입니다. 이 repo의 X 세션 클라이언트는 Node 24 이상이 필요합니다(`x-client-transaction-id`가 `ArrayBuffer.prototype.transfer` 사용).

## `withSessionLock`

```js
import { withSessionLock } from '../lib/session-lock.mjs';

await withSessionLock(async () => {
  // protected read → owner check → HTTP operation → rotation persist
}, {
  root: `${store.directory}/locks`,
  key: 'example-session',
  timeoutMs: 30_000,
  pollMs: 100,
});
```

`root`와 `key`가 필수입니다. `timeoutMs`, `pollMs`는 선택이며 기본은 30초와 100ms입니다. `processAlive(pid, hostHash)`를 주입할 수 있고, 기본 구현은 같은 host에서 OS PID를 확인합니다. lock 파일 이름은 key의 SHA-256이고, 파일에는 PID·host hash·시작 시각·임의 nonce만 둡니다. 같은 host의 종료된 PID 또는 2분 이상 된 잘못된 lock만 재검사 후 회수하며, 다른 host의 lock은 살아 있다고 간주합니다. 원래 host 이름은 기록하지 않습니다. 획득과 해제 모두 inode와 nonce를 확인합니다. 시간 초과는 `SESSION_LOCK_BUSY`입니다.

## `WriteJournal`

```js
import { WriteJournal } from '../lib/write-journal.mjs';

const journal = new WriteJournal({ root: './runtime/journal', service: 'example-service' });
const key = journal.key('publish', { path: '/posts' }, { title: '예시', body: '<실제 내용은 key hash 입력으로만 전달>' });
await journal.reserve(key, { operation: 'publish', targetPath: '/posts', contentHash: '<sha256>' });
// 여기에서만 service adapter가 외부 쓰기를 수행합니다. 이 모듈은 HTTP를 호출하지 않습니다.
await journal.finish(key, 'acknowledged_requires_readback', { responseStatus: 200, responseSha256: '<sha256>' });
const record = await journal.read(key);
```

`key(operation, target, content)`는 object key 순서를 정규화한 뒤 service/operation/target/content를 해시합니다. 원본 target과 content는 journal에 저장하지 않습니다. `reserve(key, safeRecord)`는 `{service}/{key}.json`을 `wx`로 한 번만 만듭니다. 같은 key가 있으면 `WRITE_JOURNAL_EXISTS`로 멈추며 원격 POST 재전송 근거가 되지 않습니다.

`finish(key, state, safeReceipt)`는 `reserved` 상태를 로컬 기록으로만 갱신합니다. state에 `unknown`, `uncertain`, `ambiguous` 또는 reconciliation 표현이 있으면 `needs-reconciliation`으로 남습니다. 응답 본문이나 인증값 대신 HTTP 상태와 응답 hash 같은 안전 메타데이터만 넣으세요.

```js
await journal.finish(key, 'outcome-unknown', { failureCode: 'TRANSPORT_FAILED' });
const before = await journal.read(key); // 기존 journal 확인
// 실제 서비스별 read-only 관리 목록/대상 readback을 수행하고 그 근거를 넘깁니다.
await journal.reconcile(key, {
  result: 'found', // 'not-found' 또는 'ambiguous'도 가능
  readbackHash: '<sha256>',
  referencePath: '/posts/123',
});
```

`reconcile()`은 caller가 이미 수집한 readback 결과를 journal에 기록할 뿐 HTTP 요청이나 새 쓰기를 수행하지 않습니다. `reserved`(프로세스가 요청 전 또는 응답 전에 종료됐을 수 있음), `needs-reconciliation`, 그리고 명시적으로 readback을 기다리는 완료 state에서 호출할 수 있습니다. `found`/`not-found`는 `reconciled`와 `manual-decision-required`로 기록하며, `ambiguous`는 계속 `needs-reconciliation`에 남습니다. 모든 결과가 원격 재시도를 자동 허용하지 않습니다. `safeRecord`와 `safeReceipt`는 민감 키, credential처럼 보이는 문자열, 절대 URL, raw request/response/body/content 필드를 거부합니다. 이 필터는 임의 텍스트 안에 감춘 비밀을 완벽히 탐지하지 못하므로 본문·쿠키·토큰은 전달하지 마세요.

## 내부 import

각 모듈은 Node ESM `.mjs`이며 내부 import도 확장자를 포함합니다. 패키지 root에서 다음 경로를 사용합니다.

- `lib/scoped-session.mjs`
- `lib/session-lock.mjs`
- `lib/protected-store.mjs`
- `lib/write-journal.mjs`
- `scripts/dpapi-store.ps1`
