# Naver 로그인 XHR와 브라우저 없는 실행 — 2026-09-23

대상은 Windows의 `aicandoanything` 블로그다. 실제 로그인 ID와 블로그 주소는 다르다.
비밀번호·쿠키는 현재 사용자 DPAPI에만 저장하며 원문 인증값·복구 토큰을 문서·로그·Git에 넣지 않는다.

## 현재 확인된 범위

| 항목 | 결과 |
|---|---|
| 폼·P-256 공개 키 | Node HTTP GET 성공 |
| `eccpw` | Node crypto 생성, 실제 새 로그인 성공 |
| `wtoken` | Node + jsdom + 원본 SDK/WASM 발급 성공 |
| 영수증 인증 | HTTP 문제·이미지 수신, 에이전트 답안 제출, HTTP 302 및 `chp` 확인 |
| 브라우저 없는 새 로그인 | 기존 인증 쿠키 없이 새 쿠키·보호된 소유자 조회까지 1회 성공 |
| 위 Node 세션의 프로세스 간 재사용 | 실패. 이후 계정 보호조치 관측 |
| 계정 복구 | 사용자가 본인확인·비밀번호 변경 후 정상 Chrome 로그인 성공 |
| 현재 저장 세션 | 복구 세션을 DPAPI에 저장, 별도 Node 소유자 조회 HTTP 200 |
| 현재 ID·비밀번호 | 변경된 비밀번호로 DPAPI 갱신 완료 |
| 이미지 전용 Codex CLI | `gpt-6-luna` 연결, 실제 샘플 영수증 정답 반환·도구 호출 0회 확인 |
| 세션 우선 자동 진입점 | `login:auto` 구현, 저장 세션 HTTP 200·로그인 POST 0회 확인 |
| 완전 무인 재로그인 | 새 이미지 공급자를 포함한 실제 네이버 재로그인은 미검증. 보호조치 복구는 사용자 처리 |

Node 새 로그인 성공과 현재 복구 세션의 HTTP 재사용은 서로 다른 실행 기록이다.
브라우저 없는 로그인 가능성은 확인했지만 안정적인 무인 운영까지 증명하지 않았다.

## 실행 기록

1. `login-node-browserless-live-v2-20260923.json`: 20:16:55 KST 시작.
   DPAPI의 ID·비밀번호만 읽고 빈 쿠키 저장소에서 시작했다. 초기 로그인 POST 1회,
   영수증 답안 POST 1회, 서버가 준 `chp` 후속 로그인 POST 1회로 새 쿠키를 받았다.
   소유자 조회·세션 저장 성공. SDK와 HTTP에 브라우저 엔진을 사용하지 않았다.
2. 직후 별도 프로세스 세션 확인에서 인증 쿠키가 삭제돼 `AUTH_MISSING`이 발생했다.
   로그인 프로세스의 Node/jsdom User-Agent가 저장·복원 과정에서 누락된 것을 찾았다.
3. 후속 `v4` 시도는 CAPTCHA를 통과했지만 `/user2/help/idSafetyRelease`로 이동했다.
   Chrome에서도 보호조치 화면과 본인 명의 휴대전화 인증 요구를 확인했다.
   서버의 정확한 판단 원인은 알 수 없으며 User-Agent 누락만이 원인이라고 단정하지 않는다.
4. 사용자가 본인확인과 비밀번호 변경을 완료했다. 새 비밀번호로 정상 Chrome 로그인 후
   블로그 관리 화면에 진입했다. 쿠키와 실제 세션 User-Agent를 암호화해 인계했다.
5. `session-recovered-after-password-change-20260923.json`: 20:26:50 KST.
   새 Node 프로세스가 DPAPI만 읽어 관리자 루트 HTTP 200, 계정 일치, 관리자 화면을 확인했다.
   새 비밀번호도 숨김 stdin과 소유자 확인을 거쳐 DPAPI에 반영했다.
6. `login-auto-session-reuse-20260923.json`: 20:38:26 KST.
   새 자동 진입점이 저장 세션으로 소유자 HTTP 200을 확인했다. 로그인 POST와 모델 호출은 모두 0회다.
7. `codex-luna-login-image-provider-v6-20260923.json`: 20:43:59 KST 시작.
   Codex CLI 0.156.1과 `gpt-6-luna`를 실제 호출했다. 합성 영수증에서 주문번호 정답을
   6.7초에 반환했고, 도구 호출 0회·임시 파일 삭제를 확인했다. 네이버 로그인 POST는 0회다.
   이 기록은 이미지 공급자 확인이며 실제 네이버 CAPTCHA 통과 증거가 아니다.

## 원본 SDK의 Node 실행

`naver-login-token-provider.mjs`는 원본 네이버 SDK와 WASM을 Node에서 실행한다.
`jsdom 26.1.0`은 DOM 호환 계층이며 Chrome/Chromium/Playwright를 실행하지 않는다.
원본 SDK의 `POST https://ncpt.naver.com/v2/tokens`는 `text/plain`이며 HTTP 200,
`tokenId`, 44자 콜백 토큰을 확인했다. 실제 값은 출력하지 않는다.

SDK는 제한된 별도 Node 프로세스에서 실행한다. 비밀번호·저장 쿠키를 넘기지 않으며
허용한 SDK 파일과 토큰 경로만 요청한다. SDK 프로세스가 종료된 뒤 로그인 POST를 보낸다.
User-Agent는 실제 Node/jsdom 실행을 나타낸다. 캔버스 미구현 경고가 있었지만 토큰이 발급됐다.
토큰 발급 성공만으로 로그인 성공을 판정하지 않는다.

## 로그인과 영수증 인증 계약

- `GET nid.naver.com/nidlogin.login`: 현재 폼·동적 키·숨김 필드.
- `GET /login/dynamicEcKey/{dynamicKey}`: 세션 키와 P-256 공개 키.
- `POST /nidlogin.login`: `eccpw`, 새 `wtoken`, 관측된 폼 필드. 평문 `id`·`pw`는 비움.
- `GET rcaptcha.nid.naver.com/rcapt.js`, `/rcaptUi`: 해당 인증의 스크립트·폼.
- `GET /question`: `receiptData.image`의 PNG data URI와 `receiptData.question`.
- `GET /verifyJs`: 별도 원본 SDK 토큰 제출, 실제 HTTP 200 확인.
- `POST nid.naver.com/nidlogin.rcaptcha`: `captcha` 답안, 새 `wtoken`, 같은 도전의 21개 필드.
- 서버 `chp` 수신 후 새 폼·공개키·토큰으로 후속 로그인 1회.

`eccpw`는 P-256 ECDH 공유값의 hex 문자열을 SHA-256한 키로 AES-CBC 암호화한다.
폼의 추가·중복 필드와 대상 URL 변경은 거절한다. CAPTCHA 이미지는 초기 HTML에 없고
`rcapt.js`가 생성하므로 이미지 태그만으로 추가 인증을 판정하지 않는다.

CAPTCHA 성공 Location의 `http://nid.naver.com/nidlogin.login`은 정확히 그 호스트·경로만
요청 전에 HTTPS로 올린다. 평문 HTTP로 인증정보를 전송하지 않는다. `chp`, 대상 관리자 URL,
중복 쿼리를 검사하며 응답이 불명확한 POST는 자동 재시도하지 않는다.

## 저장·재사용·보호조치 처리

- `naver-login-identity`: ID·비밀번호 DPAPI 항목. 사용자 변경 후 갱신 완료.
- `naver-blog-session`: 쿠키와 해당 세션의 User-Agent를 DPAPI로 보관.
- `SessionClient`, 통계 `client.mjs`, HTTP 탐색 및 편집기 읽기에 User-Agent 전달을 추가했다.
- 응답 쿠키 회전 시 같은 User-Agent를 보존하며 기존 버전 1 저장 자료도 읽는다.
- `session:health --output`이 실제 결과 파일을 예약·작성하도록 수정했다.
- `/user2/help/idSafetyRelease`는 `ACCOUNT_PROTECTION_REQUIRED`로 분류한다.
  CLI가 이를 기록하면 다음 로그인은 POST 0회로 중단한다.
- 이번 차단 상태는 사용자 복구와 정상 소유자 확인 후 해제했다.

복구한 브라우저 세션의 독립 HTTP 재사용은 검증됐다. User-Agent 보관 수정 후
순수 Node 새 로그인 세션의 프로세스 간 재사용은 아직 재검증하지 않았다.

## 이미지 전용 Codex CLI

사용자 요청에 따라 `scripts/naver-login-vision.mjs`를 기본 답안 공급자로 연결했다.
로그인 단계·HTTP 요청·토큰 발급·쿠키 처리는 기존 Node 스크립트가 수행한다.

1. Node가 관측한 영수증 인증 계약으로 PNG와 질문을 가져온다.
2. Codex CLI를 셸 없이 직접 실행하고, `gpt-6-luna`에 질문과 PNG만 전달한다.
3. `--output-schema`로 `{"answer":"..."}` 또는 `{"answer":null}`만 받는다.
4. 문자열 길이·제어 문자·JSON 필드를 검사한 뒤 같은 인증의 HTTP 폼에 답을 제출한다.
5. 이미지·답안 파일·CLI 로그가 있는 임시 디렉터리는 성공·실패 모두 제거한다.

현재 ChatGPT CLI 로그인을 사용한다. 비밀번호·쿠키·로그인 폼·인증 토큰은 모델에 넘기지 않는다.
`--ignore-user-config`, `--ephemeral`, 프로젝트 문서 0바이트 설정을 적용하며
셸·브라우저·앱·플러그인·메모리·서브에이전트·파일 이미지 도구·code-mode host를 끈다.
예상하지 않은 도구 이벤트는 호출 실패로 처리한다. CLI 0.156.1이 내보내는
code-mode host 비활성화 안내만 허용하며 일반 오류·설정 오류는 중단한다.

기본 제한은 60초다. 모델 오류·판독 불가·잘못된 JSON에는 답을 제출하지 않고 종료한다.
모델 자동 대체나 이미지 답안 자동 재시도는 없다. 기존 로그인 POST 재시도 제한도 유지한다.
합성 이미지 실호출을 확인했으며 실제 네이버 인증과 이어지는 새 로그인 전체는 아직 미검증이다.

CLI는 이 작업에서 0.153.4에서 0.156.1로 갱신했다. 초기 구버전 모델 메타데이터 문제와
현 버전에서 무시되는 `tools.view_image` 설정을 확인해 수정했다.
공식 [비대화형 실행 안내](https://learn.chatgpt.com/docs/non-interactive-mode)와
[설정 안내](https://learn.chatgpt.com/docs/config-file/config-reference)를 참고하되,
실제 설치 버전에서 지원되는 기능과 실호출 결과를 기준으로 삼았다.

## 실행

앱 폴더에서 실행한다. 비밀번호를 명령 인자나 파일에 넣지 않는다.

```powershell
npm run login:auto
npm run session:health -- --output evidence/session-health-current.json
npm run login:http -- --status
# 기존 세션을 확인하지 않고 새 로그인을 명시적으로 실행할 때
npm run login:http -- --remember-session --challenge-codex
# 네이버 복구 절차를 실제 완료한 후에만 로컬 차단 해제
npm run login:http -- --account-recovered --status
```

`login:auto`는 저장된 세션을 먼저 확인한다. 쿠키 없음·만료·로그인 화면 복귀가 확인되면
저장된 ID·비밀번호로 새 로그인을 실행한다. 이미지 인증이 있을 때만 Luna를 호출한다.
네트워크 오류·403·소유자 불일치는 만료로 간주하지 않는다. 유효한 세션에서는 모델 호출도 없다.
새 세션은 보호된 소유자 확인 후 DPAPI에 저장한다. 이 명령은 실행 시점에 한 번 처리하며
백그라운드 감시나 예약 작업을 설치하지 않는다.

선택적인 `--challenge-stdin`은 실제 TTY에서 문제·임시 PNG 경로를 출력하고
`{"operation":"answer","answer":"답안"}` 한 줄을 받는다. Windows PTY에서는 CR로
끝낸다. 이미지는 답안을 받거나 종료하면 제거한다. 이 옵션을 주지 않으면 Codex 공급자가
기본값이다. `--challenge-codex`와 `--challenge-stdin`은 함께 쓰지 않는다.
`--identity-stdin`도 `--challenge-stdin`·`--reuse-session`과 동시에 쓰지 않는다.

일회성 브라우저 인계는 RSA-OAEP/AES-GCM으로 암호화하고 소유자 확인 후 DPAPI에 저장한다.
일반 조회 클라이언트는 만료 후 자동으로 새 로그인 POST를 시작하지 않는다. 상위 자동화는
`login:auto`를 먼저 실행하고 성공한 경우 필요한 API 작업을 진행한다.
보호조치가 비밀번호 변경을 요구하면 사용자가 직접 완료해야 한다.
[네이버 보호조치 안내](https://help.naver.com/service/5640/contents/1117?osType=COMMONOS).

## 검사 저장소 사고와 복구

기존 `authorized-session` 검사에 넣은 가짜 쿠키가 실제 DPAPI 저장소를 덮어쓰는 결함이
있었다. 알려진 가짜 항목만 제거하고 정상 계정 로그인으로 세션을 복구했다.
`NODE_TEST_CONTEXT`에서는 메모리 저장소만 사용하고 실제 DPAPI 호출을 막도록 고쳤다.
격리 수정 직후 관련 검사 28개는 통과했다. 그 뒤 추가한 CAPTCHA 후속 처리·User-Agent
보관·보호조치 분기는 전체 단위 검사를 다시 돌리지 않았다. 실요청 결과와 구분한다.

## 증거

- Node 새 로그인 성공: `evidence/login-node-browserless-live-v2-20260923.json`
- 후속 보호조치 관측: `evidence/login-node-browserless-live-v4-20260923.json`
- 복구 후 독립 HTTP 조회: `evidence/session-recovered-after-password-change-20260923.json`
- 새 비밀번호 DPAPI 반영: `evidence/naver-identity-updated-after-recovery-20260923.json`
- 자동 진입점의 세션 재사용: `evidence/login-auto-session-reuse-20260923.json`
- 마무리 후 세션 재확인: `evidence/login-auto-final-20260923.json` (20:47:28 KST, HTTP 200, 새 로그인 0회)
- Luna 이미지 공급자 실호출: `evidence/codex-luna-login-image-provider-v6-20260923.json`
- 이번 연결 작업 요약: `evidence/login-image-codex-integration-20260923.json`
- 기계 판독 계약: `research/naver-login-observed-2026-09-23.json`

관리자 인증은 `NID_AUT`·`NID_SES` 쿠키를 사용한다. `wtoken`은 로그인 단계의 SDK 토큰이며
관리자용 Bearer로 재사용하지 않는다. 이번 작업에서 글을 발행하지 않았다.
