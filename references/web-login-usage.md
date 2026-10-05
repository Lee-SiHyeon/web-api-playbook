# 웹 로그인·저장 세션 사용법

이 실행기는 사이트의 웹 로그인과 보호 조회 요청을 사용한다. 개발자 API 키는 입력으로 받지 않는다.
인증값은 현재 Windows 사용자의 DPAPI로 `.config/xhr-to-api-only/credentials`에 저장한다.
`git clone`으로 인증값까지 옮겨지지는 않는다.

## 설치와 상태

저장소 루트에서 Node.js 24 이상으로 실행한다.

```powershell
npm ci --ignore-scripts
node scripts/web-login.mjs myrealtrip status
node scripts/web-login.mjs coupang status
node scripts/web-login.mjs x status
```

`status`는 파일 존재 확인이다. 실제 인증은 `health` 또는 `ensure`로 확인한다.
최초 브라우저 관측 위치와 요청·응답 필드는 [관측 계약](web-login-observed-contracts.md)에 있다.

## 마이리얼트립

```powershell
# 보관된 세션 확인 → 만료 시 refresh → refresh 거절 시 저장된 비밀번호로 로그인
node scripts/web-login.mjs myrealtrip ensure

# 각각의 단계를 명시적으로 실행
node scripts/web-login.mjs myrealtrip health
node scripts/web-login.mjs myrealtrip login
node scripts/web-login.mjs myrealtrip refresh

# 사용자 요청에 따라 오래된, 응답이 확정된 OTP 대기를 새 로그인으로 교체
node scripts/web-login.mjs myrealtrip login-new
```

최초 로그인 정보는 `scripts/web-auth-import.mjs myrealtrip-login`의 stdin으로 전달한다.
형식은 `{email,password,isKeepSignIn:true,partnerId?}`이다. 값은 승인된 브라우저의 실제 로그인 요청에서
직접 child stdin으로 전달하거나 사용자의 비밀 입력 도구로 입력한다. 명령 인수나 파일에 적지 않는다.
브라우저 저장 비밀번호 DB를 열지 않는다.

이메일 OTP가 요구되면 `login`/`ensure`는 `next:"otp-send"`를 반환한다.

```powershell
node scripts/web-login.mjs myrealtrip otp-send
# 승인된 이메일 코드 공급자가 {"code":"6자리 실제 코드"} JSON을 stdin으로 전달
# node scripts/web-login.mjs myrealtrip otp-verify
```

`otp-send`는 서버가 발급한 `loginAttemptId`와 유효시간을 보호 저장한다.
`otp-verify`는 그 시도의 코드만 제출한다. 코드 조회는 실행 중인 에이전트의 승인된 메일 연결이나
별도 코드 공급자가 맡는다. CLI 자체에는 Gmail 자동 조회가 연결되어 있지 않다.
발송·확인 응답이 모호하면 `*_outcome_unknown`으로 남기고 자동 재전송하지 않는다.
비밀번호 로그인·refresh도 전송 전에 같은 방식으로 기록한다. 다음 CLI 실행이 자동 재전송하는 것도 막는다.
이 경우 보호 조회로 기존 세션을 확인하고 관측 증거를 대조한다. 상태 파일을 지워 성공으로 처리하지 않는다.
OTP 입력이 진행 중이면 `ensure`가 기존 `otp-send`/`otp-verify` 단계를 반환한다.
`login-new`는 응답이 확정된 OTP 대기를 명시적으로 교체한다. `*_outcome_unknown` 상태는
이 명령으로도 다시 전송할 수 없으며 기존 시도를 대사해야 한다.

업무 API도 같은 저장소를 쓴다. 기존 service-pack의 operation/input 형식을 유지하며 session은 넣지 않는다.

```powershell
'{"operation":"searchAirports","input":{"keyword":"ICN"}}' | node scripts/myrealtrip.mjs
```

`createLink`, `createFlightLink`는 실제 제휴 링크를 만드는 쓰기다. 해당 업무 지시와 입력이 있을 때만 실행한다.
기존 응답 모호성·링크 리드백 규칙이 그대로 적용된다.

canonical MyRealTrip CLI는 DPAPI 세션을 불러오므로 입력에 `session`이나 토큰을 넣지 않는다.
일반 상품 링크 `createLink`는 owner ID와 정규화된 전체 목적지 URL로 사용자 범위의 SHA-256 키를 만들고,
`%USERPROFILE%\.config\xhr-to-api-only\write-journals\myrealtrip`에 메타데이터만 저널링한 뒤 POST를 한 번 보낸다.
저널에는 URL 대신 owner/target 지문, 응답의 링크 ID와 단축 경로만 남긴다. 같은 키가 이미 있으면 생성하지 않는다.
응답이 불명확하거나 POST 직후 프로세스가 중단된 항목은 자동 재시도하지 않는다. 알려진 링크 ID와 경로가 저널에 있으면
같은 링크를 GET으로만 다시 검증하며, verification 실패도 링크 메타데이터와 함께 대사 대기로 보존한다.
MyRealTrip 링크 관리 목록 API는 이 경로에 연결되어 있지 않으며 not-found를 근거로 자동 재무장하지 않는다.

```powershell
# web-api-playbook repository root
'{"operation":"createLink","input":{"targetUrl":"<current observed allowlisted MyRealTrip URL>"}}' | node scripts/myrealtrip.mjs
# affiliate-content-operations repository root
'{"operation":"createLink","input":{"targetUrl":"<current observed allowlisted MyRealTrip URL>"}}' | node apps/affiliate-api-hub/scripts/myrealtrip.mjs
```

`createFlightLink`는 아직 두 단계 전체를 journal guard로 감싸지 않았다. 실행 결과의
`writeJournalCoverage: "uncovered_composite_createLink"` 표시는 이 제한을 나타낸다.

## 쿠팡 파트너스 웹 포털

```powershell
node scripts/web-login.mjs coupang ensure
node scripts/web-login.mjs coupang health
node scripts/web-login.mjs coupang renew
node scripts/web-login.mjs coupang dashboard
```

최초 연결은 로그인된 포털에서 관측한 `{cookies,email,affiliateCode,userAgent,headers}`를
`node scripts/web-login.mjs coupang import-session` stdin으로 전달한다.
쿠키는 `partners.coupang.com`에 적용되는 범위만 취득한다. 이메일·affiliateCode는 같은 브라우저의
`GET /api/v1/config` 응답을 기준으로 묶고, 저장 전에 독립 HTTP 응답과 대조한다.

관측 헤더 중 Accept, Referer, lang, sec-ch-ua 계열을 재사용한다. 이 호스트에서는 쿠키·User-Agent만
보낸 요청이 403이었고 관측된 헤더를 포함하면 200이었다. 403을 곧바로 로그아웃이라고 간주하지 않는다.
쿠키 회전은 각 HTTP 응답에서 DPAPI에 저장한다. `renew`는 관측된 `/api/v1/prelogin` SSO 리다이렉트를
거쳐 계정을 다시 확인한다. **쿠팡 비밀번호 입력부터의 로그인은 아직 구현하지 않았다.**

## X 웹 세션과 수집기

```powershell
node scripts/web-login.mjs x health
node scripts/web-login.mjs x ensure
node scripts/x-read.mjs sama 3
node scripts/x-read.mjs elonmusk 3
node scripts/x-read.mjs DarioAmodei 3
```

최초 연결은 현재 X 계정에서 관측한 `{cookies,handle,ownerUrl,authorization,userAgent}`를
`node scripts/web-login.mjs x import-session` stdin으로 전달한다.
`ownerUrl`은 실제 `https://api.x.com/1.1/account/settings.json` 요청 URL이어야 한다.
auth_token·ct0·twid와 웹 앱의 Authorization만 저장하고, 화면의 계정과 `screen_name`을 대조한다.

매 프로세스가 X의 현재 HTML·공개 JS를 HTTP로 읽고 `x-client-transaction-id`를 새로 생성한다.
DOM 파서는 HTML만 해석하며 브라우저 엔진이나 페이지 JavaScript를 실행하지 않는다.
토큰이나 쿠키를 공개 CDN으로 보내지 않는다. 생성한 transaction ID는 저장하지 않는다.
구현은 [x-client-transaction-id 0.3.1](https://github.com/Lqm1/x-client-transaction-id)을 고정 사용한다.

**X의 비밀번호·Castle 입력부터 시작하는 로그인은 미완료다.** auth_token이 서버에서 거절되면
`REAUTH_REQUIRED`로 멈춘다. 저장 세션 재사용·서버 쿠키 회전과 완전히 만료된 로그인 복구를 구분한다.

`x-read.mjs HANDLE [LIMIT]`은 1~30개를 선택한다. 응답에는 `items`, 잘린 페이지의 `remainder`,
`nextCursor`, HTTP receipt를 포함한다. 최대 2페이지이며 전체 타임라인이나 최신순 정렬 완료를 보장하지 않는다.
현재 작성/삭제 API는 이 저장 세션 실행기에 연결하지 않았다.

## 링크프라이스

```powershell
node scripts/web-login.mjs linkprice ensure
node scripts/web-login.mjs linkprice sites
```

저장 비밀번호로 HTTP 로그인하여 Bearer·CSRF를 받고 보호 계정을 대조한다.
새 프로세스의 저장 세션 재사용과 등록 사이트 조회도 확인했다.
`ensure`는 토큰의 만료 힌트 또는 서버 401에 따라 동일 비밀번호 로그인으로 복구하도록 구현했다.
최초 연결, 정확한 요청 필드, `text/html` MIME을 가진 JSON 응답 처리,
실제 만료 복구의 미관측 경계는 [LinkPrice 사용법](linkprice-login.md)에 있다.

## 재사용 인터페이스

```js
import { createMyrealtripAuth } from './lib/web-auth/myrealtrip.mjs';
import { createXAuth } from './lib/web-auth/x.mjs';

// callback 안에서만 사용한다. 인증값을 return/console.log 하지 않는다.
await createMyrealtripAuth().withSession(async (session, authReceipt) => {
  // 기존 MyRealTrip 클라이언트에 session을 전달한다.
});
await createXAuth().withSession(async session => {
  // X 읽기 클라이언트에 session과 session.fetchImpl을 함께 전달한다.
  // fetchImpl은 허용된 GET GraphQL 요청만 전송하고 쿠키 회전을 보관한다.
});
```

계정 보호 조회·갱신·업무 실행을 동일 서비스 잠금 안에서 처리한다.
정상 종료/예외 모두 비밀값을 콘솔에 출력하지 않는다. 일반 CLI는 오류 코드만 반환하며 실패 시 exit code 2를 사용한다.

## affiliate-content-operations에 연결

두 저장소를 같은 상위 폴더에 clone하고 playbook 루트에서 `npm ci --ignore-scripts`를 실행한다.
다른 배치에서는 비밀이 아닌 `WEB_API_PLAYBOOK_ROOT`에 이 저장소의 절대 경로를 지정한다.

```powershell
$env:WEB_API_PLAYBOOK_ROOT = 'C:\work\web-api-playbook'
cd C:\work\affiliate-content-operations
node apps/affiliate-api-hub/scripts/web-auth.mjs myrealtrip ensure
node apps/affiliate-api-hub/scripts/web-auth.mjs coupang dashboard
node apps/affiliate-api-hub/scripts/web-auth.mjs x health
```

X의 기존 `fetchXXhr`는 playbook 세션이 있으면 같은 계정 조회·HTTP 서명 생성·쿠키 저장 경로로 실행한다.
개발자 API v2로 전환하지 않는다. 현재 웹의 `UserOriginalsTimeline` 계약을 사용하며 신규 쓰기를 하지 않는다.

## 2026-09-24에 실제로 확인한 범위

| 서비스 | 독립 HTTP 성공 | 남은 경계 |
|---|---|---|
| MyRealTrip | 저장 비밀번호 로그인, refresh, 만료 후 자동 refresh, 계정 확인, 공항 검색 | 최초 이메일 OTP는 브라우저에서 완료. HTTP OTP 상태 머신은 구현되었지만 라이브 제출은 미실행. 메일 코드 공급자 상시 연결은 별도 |
| Coupang | 웹 세션 import, config 계정 일치, prelogin 경유 재확인, dashboard | 비밀번호부터의 로그인, 완전히 만료된 쿠팡 세션 복구 |
| X | 직접 생성 transaction ID, 계정 확인, Altman·Musk·Amodei 사용자 타임라인 | 비밀번호·Castle부터의 로그인, auth_token 만료 후 재발급 |
| LinkPrice | HTTP 비밀번호 로그인, Bearer·CSRF 발급, 최소 필드 계정 대조, 새 프로세스 세션 재사용, 등록 사이트 조회 | 실제 만료/강제 폐기 후 자동 복구와 추가 챌린지 분기는 미관측 |
| Reddit | 정상 이메일 링크로 브라우저 로그인 후 영구 이용 정지 표시 | 계정 제한 해결 필요. 무인 로그인·수집 미연결 |
| Adpick | 네이버 OAuth 진입 후 네이버 계정 보호조치 표시 | 본인 확인·비밀번호 변경을 사용자에게 인계. Adpick 세션 미취득 |

원본 쿠키·토큰·메일 코드는 이 문서나 관측 기록에 기록하지 않는다.
위 기록은 해당 날짜의 결과다. 상세 단계별 증거는 [실행 기록](../verification/web-login-2026-09-24.json)을 참조한다.

## 2026-10-05 MyRealTrip 재검증

비밀번호 로그인 → 이메일 OTP 제출 → owner 보호 조회 → refresh → 새 프로세스 DPAPI 세션 확인을
독립 HTTP로 확인했다. `createLink`는 한 번 생성했고 독립 301 Location으로 목적지와 attribution을 대조했다.
같은 입력을 새 프로세스에서 실행했을 때 GET 검증만 수행하고 POST를 재전송하지 않았다.
이는 로그인·일반 링크 범위의 확인이며 상품 가격 수집이나 `createFlightLink` 전체 저널 검증을 뜻하지 않는다.
비밀값을 제외한 [확인 기록](../verification/myrealtrip-flow-2026-10-05.json)을 참조한다.
