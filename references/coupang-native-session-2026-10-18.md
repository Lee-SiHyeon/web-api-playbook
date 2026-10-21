# Vercel 전체 브라우저·방문자 초기화 재검증 — 2026-10-18

현재 일반몰 검색/골드박스 전체 수집은 **미해결**이다. 아래 구현 보강과
오프라인 테스트를 원천 HTTP 403 해소나 운영 DB 저장 성공으로 해석하지 않는다.
실제 비밀번호·쿠키/토큰 값·프로필·opaque query 값은 이 문서에 포함하지 않는다.

## 서로 다른 상태를 합치지 않는다

- `live_process`: 같은 Chrome 프로세스에 다시 연결했다. 그래도 그 사이
  `about:blank`로 이동했다면 원래 document의 JavaScript 실행은 끝난 것이다.
- `disk_profile_resume`: VM 재개 후 디스크 프로필로 새 Chrome을 시작했다.
  이것만으로 기존 탭이나 sessionStorage 복원을 입증하지 못한다.
- 정상 종료 후 `--restore-last-session`: Vercel Chrome 155의 자체 loopback
  fixture에서 탭·localStorage·sessionStorage·history.state 보존을 확인했다.
  반대로 같은 프로필에 `about:blank`를 열면 localStorage만 남았다.
- 강제 종료 후에는 같은 플래그만으로 자동 복원되지 않았다. Chromium은
  crash loop 방지를 위해 post-crash 자동 복원을 하지 않는 경로가 있다.
  정상 종료 실험을 VM 강제 종료 복원 성공으로 확대하지 않는다.
  [Chromium startup 구현](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/startup/startup_browser_creator_impl.cc)

수집기는 기존 프로필에서 Chrome의 세션 복원을 요청하고 지연된 탭 target을
제한적으로 기다린다. 실제로 복원된 홈은 재이동하지 않는다. 이때 새 홈 응답을
관측하지 않았으면 `homeStatus=null`이다. 요청한 복원과 실제 복원을 구별한다.
보류 중인 수집은 Chrome 획득 **이전**에 멈춘다. 탭 복원 자체가 네트워크를
발생시킬 수 있으므로 UI 클릭 직전에만 보류를 검사해서는 부족하다.

## 익명 방문자 초기화

관측한 공개 `sec-g/1.2.9` 스크립트에서 `/m/r` POST는 `fetchToken` 호출이다.
성공 시에만 현재 세션 active marker와 collection timestamp를 갱신한다.
기존 FP_DATA에서 토큰을 읽거나 `x-cp-s` 서명이 갱신되는 것은 별도 경로다.
따라서 **오래된 device token + 새 signature cookie**만으로 현재 초기화 성공을
판정하지 않는다. 검사기는 값을 출력/변경하지 않고 존재·형식·나이만 확인한다.

이 초기화는 비동기다. `/m/r` 실패가 모든 endpoint의 실패를 논리적으로
보장하지는 않는다. 실제로 같은 브라우저의 자동완성 XHR은 200이었고,
골드박스 첫 문서도 200이었다. 토큰 등록, 검색 Document, 정렬 RSC,
골드박스 continuation의 상태를 별도로 기록한다. 초기화 guard에 의해
검색을 시도하지 않았다면 이를 실제 검색 HTTP 403으로 표시하지 않는다.

## 실제 UI와 네트워크 관측 (UTC)

| 시각 | 네이티브 동작 | 결과 |
|---|---|---|
| 06:55 | Google의 실제 쿠팡 organic 결과 클릭 | 홈 200, `/m/r` 403 |
| 06:58 | 홈 검색창에 한 글자씩 입력 | 자동완성 XHR 200, 추천어 표시 |
| 07:02 | 보이는 `무선 마우스` 추천어를 실제 포인터로 선택 | `channel=auto` 검색 Document 403, 거부 DOM |
| 07:13 | Chrome의 한국어 기본 언어 설정 후 홈 이동 | 실제 Accept-Language와 navigator 모두 한국어, 홈 200, `/m/r` 403 |
| 07:15 | 유지된 홈에서 실제 골드박스 메뉴 클릭·스크롤 | 첫 문서 200/100행, 사이트가 보낸 다음 페이지 XHR 403, EOF 미확인 |

언어 변경은 Chrome의 사용자 설정에서 이루어졌으며 헤더나 navigator를
가로채지 않았다. 이 변경으로 403이 해결되지 않았다. 과거 같은 프로세스의
성공/실패도 모두 영어 설정이었으므로 언어 차이를 확정 원인으로 삼지 않는다.
Chrome은 selected-languages 설정 변화로 accept-languages를 갱신한다.
[Chromium LanguagePrefs 구현](https://raw.githubusercontent.com/chromium/chromium/main/components/language/core/browser/language_prefs.cc)

해당 진단들은 같은 Vercel Chrome 프로필과 브라우저 자체 쿠키 전송을 사용했다.
쿠키를 14종으로 잘라 보내거나 HTTP client로 다시 구성한 실행이 아니다.
실제 전송 쿠키의 blocked reason은 비어 있었다. 계정/방문자를 교체하지 않았고,
진단에서 운영 보류를 지우거나 상품 데이터를 DB에 저장하지 않았다.

## 검색 동작을 정확히 비교한다

공개 header chunk의 검색 바인딩은 jQuery다. React handler가 안 보인다는 이유로
초기화 누락을 단정하면 안 된다.

- 홈 Enter/버튼: form의 native `submit()` → Document 이동.
- 자동완성: `.autocomplete_wrap a[data-searchkeyword]`, `href="javascript:;"`.
  실제 `mousedown`/keydown handler가 `window.location.href`로 이동한다.
  `/np/search` href나 ARIA option만 찾으면 이 항목을 놓친다.
- 단순 DOM `element.click()`은 포인터 mousedown을 재현하지 못한다.
- 보존된 로컬 RSC 200/60개 증거는 **검색 결과의 낮은가격순 정렬 단계**다.
  첫 검색 Document 상태는 해당 observer가 저장하지 않았다.
  로컬의 최종 RSC와 Vercel의 첫 Document를 동일 요청 비교로 표시하지 않는다.

## 녹화와 실행 코드의 동일성

녹화 준비가 현재 탭을 `about:blank`로 바꾸면 관측 대상 자체가 달라진다.
동일 process ID/target ID만으로 document 연속성을 주장하지 않는다.
녹화는 현재 창만 표시하고, 별도의 새 진입 실험은 명시적인 독립 시나리오로 둔다.

worker SHA는 **실제로 업로드하고 실행 명령에 지정한 바이트**에서 계산한다.
별도 inspection bundle의 SHA를 production collector의 SHA로 쓰지 않는다.
dispatch 식별자는 실행 성공·원천 성공·DB commit을 각각 대신하지 않는다.

회귀 검증, Vercel native read, 정확한 SKU/가격 매핑, 전체 pagination EOF,
원자적 DB 저장 및 독립 readback을 모두 구분해서 기록한다. 다음 페이지 403이면
첫 100행 파싱 성공만으로 완전한 카탈로그나 판매 종료 상태를 주장하지 않는다.
