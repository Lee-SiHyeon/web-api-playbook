# 외부 XHR 클라이언트 로그인 실측 (2026-10-04)

사용자가 지정한 네 레포를 Linux 워커에 clone하고 기존 인증 코드를 확인했다.
로그인과 안전한 계정 조회만 진행했고 콘텐츠 생성·대화 전송·계정 생성은 수행하지 않았다.

| 레포 | revision | 실제 단계 |
|---|---|---|
| `Lee-SiHyeon/gemini-web-xhr-client` | `bcd5249dae4513396422bc794c91ef7c02381743` | Google 이메일 제출 뒤 브라우저 보안 거부 |
| `Lee-SiHyeon/grok-web-xhr-client` | `1eaa9d7d87a25212fd9b2f333849e20945eea5f8` | 정상 sign-in 진입 후 이메일 확인 POST 403 |
| `Lee-SiHyeon/chatgpt-web-xhr-client` | `9c0b60ce60e39c329df8623389b220a89fb9c6ad` | ChatGPT 이메일 → Google SSO → 브라우저 보안 거부 |
| `Lee-SiHyeon/google-flow-xhr-client` | `85d0f71919db8dd12117efd1f9abb4158ab4abd1` | 공개 앱 진입 뒤 Google 로그인 요구 |

네 checkout의 origin·HEAD·clean 상태를 다시 확인했다. 비밀번호 제출은 모두 0회이며
로그인 완료·현재 사용자 확인·인증 HTTP replay는 미확인이다. 비밀번호 불일치로 해석하지 않는다.
Gemini·ChatGPT·Grok의 현재 코드에는 로그인 producer/보호 계정 계약의 미완료 경계가 있다.
저장 provider나 공개 모델 status 성공은 인증 획득 증거가 아니다.
Flow의 브라우저 페이지 bridge도 전체 로그인과 엔진 제거를 증명하지 않는다.

## Google UA와 Playwright

초기 Google의 실제 UA는 Linux Chrome 151이며 `HeadlessChrome`이 없었다.
Playwright로 제어했고 `navigator.webdriver=true`를 실제 확인했다.
headed 실행과 sandbox 활성 브라우저에서도 이메일 단계가 거절됐다.

추가 실험은 설치된 일반 Chromium 149에서 직접 얻은 Linux UA를
같은 플랫폼의 headed Chromium 151 context에 설정했다. webdriver·보안 설정을 숨기거나 변경하지 않았다.
Google 이메일을 한 번 제출한 결과 다시 `/v3/signin/rejected`,
`This browser or app may not be secure.`였고 비밀번호 단계는 나타나지 않았다.
이번 UA 변경이 해결하지 못했다는 증거이며 모든 UA·네트워크에 대한 일반 결론은 아니다.

[Google 지원 브라우저 안내](https://support.google.com/accounts/answer/7675428?hl=en)는
소프트웨어 자동화로 제어되는 브라우저의 로그인을 제한할 수 있다고 설명한다.
자동화 인식은 가능한 원인이지만 실제 서버 판정 이유는 확정하지 않았다.

## Grok과 Cloudflare

초기 `/check-login`에서는 Cloudflare 차단 화면과 HTTP 403을 관측했다.
후속 일반 sandbox 활성 headed Chromium에서는 sign-in 화면까지 진행됐다.
이메일을 한 번 제출한 `POST /api/auth/sso/check`는 403 HTML과
`Something went wrong. Please try again.` 오류를 반환했다.
이 POST 응답 본문은 저장하지 않아 후속 403을 Cloudflare 차단으로 추가 분류하지 않았다.

쿠키 없는 공개 `/sign-in` GET를 같은 워커·HTTP 도구에서 각각 한 번 비교했다.
기본 HTTP UA는 Cloudflare HTML 403, 실제 일반 Chromium UA는 HTML 200이었다.
공개 화면 차이이며 이메일 확인·비밀번호·보호 API 성공 증거가 아니다.
[Cloudflare 공식 안내](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)는
clearance cookie가 방문자와 기기에 묶인다고 설명한다. 다른 환경의 쿠키 복사를 검증된 해결책으로 취급하지 않는다.

## 진단 기록

- provider 준비, 브라우저 gate, 자격정보 제출, app identity, 독립 HTTP 실행을 분리한다.
- URL은 query 없이 origin/path만 보관하고 실제 상태·오류 메시지를 기록한다.
- 요청된 blocker screenshot은 현재 task-owned 브라우저에서 native capture한다.
  토스트가 이미 사라졌으면 당시 DOM/네트워크 증거와 현재 PNG의 차이를 명시하고 이미지를 재구성하지 않는다.
- 비밀번호·쿠키·token은 인수·로그·Git·스크린샷에 넣지 않는다.
- 미검증 403을 비밀번호 오류나 세션 만료로 바꾸어 설명하지 않는다.

민감값 없는 [종합 검증 JSON](../verification/provider-login-2026-10-04.json)에 단계별 결과를 남겼다.
실제 PNG는 작업 산출물로 전달했으며 계정 정보·브라우저 profile은 이 저장소에 포함하지 않았다.
