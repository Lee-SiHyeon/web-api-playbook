# 세션·토큰 갱신 (허용된 경로만)

확인일: 2026-10-14. 인증 수명주기는 [client-reliability.md](client-reliability.md)와 [browserless-login-flow.md](browserless-login-flow.md)를 따른다. 이 문서는 해외 커머스에 맞춰 **허용된 갱신만** 요약한다.

## 허용

| 종류 | 방법 | 예 |
|---|---|---|
| OAuth client credentials | 문서화된 token 엔드포인트로 client id/secret → access token, 만료 전 재발급 | Amazon Creators API LwA (`api.amazon.com/auth/o2/token` 등) |
| 서명된 앱 호출 | AppKey/AppSecret으로 매 요청 서명 (세션 쿠키 없음) | AliExpress Affiliate TOP/IOP |
| 네트워크 publisher 토큰 | Awin/Impact/Rakuten Advertising이 발급한 토큰을 메모리/stdin으로 주입 | 기존 `lib/commerce/awin.mjs`, `impact.mjs` |
| 로그인된 브라우저에서 받기 | 사람이 정상 로그인한 자동화 브라우저의 쿠키를 loopback CDP로 읽어 수신자별 일회용 키로 암호화해 보호 저장소에 넣기. 기기 바인딩 쿠키는 브라우저가 갱신하게 두고 유예 시간 안에 주기적으로 다시 받는다 | Google Flow 멀티 슬롯 ([2026-10-24](google-bound-session-multislot-2026-10-24.md)) |
| 서버 Set-Cookie 회전 | **이미 허용된 origin**에서 응답이 내려준 쿠키를 같은 jar에 갱신 | 검증된 공개 세션 부트스트랩에 한함 |

갱신 성공 후 **안전한 GET 한 번**만 재시도한다. 쓰기는 재시도하지 않는다.

## 금지

- 스토어프런트 로그인 폼을 헤드리스로 돌리거나, 이메일 OTP·SMS를 자동화해 “세션을 새로 뽑기”.
- 다른 서비스·다른 계정의 쿠키를 origin에 붙이기.
- 기기 바인딩 세션(Chrome bound-session credentials, DBSC)의 키를 꺼내거나 흉내 내서 브라우저 없이 바인딩 쿠키를 갱신하기. 쿠키 탈취 방어 장치다.
- refresh를 실패할 때마다 무한 반복하기. 한 번 실패하면 `reauth_required`로 남기고 사람에게 정상 로그인을 요청한다.

## 기록

비밀 값을 남기지 말고 `provider`, `lastAuthenticatedCheckAt`, `expiresAt`(알 때), `reauthRequired`만 남긴다.
