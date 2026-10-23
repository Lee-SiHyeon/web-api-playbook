# Flow 웹 크레딧 생성의 브라우저 없는 토큰 발급 조사

2026-09-27 기준. 대상은 `flow.google.com`의 Gemini Omni Flash 생성과 **Flow 웹 크레딧**이다. 별도 Gemini Developer API 과금은 대상이 아니다.

## 결론

공개된 Google 공식 문서와 관측한 생성 XHR에서 Flow의 `YhhmEf` 요청에 넣을 새 reCAPTCHA Enterprise 토큰을 **브라우저 없이, 독립 HTTP 호출로 발급하는 지원 경로를 확인하지 못했다**. 이는 확인 범위의 결론이며 비공개 내부 경로가 없다는 증명은 아니다. 현재 `generate`는 `CAPTCHA_BROWSER_REQUIRED`로 생성 POST 이전에 멈춘다.

## 직접 관측

- Flow 화면에서 `grecaptcha.enterprise.execute()`가 호출되며 reCAPTCHA의 `/recaptcha/enterprise/reload` POST가 발생했다.
- 해당 응답의 토큰과 직후 `YhhmEf` 요청의 토큰 필드가 일치했다. 토큰 값은 증거 파일에 저장하지 않았다.
- 정상 브라우저 생성 1건과 이후 읽기·다운로드의 직접 HTTP 실행은 확인했다. 새 생성의 직접 HTTP POST는 0건이다.
- 자세한 비밀값 제거 추적: [full-generation-xhr-trace-2026-09-27.json](full-generation-xhr-trace-2026-09-27.json).

## 공식 경로 검토

| 후보 | Google 문서의 기능 | Flow `YhhmEf` 토큰 발급에 대한 판정 |
| --- | --- | --- |
| 웹 `grecaptcha.enterprise.execute()` | 웹 페이지의 클라이언트 코드가 토큰을 반환한다. 토큰은 1회용이며 2분 후 만료된다. | 관측한 Flow 경로와 일치하지만 브라우저 없는 HTTP 발급 경로가 아니다. |
| reCAPTCHA Enterprise `projects.assessments.create` | 클라이언트가 **이미 발급받은** 토큰을 서버에서 평가한다. | 토큰 발급 API가 아니다. |
| reCAPTCHA Express | 자신의 Express 키로 클라이언트 토큰 없이 서버 측 위험 평가를 만든다. | Flow 웹 키의 일회성 토큰을 생성하거나 `YhhmEf`의 토큰 필드를 대체하지 않는다. |
| Android reCAPTCHA SDK | 앱용 키와 Android SDK의 `execute()`로 앱 토큰을 발급한다. | 브라우저는 쓰지 않지만 앱 런타임이 필요하며 Flow 웹 키용 순수 HTTP 발급 경로가 아니다. |
| Flow 공개 도움말 | Flow 웹 또는 앱에서의 사용과 크레딧 비용을 안내한다. | 조사한 문서에 Flow 크레딧용 생성 REST API가 안내되어 있지 않다. |

관측한 `/recaptcha/enterprise/reload`는 웹 SDK가 실행 중 보낸 요청이다. 이 사실만으로 외부 클라이언트용 독립 발급 계약이나 허용된 재현 경로가 성립하지 않는다. 요청 본문 재현, 브라우저 지문 모방, 과거 토큰 재사용은 구현하지 않았다.

## 근거 문서

- [Google Cloud: 웹사이트용 reCAPTCHA 평가 만들기](https://docs.cloud.google.com/recaptcha/docs/create-assessment-website) — 웹 `execute()` 토큰과 서버 평가, 1회 사용 및 2분 만료.
- [Google Cloud: 웹사이트에 점수 기반 키 설치](https://docs.cloud.google.com/recaptcha/docs/instrument-web-pages) — 클라이언트 `execute()` 발급 흐름.
- [Google Cloud: reCAPTCHA Express 서버 설정](https://docs.cloud.google.com/recaptcha/docs/express-standalone) — 토큰 없는 자체 서버 측 평가.
- [Google Cloud: Android 앱 통합](https://docs.cloud.google.com/recaptcha/docs/instrument-android-apps) — 앱용 키와 모바일 SDK.
- [Google Flow 시작하기](https://support.google.com/flow/answer/16353333?hl=en) 및 [Flow 크레딧 관리](https://support.google.com/flow/answer/16526234?hl=en) — Flow 사용 경로와 생성별 크레딧 비용.

완전한 API-only 생성 전환에는 Google이 Flow 크레딧에 적용되는 공식 서버 측 생성 계약 또는 Flow 웹용 토큰의 승인된 서버 측 발급 방식을 제공해야 한다. 그 전까지 생성 기능을 성공으로 표기하지 않는다.

## 2026-09-29 재검증

공식 문서를 다시 확인했다. 웹 통합은 `grecaptcha.enterprise.execute()` 결과에서 토큰을 받으며, 각 토큰은 한 번만 사용할 수 있고 2분 후 만료된다. `projects.assessments.create`는 이미 클라이언트에서 발급된 토큰을 평가 입력으로 받는다. 공개 REST API 카탈로그에는 assessment와 key 관리 리소스가 나열되어 있고 Flow용 토큰 발급 메서드는 문서화돼 있지 않다. 공개 카탈로그 검토만으로 비공개 내부 구현의 부재까지 증명한다고 해석하지 않는다.

- 브라우저 생성 버튼 관측에서는 reCAPTCHA Enterprise의 first-party `reload` POST가 HTTP 200으로 끝났고, 이어진 Flow 생성 XHR의 토큰 입력과 연결됐다. 비밀값은 기록하지 않았으며 재사용하지 않았다.
- 최신 보호 세션 Node `status` 재실행은 프로젝트 HTML HTTP 200을 받은 뒤 필수 문서 토큰 `SNlM0e`를 찾지 못해 중단됐다. 로그아웃 여부는 결론내리지 않았고 Flow RPC는 전송되지 않았다.
- `reload` 내부 요청을 Node에서 재현하거나 reCAPTCHA SDK의 브라우저 동작을 모방하지 않았다. 이것은 공개된 Node HTTP 발급 계약이 아니며 anti-abuse 토큰을 우회 발급하는 경로가 될 수 있기 때문이다.
- 안전 상태: issuance `captured=true`(정상 브라우저 경로), issuance `client_exists=false`, issuance `remnant_free=false`, issuance `live_replay=false`. 생성 guard 검증은 3/3 통과했으며 최신 status 실패 지점에서 RPC 전송 0건이다.

따라서 2026-09-29 현재도 순수 Node HTTP 발급이나 Flow 생성 전환은 완료되지 않았다. 문서화된 Flow 서버 측 생성 계약 또는 Flow가 승인한 서버 측 토큰 발급 입력이 확인되기 전에는 완료로 표시하지 않는다.
