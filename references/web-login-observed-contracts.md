# 웹 로그인 관측 계약 (2026-09-24)

현재 Windows 호스트에서 사용자의 정상 웹 로그인을 관측했다. 아래에는 경로와 필드 이름만 남긴다.
실제 인증값, 계정 이메일, 계정 ID, 메일 링크, 원본 응답 본문은 저장소에 포함하지 않는다.

## MyRealTrip

API origin: `https://api3-backoffice.myrealtrip.com`.
웹 origin/referer: `https://partner.myrealtrip.com`.
응답은 `{data,meta,result}`이며 정상 앱 상태는 `result.status=200`이다.

| 요청 | 입력 | 성공 응답 필드 | 증거 |
|---|---|---|---|
| `POST /partner/v1/sign-in` | JSON `email,password,isKeepSignIn,partnerId?` | `data.accessToken,refreshToken` 또는 `preAuthToken` | 브라우저 관측 + 독립 HTTP 비밀번호 로그인 성공 |
| `POST /partner/v1/sign-in/send-otp` | JSON `preAuthToken` | `loginAttemptId,codeExpiresIn,resendAvailableIn` | 브라우저 요청·이어지는 OTP 화면 상태 관측. HTTP 단독 제출 미실행 |
| `POST /partner/v1/sign-in/verify-otp` | JSON `loginAttemptId,code` | `data.accessToken,refreshToken` | 브라우저 POST 응답에서 토큰 필드 관측. HTTP 단독 제출 미실행 |
| `POST /authentication/v3/partner/token/refresh` | JSON `refreshToken` | `data.accessToken,refreshToken?` | 현재 앱 소스에서 발견 후 독립 HTTP 성공 |
| `POST /authentication/legacy/partner/token` | JSON `refreshToken` | refresh 응답 후보 | 앱 소스 후보. v3의 404/405일 때만 fallback. 라이브 미실행 |
| `GET /partner/v1/partners` | header `partner-access-token` | `data.id,email` | 브라우저 및 HTTP 계정 대조 성공 |

초기 연결:

1. 정상 로그인 화면에서 자동완성된 계정으로 로그인한다. 로그인 POST는 XHR/Fetch 요청 본문으로만 취득한다.
2. `email,password,isKeepSignIn,partnerId?`만 `scripts/web-auth-import.mjs myrealtrip-login`의 stdin으로 전달한다.
3. 추가 이메일 확인이 있으면 현재 로그인 시도에 해당하는 메일 코드만 정상 화면에 제출한다.
4. 필요하면 `verify-otp`의 **XHR/Fetch 응답 단계**를 일시 관측해 토큰을 `web-login.mjs myrealtrip import-tokens` stdin으로 전달한다.
5. 보호 계정 대조 뒤 HTTP `ensure`/`refresh`를 사용한다. 인터셉트는 완료 후 비운다.

로그인 자체의 비밀번호 입력과 이메일 OTP는 서로 다른 단계다. 메일 커넥터를 사용한 최초 OTP 처리와
상시 무인 코드 공급자를 동일한 기능으로 기록하지 않는다.

## Coupang Partners

| 요청 | 계정/응답 판정 | 증거 |
|---|---|---|
| `GET https://partners.coupang.com/api/v1/config` | `rCode="0"`, `data.member.valid`, `member.email`, `affiliate.affiliateCode` | 브라우저 + 독립 HTTP 계정 대조 성공 |
| `GET https://partners.coupang.com/api/v1/prelogin` | 포털 config의 `settings.loginUrl`에서 발견. 파트너/쿠팡 로그인 origin 내 리다이렉트 후 config 대조 | 기존 세션에서 독립 HTTP 성공. 완전히 만료된 로그인 복구 증거는 아님 |
| `GET https://partners.coupang.com/api/v1/dashboard` | `data.categories,dailyTrend,monthlyAggregation` | 독립 HTTP 200, 스키마 확인 |

초기 연결은 해당 포털에 적용되는 쿠키와 실제 config 요청의 User-Agent·Accept·Referer·lang·sec-ch-ua 계열만 전달한다.
`web-login.mjs coupang import-session` stdin은 `{cookies,email,affiliateCode,userAgent,headers}`이다.
`email`과 `affiliateCode`는 같은 브라우저 config 응답에서 취득하며 독립 HTTP로 일치를 확인한다.

쿠키·User-Agent만 전달한 요청은 403이었다. 같은 세션에 관측된 나머지 헤더를 전달하자 200이었다.
이를 비밀번호 실패, 세션 만료, 공식 API 키 부족으로 분류하지 않는다.

## X

| 요청/입력 | 역할 | 증거 |
|---|---|---|
| `GET https://api.x.com/1.1/account/settings.json` + 관측된 include/ext query | 보호된 `screen_name` 대조 | 독립 HTTP 성공 |
| `auth_token`, `ct0`, `twid` 쿠키 | 사용자 세션·CSRF 입력 | 관측 후 DPAPI import |
| `Authorization: Bearer …` | 웹 앱이 사용한 클라이언트 헤더 | 관측 후 해당 origin에만 적용 |
| `x-client-transaction-id` | 요청 method/path에 맞는 입력 | 캡처 값으로 성공한 뒤 새 HTTP 생성기로 성공 |
| `GET https://x.com/home`, 현재 `abs.twimg.com` ondemand JS | 새 transaction ID의 공개 HTML/JS 입력 | 순수 HTTP + HTML 파서. 페이지 JS 실행 없음 |
| `GET /graphql/<queryId>/UserByScreenName` | 공개 계정 조회 | 실제 수집기 HTTP 성공 |
| `GET /graphql/<queryId>/UserOriginalsTimeline` | 원본 게시물 수집 | `sama`, `elonmusk`, `DarioAmodei` HTTP 성공 |

현재 owner query는 관측된 `include_*=true`, `ext=ssoConnections`만 수용한다.
헤더가 없던 최초 계정 조회는 404/code 34였고, 캡처 transaction ID를 포함하면 200이었다.
이후 공개 소스 기반으로 매 실행 새 ID를 생성하여 같은 보호 조회와 업무 조회를 재현했다.

초기 연결 stdin은 `{cookies,handle,ownerUrl,authorization,userAgent}`이다.
쿠키는 현재 X 탭의 origin 범위에서만 가져오며, `handle`은 로그인된 화면 계정을 사용한다.
transaction ID 자체는 저장하지 않는다. 새 세션 import가 계정 대조에 실패하면 기존 저장 세션을 교체하지 않는다.

`rweb_conversational_replies_downvote_enabled=false`,
`fieldToggles={withPayments:false,withArticlePlainText:false}`는 현재 로그인된 `UserOriginalsTimeline` 요청에서 관측했다.
나머지 feature 기본값과 query ID는 매 실행 현재 웹 앱 소스에서 읽는다.

로그아웃된 다른 프로필에서는 `POST /i/jfapi/onboarding/web/actions/begin_login`의
`username_or_email,$castle_token` 입력과 비밀번호 화면까지 관측했다. 비밀번호 제출 및 Castle 입력의
HTTP 생성/갱신은 구현하지 않았다. 기존 저장된 `auth_token` 재사용을 비밀번호 로그인 완료라고 기록하지 않는다.

## 추가 계정 상태와 미완료 구간

LinkPrice의 후속 비밀번호 로그인·등록 사이트 조회 계약과 독립 HTTP 성공은
[별도 관측 문서](linkprice-login.md#관측-계약)에 추가했다.

- **Reddit:** `POST /svc/shreddit/account/login/magic_link/initialize`의
  `identifier,csrf_token`, 이어지는 magic-link 로그인 POST의
  `user_id,token,recaptcha_token,recaptcha_action,csrf_token` 필드를 관측했다.
  정상 이메일 링크 로그인 후 계정 영구 이용 정지가 표시됐다. 수집 실행기·자동 재로그인은 활성화하지 않았다.
  `scripts/protected-input.mjs`는 커넥터의 일회용 링크를 숨김 stdin으로 전달했던 bootstrap 도구이며 갱신기가 아니다.
- **Adpick:** 네이버 OAuth authorize → `https://www.adpick.co.kr/apis/sns-callback.php` 경로를 관측했다.
  네이버의 저장 자동완성 로그인 후 계정 보호조치 페이지가 표시됐다. callback 성공/Adpick 세션은 미취득이다.
  본인 확인·비밀번호 변경은 사용자가 처리해야 한다. 네이버 쿠키·비밀번호는 이 Playbook 실행기로 저장하지 않았다.
- **OliveYoung·Brand Connect·검색광고:** 이번 실행에서 로그인 관측/재현을 하지 않았다.

계정 보호조치·이용 정지는 재시도 루프로 처리하지 않는다. 관측되지 않은 성공 응답이나 갱신 API를 추측해 채우지 않는다.
