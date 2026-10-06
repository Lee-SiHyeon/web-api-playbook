# Gemini·Grok 인증 이후 디버깅

이 문서는 Linux 워커에서 로그인 이후 원본 XHR 클라이언트를 확인하는 절차다.
기능 완료 선언은 아니다. 각 원본의 기능 검사 결과와 실제 실행 영수증을 함께 읽는다.
이전 로그인 거부 기록은 [로그인 진단 이력](provider-login-diagnostics.md)에 보존한다.

## 로그인과 실행 호스트

일반 Linux Chrome154의 작업 전용 프로필에서 Google 비밀번호 단계를 통과했고,
기존 xAI 계정은 이메일 코드 방식으로 로그인했다. 비밀번호 값, 코드, 이메일,
쿠키 DB, 프로필 내용은 저장소에 넣지 않는다. Google 비밀번호를 xAI 비밀번호로
간주하지 않는다. 기존 계정의 로그인 방식이 다르면 해당 사이트의 정상 UI를 확인한다.

브라우저의 로그인 화면, 앱 화면, 독립 HTTP owner 조회는 서로 다른 단계다.
Grok의 현재 protected probe는 `GET /api/auth/session`이다. 실행 중인 현재 계정의
`sso`만 메모리로 전달한 Python helper, Node HTTP adapter, Node client owner probe가
각각200 JSON을 반환했고 의도한 owner와 일치했다. 이는 해당 조회에 대한 증거다.
Clearance cookie를 복사하거나 공개 모델200으로 계정 인증을 대신하지 않는다.

Gemini HTML에 expected email이 있다는 조건만으로 활성 계정을 판정하지 않는다.
현재 정상 first-party bootstrap에서 관측한 `WIZ_global_data.oPEP7c`와 expected owner를
정확히 비교하고 app orchestrator·anonymous control을 함께 확인한다. account chooser에
다른 계정 이메일이 함께 있어도 그 문자열을 active principal로 사용하지 않는다.
활성 계정 불일치는 기존 cached owner를 지우며, 검사와 digest 뒤 identity body를 지운다.

Grok private artifact의 경우 cookie 없는 독립 GET은403이었지만, cache와 service
worker를 끈 정상 Chrome GET은200이었다. 처음 `request.headers`만 보고 cookie가
없다고 판단하지 않는다. CDP `Network.requestWillBeSentExtraInfo`에서 실제 Cookie
header와 이름을 확인한 뒤, source의 `ASSET_SERVER_URL`과 `getCachedAssetUrl`
(`cache=1`)을 대조한다. 같은 task URL에 domain/path가 맞는 정상 `sso`만 전달한
독립 CFFI GET에서4개 JPEG와 MP4의200·magic·해시를 검증했다. challenge/bot
cookie는 전달하지 않았다. 인증 전달 경계를 확인하기 전에 UA/TLS를 원인으로
단정하지 않는다. 인증 cookie가 있다는 이유로 모든 cookie 사용을 거절하지 않는다.

처음 Google 이메일 단계가 거부된 자동화 실행과 뒤에 성공한 일반 Chrome 실행은
실행 조건이 다르다. 그 차이만으로 서버 거부의 단일 원인을 확정하지 않는다.
로그인 시에는 일반 보안 설정을 유지했고, 인증 뒤에 같은 작업 프로필을 열어
XHR 탐색을 진행했다. 현재 작업 브라우저의 PID와 CDP listener 소유자를 확인한다.
Linux 실행에 Windows DPAPI나 다른 PC 연결이 필수라고 추정하지 않는다.

현재 원본 클라이언트로 별도 private 테스트 대화를 검증했다. Gemini는 취소한 정상 SDK
요청을 HTTPS로1회 전송했고, 독립 `hNvQHb` 조회에서 같은 요청과 `PROTOCOL42`·`42`
답변, API ID와 화면 route 관계를 확인했다. Grok은 직접 WSS 연결에서 session 생성
응답을 받은 뒤 business frame을1회 전송했고, 별도 conversation/detail/node/response
HTTP 조회에서 같은 요청과 답변을 확인했다. WSS101만으로 성공을 판정하지 않았다.
SDK 입력 준비에 브라우저가 남아 있으므로 전체 흐름을 engine-free로 표시하지 않는다.
이전의 outcome-unknown smoke intent는 이 새 테스트의 성공으로 바꾸지 않는다.

공유 CDP 브라우저에는 개별 수집기가 `browser.close()`나 `context.close()`를 호출하지
않는다. 수집기 연결만 종료한다. 브라우저 PID가 없어지고 listener와 감독 프로세스
handle도 종료됐다는 실제 증거가 있을 때만 소유한 runtime을 복구한다. 관측 timeout만으로
재시작하지 않는다. 같은 작업 프로필의 인증과 불확실한 mutation journal을 유지하고,
복구 뒤에 owner probe와 역할 marker를 다시 확인한다. 이미 보낸 작업은 다시 보내지 않는다.

## 보호 조회가 실패할 때

다음 경계를 순서대로 좁힌다.

1. 현재 origin의 owner probe를 브라우저와 독립 HTTP에서 비교한다.
2. session provider 준비 상태와 실제 outbound cookie/header 이름을 따로 확인한다.
3. 같은 메모리 credential로 Python helper, Node adapter, 최종 client를 비교한다.
4. method, query 이름, body 존재 여부, header 이름, redirect 정책, MIME과 JSON 구조를
   비교한다. 원문 인증 응답이나 credential 값은 로그에 출력하지 않는다.
5. 실패한 boundary만 수정하고 실제 caller를 다시 실행한다. 과거404가 현재 재현되지
   않으면 현재 성공과 과거 원인 미확정을 함께 기록한다.

Grok에서는 credential consumer가 `cookieNames/headerNames`를 기대하는데 producer가
`cookies/headers`를 넘기는 결함을 수정했다. session 준비 상태가 true여도 실제
요청에 cookie가 없을 수 있다. GET은 body 없는 GET으로 전달하고, 현재 실제 요청으로
회귀를 확인한다. 과거 오류 원인을 HTTP wrapper 이름이나 OS 탓으로 단정하지 않는다.

## Gemini 프레이밍과 RPC

`MaZiqc` history list는 `POST /_/BardChatUi/data/batchexecute`의 관측된 read다.
`at/f.req` form, session/build query, 중첩 JSON argument를 현재 source와 대조한다.
generation의 `StreamGenerate` envelope는 history batch envelope와 다르므로
source correlation ID를 실제 response RPC selector로 사용하지 않는다.

`refreshGeminiHttpSession`은 인증된 `/app`의 현재 WIZ 값으로 batch context를 다시
읽는 기능이다. 이 성공을 로그인 cookie의 갱신이나 만료된 인증의 복구로 표시하지
않는다. Grok의 현재 first-party auth client도 `/api/auth/session` GET을 refetch해
화면의 session 상태를 다시 읽는다. 실제 인증 cookie 교체가 관측되지 않았다면
별도의 인증 갱신 contract는 미확인으로 남긴다.

Grok cookie 교체에서는 `Domain=.grok.com`과 `grok.com`을 같은 저장 키로 취급한다.
유효한 `Max-Age`가 있으면 `Expires`보다 우선하며, 양수는 실제 만료 시각으로,
0 이하 값은 삭제로 처리한다. cookie 값이 같아도 보안 속성이 바뀌면 반영한다.
만료된 필수 cookie는 전송 전에 `SESSION_EXPIRED`로 거절한다. 이 로컬 회귀 검사와
실제 provider cookie 갱신 성공은 별개의 증거다.

Grok의 `renewSession({expectedIdentity, acquireSession})`은 새 정상 handoff를 별도
HTTP owner 조회로 확인한 뒤, 같은 계정일 때만 활성 credential을 한 번에 교체한다.
실패한 새 handoff나 조회 중 교체된 generation은 기존 session을 덮어쓰지 않는다.
메인 CLI `session-refresh --session-stdin --python ...`의 실제200을 검증했지만,
이번 handoff에서 인증 cookie 값은 같았다. server cookie rotation과 server에서
만료된 session의 복구 성공으로 바꾸지 않는다. 기존 mutation intent는 다시 보내지 않는다.

Gemini도 required cookie의 관측된 epoch-second `expires`를 보존하고 전송 전에 확인한다.
브라우저 session cookie sentinel인 `-1`과 expiry 미관측을 실제 만료로 처리하지 않는다.
`renewSession({expectedOwner, acquireSession})`과 CLI `session-renew --envelope-stdin`은
정상 acquisition으로 얻은 새 bundle을 독립 owner/anonymous 조회한 뒤 같은 계정일 때만
메모리 session을 교체한다. 획득 실패·wrong owner·동시 교체는 이전 활성 상태를 보존한다.
실제 CLI로 local expiry metadata에서 owner200 handoff를 확인했지만 credential 값과
native profile은 그대로였다. 이 테스트를 서버 만료나 provider cookie rotation으로
확대하지 않는다. private resource나 불확실한 mutation을 자동 재전송하지 않는다.

실제 다국어 batch response의 길이는 UTF-8 바이트 수가 아닌 UTF-16 code unit 수에
2를 더한 값이었다. JSON의 실제 끝을 먼저 찾고 이 길이 관계를 검증한다. 이후 실제
줄바꿈을 건너뛰되 다음 frame의 숫자 header를 소비하지 않는다. 한글, non-BMP 문자,
socket에서 나뉜 UTF-8 입력을 확인한다. HTTP200 뒤의 unclassified frame은 성공한
대화나 미디어 결과가 아니다.

StreamGenerate는 같은 operation의 null-selector frame을 여러 번 보낸다. frame 수가
여럿이라고 ambiguous RPC로 거절하지 않고 순서를 유지해 main candidate와 metadata를
결합한다. history list에서도 마지막 관측 요청이 첫 페이지라는 보장은 없다. 관측된
cursor1 응답은0행, page0 args `[28,null,[0,null,1]]`의 독립 HTTP 응답은28행이었다.
빈 다음 페이지를 계정 만료나 전체 기록 부재로 해석하지 않는다.

generation response는 같은 process에서 파싱·상태 판정·task/resource ID 연결을
마칠 때까지 유지한다. 비밀 저장을 피하려고 파싱 전에 버퍼를 지우면 readback에 필요한
근거도 잃는다. 검사 후 원문 버퍼를 지우고, 저장하는 것은 상태·MIME·길이·해시·
형식 정보·검증 여부다. 생성 제목이 요청 문구와 다르다는 이유만으로 task의 결과가
없다고 판단하지 않는다. 실제 timestamp, 관측된 ID와 detail을 메모리에서 대조한다.

batch RPC argument 자체가 JSON 문자열이면 한 단계 더 decode한 뒤 ID를 비교한다.
문자열 안의 ID를 원문 문자열 전체와 비교하면 항상 다른 값으로 처리할 수 있다.
현재 history row의 `c_` +16자리 hex와 화면 `/app/`의16자리 ID는 서로 다른 표현이다.
현재 값의 유일한 prefix 관계를 확인하되 RPC에는 raw row ID를 유지하고 화면 route ID는
따로 보관한다. 링크 순서나 생성 제목 일치에 결과 조회를 의존하지 않는다.

response 수신 시각 이후30분의 가장 최신 row를 고르면 뒤에 보낸 다른 테스트 대화를
잘못 선택할 수 있다. 실제 dispatch 시작·response 수신 구간을 기준으로 후보를 좁히고,
최종 연결은 정확한 task 메시지와 response/resource ID로 검증한다. 시각은 후보 선정
근거이며 결과의 소유·내용 일치를 대신하지 않는다.

## 단일 전송과 브라우저 취소

현재 origin과 `window.name` 역할 marker를 함께 사용한다. page index로 작업 탭을
선택하거나 탐색 때마다 탭을 추가하지 않는다. 요청·응답 observer와 write guard를
동작 전에 설치하고, 관측한 read와 telemetry 외의 business write를 막는다.

cross-origin 이동은 `window.name`을 지울 수 있다. 새 task page는 navigation 전에
실제 CDP `Target.getTargetInfo`의 target ID를 역할 registry에 잠금과 함께 기록한다.
marker가 사라져도 그 ID로 같은 target을 확인한다. ID 없이 여러 blank tab 중 하나를
골라 relabel하지 않는다. marker 손실은 Chrome 종료 증거가 아니다.

취소 증거는 caller가 제공한 `browserAborted:true`가 아니다. 실제 CDP
`Fetch.failRequest(errorReason=BlockedByClient)` 응답, 같은 Network request ID의
`loadingFailed`1회, `responseReceived`0회, 정확한 intent 일치를 연결한다.
`errorText` 표시값은 진단 정보로 남기며 문자열 하나만으로 취소 여부를 판단하지 않는다.
취소 이후의 UI 재시도도 guard로 막아야 한다. handoff 직후 route를 해제하지 않고,
결과 확인·task page reset·조용한 상태 확인까지 유지하거나 해당 task page를 종료한다.

정확한 primary 요청과 취소 증거가 확보됐고 owner·target·intent가 확인되면, 함께 발생한
미분류 ancillary POST가 실제로 취소됐다는 이유로 primary의 controlled HTTP replay를
차단하지 않는다. ancillary 요청은 계속 취소하고 메타데이터를 분리해 조사한다.
취소 실패나 미허가 delivery가 있으면 그 경계부터 먼저 해결한다.

위 text run의 `loadingFailed`1회는 그 실행에서 실제 관측한 값이다. 모든 수집기에
그 event 횟수를 임의로 강제하지 않는다. [CDP Fetch protocol 원본](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json)은
Request stage가 전송 전 interception임을 정의한다. 다른 run에서 이 stage의 exact
request/network ID, 실제 failRequest ACK, intent/body 일치와 response0이 확인되면
loadingFailed는 관측된 횟수 그대로 보조 근거로 남긴다. Response stage에서의 취소와
구분하고, caller가 써 넣은 browser-aborted boolean으로 이를 대신하지 않는다.

intent identity는 인증된 actor, operation, caller의 안정적인 intent로 정한다.
cookie, CSRF, SDK token, `_reqid` 또는 새 job ID가 바뀌어도 같은 불확실한 요청을
다시 보내지 않는다. timeout, connection loss와 unclassified200은 읽기로 조정할
대상이다. 미확정 outcome을 임의의 새 intent로 재전송하지 않는다.

단일 전송 제한은 해당 mutation intent에 적용한다. 잘못된 schema를 고친 뒤의
필수 read-only 조회나 정상 현재-origin credential 획득을 평생 한 번으로 제한하지
않는다. 새 schema를 확인하는 안전한 읽기는 원래 디버깅 범위 안에서 계속한다.
서비스가 작업을 처리 중일 때 첫 빈 결과 목록만으로 종료를 선언하지 않고, 같은
실제 작업과 연결의 상태를 확인한다. server event의 type·field 이름·수·reader
오류를 감사 summary에 남겨, 원문을 저장하지 않아도 실패 경계를 조사할 수 있게 한다.

Grok text의 현재 WSS `/ws/mgw/`는 Imagine `/ws/imagine/listen`과 별개다.
101 handshake, control session 생성, business frame 전송, 서버 결과와 독립 history
readback을 각각 기록한다. 필요한 per-action SDK 입력은 정상 first-party producer에서
얻는다. 값은 같은 collector process의 메모리에서 전달하고 임의로 만들지 않는다.
생성 요청 전에 capture를 버리거나 정상 bounded wait를 idle로 오해해 종료하지 않는다.

새 `/c` 화면과 기존 `/c/{id}` 화면의 control schema가 같다고 가정하지 않는다.
새 session의 control에는 아직 `session_id`가 없을 수 있으며 `x_grok`의 생략·빈 객체·
관측된 옵션 목록도 구분한다. 현재 정상 SDK가 실제 만든 schema를 받아들이고 없는 값을
채워 넣지 않는다. resource target과 정상 옵션·connector 광고 필드를 구분하되,
별도 도구 호출을 실행한 것으로 표시하지 않는다. business frame은 새 연결의 server
acknowledgement에서 받은 session ID에 묶는다.

새 WSS ACK의 session ID가 이전 source capture ID와 같다는 이유만으로 거절하지 않는다.
실제 새 연결의 control ACK인지 확인하고 그 값에 business event를 묶는다. control만
교환하고 business dispatch0이 증명된 실패는 원래 실패 기록을 보존한 append-only 복구가
가능하다. business 전송이 불확실한 경우에는 이 규칙으로 재전송하지 않는다.
Grok의 실제 Castle token은 약6KB인 경우가 있었다. 자의적인4KB cap을 protocol 요구로
간주하지 않고 관측된 입력을 수용하는 bounded parser를 사용한다. token은 정상 SDK에서
얻고 원문 저장·추측·다른 작업 token 재사용을 하지 않는다.

## 업로드와 진단 데이터 수명

Gemini web 업로드 시작 요청은 `push.clients6.google.com/upload/`로 들어갔으며, form
content-type을 가졌지만 body는 파일 이름을 적은 plain metadata였다. content-type만
믿고 `parse_qs` 결과의 key를 전부 출력하면 원문 body 전체가 key로 노출될 수 있다.
실제 진단에서 이 결함을 발견했다. first-party form임이 확인된 경우만 정적 허용 field
이름을 출력하고, 다른 body는 type·byte count·hash만 남긴다. telemetry에도 적용한다.

시작 HTTP200은 파일 전송 성공이 아니다. 최초 finalize400 뒤 query는 active,
received0이었다. [공식 Gemini Files API 예제](https://ai.google.dev/api/files)는
offset0과 `upload, finalize`를 사용하지만 이 별도 API 문서를 internal web upload의
실증으로 바꾸지 않는다. 실제 web SDK continuation에서 같은 command·offset·file
digest를 관측한 뒤 직접 transfer와 query/readback을 따로 확인한다.

필요한 경우 실제 독립 init 응답을 paused browser에 전달해 SDK continuation을 만들고,
그 continuation은 전송 전에 guard로 막아 실제 API writer에서 한 번 보낸다. 만들어낸
fixture 응답을 정상 서버 응답처럼 사용하지 않는다. start/transfer는 별도 단계와 journal
기록을 가지며, 이 정상 다단계 protocol을 같은 mutation의 재시도로 세지 않는다.
불확실한 바이트 전송은 재전송하지 않고 실제 상태 조회로 조정한다.

signed resumable URL, response bytes와 파일 metadata는 transfer·query·상태 판정까지
메모리에 유지한다. 원문 scrub와 감사 metadata는 같은 list/object를 공유하지 않는다.
필드 이름·상태·해시를 복사한 후 mutable byte buffer를 지운다. runner 종료 오류로 audit
필드가 빠지면, 확인된 client/journal 성공과 미확인 HTTP/guard/reset 필드를 따로 기록한다.
뒤에 성공한 새 진단을 앞선 실패나 불확실한 작업의 성공으로 덮어쓰지 않는다.

sync Playwright guard를 유지하는 process가 blocking `stdin.readline()`에 들어가면
Fetch event를 처리하지 못해 정상 owner GET도 paused 상태에 걸릴 수 있다. Chrome이나
계정 실패로 단정하지 않고 해당 guard process/target의 pending request를 확인한다.
async event loop 또는 nonblocking command 처리로 guard를 계속 pump하고, 같은 target을
guard 안에서 reset·quiet 확인한 뒤 수집기 연결만 종료한다.

HTTP business 완료 뒤 audit 저장 callback이 실패하면 generic API failure와 구분한다.
원래 operation journal과 실제 artifact·후속 조회를 먼저 확인하고 이미 완료된 요청을
다시 보내지 않는다. audit는 atomic하게 저장하며 새 작업 기록은 기존 파일을 덮어쓰지
않는다. 잃은 response byte count나
handshake 필드를 추정해 채우지 않는다. 현재 코드의 새 source snapshot이 과거 실행의
코드 hash를 대신할 수도 없다.

진단 projection도 실제 상태를 보존해야 한다. MIME type, 단계 이름, attempt number,
request-start flag와 HTTP byte count 같은 정적 protocol metadata를 지워 버리면 전송 전
거절과 응답 후 오류를 구별할 수 없다. 값의 종류와 길이를 검증한 허용 필드로 남기고,
서명 URL·cookie·원문 body·resource ID 값은 별도의 in-memory business 경로에 둔다.
Gemini continuation 실패에서는 선택 파일 MIME과 실제 전송 MIME이 모두 지워져 원인
확인이 늦어졌다. 이후 projection은 두 MIME을 parameter 없는 정규화된 type으로만
보존한다. 이는 과거에 잃은 값을 복원한 기록이 아니다.

Node와 Python helper의 option 범위도 함께 검사한다. 실제 Grok video helper는 최대
60,000 ms를 받는데 Node 기본값이 90,000 ms여서 HTTP 전에 `TIMEOUT_INVALID`로
거절됐다. 기본값과 지원 범위를 맞추고 Node가 만든 packet을 실제 Python validator에
통과시키는 network-free 회귀 검증을 추가했다. 오래된 진단 없는 unknown 요청의 원인을
이 새 진단으로 확정하지 않는다.

## 실행 가능한 기능과 완료 증거

함수 파일이 있어도 main client와 CLI에서 호출할 수 없다면 기능 연결이 남아 있다.
기능마다 실제 export, CLI command, session 입력, response decoder, 독립 readback을
확인한다. business 결과를 반환하는 API와 상태·해시만 출력하는 감사 명령을 구분한다.
identity 응답과 credential 값은 business output에 포함하지 않는다.

내부 parser는 resource ID, 본문과 허용된 artifact URL을 메모리에서 client에 전달해야
조회·다운로드를 수행할 수 있다. 별도의 감사 summary만 값 없는 형식으로 만든다.
내부 반환값을 무조건 지워서 실제 API가 artifact를 가져오지 못하게 만들지 않는다.
미디어는 새 asset 개수·private 표시·파일 magic만으로 task 완료를 판정하지 않는다.
해당 요청이 반환한 ID와 독립 조회의 prompt/resource 연결을 함께 검증한다.

최초 controlled replay는 owner 확인·실제 request capture·취소·intent 허가를 검증한
discovery 경로로 실행한다. 첫 replay를 하기 위해 response capture를 꾸며 넣지 않는다.
production ready 상태는 실제 response와 결과 readback이 연결된 뒤에 기록한다.

원본 checkout의 `scripts/check-features.mjs`는 저장된 영수증과 현재 코드·계약의 일치를
검사한다. 현재 원격 로그인이나 새 네트워크 실행을 수행하는 명령은 아니다.
`--strict`가 실패한 항목을 공개200, fixture 테스트, request-only contract로 녹색 처리하지
않는다. 미디어는 artifact MIME과 magic까지 확인하고, 사용자 기존 자료에는 테스트
수정·삭제를 하지 않는다. 새 task 자료만 검증 대상으로 사용한다.

Gemini의 `scripts/verify-history.mjs`는 별도의 실제 direct HTTP verifier다. stdin의
현재 session과 기존 task query/intent로 owner, 목록, 검색, exact task detail을 확인한다.
canonical 기록은 그 실행의 계약·구현 hash에 묶으며 raw credential, ID, query나 message는
저장하지 않는다. runtime import 전에 source snapshot을 잡고 실행 후 다시 비교한다.
동시 구현 변경이 검출되면 성공한 읽기 자체는 인정하되 canonical 완료 기록을 만들지
않는다. 짧게 source 편집을 동결한 뒤 read-only 재검증하며 mutation을 반복하지 않는다.

checker 회귀 테스트는 현재 checkout의 live 영수증 생성 여부에 따라 기대값을 바꾸지
않는다. historical-only fixture에는 canonical 영수증을 복사하지 않고, 별도 positive
fixture에서 현재 source binding을 확인한다. 실제 기능 검증과 parser/schema fixture
성공을 구분한다.

응답 stream observer도 검증 대상을 바꿀 수 있다. Node IncomingMessage에 consumer보다
먼저 `data` listener를 붙이면 flowing mode가 되어, 나중의 async iterator는 이미 소비된
chunk를 받지 못할 수 있다. 제미니 rename 검증은 HTTP200 뒤 observer267B와 CLI27B가
달라 중단됐다. 별도25B fixture에서도 observer25B/후속 consumer0B를 재현했다.
이 재현은 가능한 메커니즘의 증거이며 실제 rename 원인 확정과 구분한다. observer는
consumer가 받은 chunk를 투명하게 관측하는 경로로 만들고 request/RPC/body digest까지
연결한다. observer 불일치를 provider 실패로 단정하거나 이미 보낸 write를 다시 보내지
않는다. 실제 target state를 독립 조회한 뒤 필요한 task-only 복원을 수행한다.

[observe-response.mjs](../scripts/observe-response.mjs)는 소비자가 읽은 chunk에서만
byte count와 SHA-256을 계산한다. transport가 반환한 `body`를 감싸고 원래 chunk를
그대로 다음 decoder에 전달한다.

```js
import { observeResponse } from './scripts/observe-response.mjs';

const observed = observeResponse(await transport.send(request));
const decoded = await decodeResponse(observed.body);
const audit = observed.audit;
```

`audit.fullyRead`가 false인 digest는 전체 응답의 hash가 아니다. 저장 callback 실패는
`auditCallbackFailed`로 별도 표시하며 decoder가 받을 bytes를 잃거나 business 요청의
실패로 바꾸지 않는다. delayed consumer와 부분 소비는
[회귀 테스트](../tests/observe-response.test.mjs)에서 확인한다.

전송 helper의 실패 기록은 journal 상태 변경 전에 저장한다. `requestStarted: false`와
`businessRequestDispatched: false`가 실제 원본 진단에 함께 남은 경우에만 같은 요청의
전송 전 실패로 복구할 수 있다. journal 전환 오류로 그 진단까지 잃었다면 이후 코드
수정이나 빈 asset 검색으로 과거 요청을 전송 전 실패라고 재분류하지 않는다.

현재 UI가 선택한 작은 파일 direct upload는 init/PATCH/presigned 업로드의 성공 증거가
아니다. 현재 관측된 경로를 client와 checklist에 연결하되 큰 파일의 지원 여부와 별도
단계는 계속 점검한다. 실제 direct 업로드가 있는데 오래된 후보 경로만 필수 작업으로
등록된 경우, 그 후보와 현재 기능을 구분하고 원래 업로드 기능 범위는 유지한다.

브라우저 bootstrap, SDK 입력 준비, business HTTP/WSS 요청과 readback의 실행 방식을
별도로 명시한다. HTTP writer에서 browser import가 없어도 전체 operation이 engine-free인
것은 아니다. SDK producer가 남아 있으면 의존성을 남기고, 검증된 부분만 완료로 표시한다.

감사용 객체와 실제 API 내부 참조를 같은 객체처럼 사용하지 않는다. Grok video의 asset
key는 private symbol에 보존됐지만 byte verifier가 값 없는 공개 객체를 읽어서 URL 생성에
실패했다. downloader는 내부 접근자를 사용하고 JSON output에는 그 key가 나오지 않는지
따로 확인한다. 상태 조회·중단에 필요한 발급 resource ID는 credential과 구분해 사용자
전용 business-reference store에 유지할 수 있다. owner scope·원본 init checkpoint·ID별
해시를 검증하며 signed URL, cookie/token과 본문은 이 저장소나 감사에 넣지 않는다.

Gemini 원본 이미지의 `c8o8Fe` 결과 URL을 그대로 가져오면 thumbnail일 수 있다. 실제
SDK의 `vPd(downloadUrl,true)`는 URL size를 0으로 설정하고, `dO()`는 `alr=yes`와 함께
text/plain 응답에 담긴 다음 HTTPS URL을 추적한다. 관측된 origin과 domain/path cookie
scope를 적용해 마지막 PNG를 읽고 독립 UI 원본과 byte/hash를 비교했다. 원본 경로는
일반 hNv thumbnail 다운로드와 별도의 기능 계약이다.

## 대용량 업로드의 단계별 판정

Grok의 현재 UI 파일 업로드는 실제 feature store의 direct threshold와 파일 크기 상한을
읽어 경로를 고른다. 오래된 별도 flag 객체나 작은 direct 업로드 성공으로 현재 presigned
경로를 추정하지 않는다. native init 응답을 받은 뒤에는 발급된 업로드 참조를 보존하고,
같은 init을 자동 반복하지 않는다. init의 resource issuance, storage PUT, complete 응답,
독립 metadata 조회와 최종 파일 검증은 각각 다른 증거다.

실제 검증에서는 16,777,217바이트 파일에 대해 init HTTP200, signed PUT HTTP200,
complete HTTP200을 받았다. 이 세 응답만으로 전체 업로드를 완료 처리하지 않는다.
독립 metadata의 파일명·MIME·ID 일치, 상태와 다운로드 길이·SHA-256을 추가로 확인한다.
metadata에 예상한 `sizeBytes`가 없다면 `Number(undefined)`의 비교 실패를 서버 파일
크기 불일치로 해석하지 않는다. 응답의 허용 field 이름·type과 현재 first-party decoder를
대조하고, 크기는 실제 독립 다운로드로도 확인한다.

후속 조회에서는 exact asset search의 `sizeBytes`가 16,777,217이었고 file-metadata에는
크기 field가 없었다. 파일명·MIME·ID를 연결한 뒤 scoped asset GET은 HTTP200,
`application/octet-stream`, 길이16,777,217과 원본 SHA-256 일치까지 확인했다. 첫 wrapper가
다운로드 결과 field를 빠뜨린 기록은 보존하고, 실제 응답 정보가 있는 후속 readback은
원본 영수증 hash에 연결한 별도 supplement로 남긴다.

init이 반환한 `requiredHeaders`의 생략은 소스에서 허용된 경우 빈 객체로 정규화한다.
signed PUT의 `Content-Length`가 지정돼 있다면 실제 파일 바이트 수와 먼저 비교한 뒤
transport가 동일한 값을 생성하도록 맡긴다. 불일치는 전송 전에 거절하며 서명에 필요한
다른 header는 그대로 보존한다. storage credentials는 application cookie와 분리하고
관측된 origin, method와 redirect 정책을 검증한다. PUT의 빈 HTTP200 응답도 실제 길이
0으로 기록하며 JSON body를 꾸며 넣지 않는다.

init 응답의 ID가 검증됐다는 사실은 init 단계의 정상 사용 근거가 될 수 있다. 이때
`resourceIssuedResponseVerified`와 `fullUploadReadbackVerified`를 분리한다. 파일 전체
readback이 아직 없다는 이유로 이미 발급된 resource를 잃거나 lifetime one-shot init
제약에 갇히지 않게 한다. 반대로 init 증거를 complete나 파일 검증의 근거로 확대하지
않는다. 실제 abort 응답 뒤 별도 프로세스의 status HTTP200/ABORTED가 확인됐다면
그 참조의 종료만 확정하고 업로드 성공으로 세지 않는다.

## 첫 첨부 요청을 보존하는 진단

첨부파일의 upload ref, raw native request와 client는 binding 검사가 끝날 때까지 같은
수명으로 유지한다. 첫 요청의 layout 불일치 뒤 composer를 다시 전송하면 UI가 첨부를
이미 지운 상태의 요청을 얻을 수 있다. 새 요청에는 파일 정보가 없으므로 앞선 요청의
계약 검증에 사용할 수 없다. 진단을 보존하고 첫 요청을 source와 대조한 뒤 처리한다.

Gemini에서 관측한 첫 요청은 정확한 파일명 parent 아래 길이4의 tuple이 있었지만
element type은 `[string, number, null, string]`이었다. 이전 parser가 기대한
`[string, null, number, string]`과 다르다는 것은 확인됐지만, 이 차이만으로 숫자가
파일 크기이거나 field가 이동했다고 단정하지 않는다. source getter, serializer와 실제
부모 경로를 함께 추적하고 exact dh·파일명·MIME·크기 연결을 검사한다. 값은 메모리에서
비교하며 감사에는 경로, 길이, element type과 일치 boolean만 남긴다. unrelated array의
숫자나 모든 문자열을 전역 검색해 tuple 일치로 처리하지 않는다.

후속 first-party source 추적에서는 `Xtc`가 `File.size`를 upload metadata에 넣는 경로와
`Aqc(Object.assign({}, f, {Gl:c}))`가 첨부 dqc에 context를 넣는 경로가 달랐다.
관측된 숫자는 파일 크기12와 일치하지 않았다. 따라서 source-confirmed dh·파일명·MIME
binding과 upload query의 final/received-byte proof를 분리한다. context field에 파일
크기를 강제하거나 검사 전체를 삭제하는 방식으로 matcher를 통과시키지 않는다.

검토 중인 child process의 stdin EOF는 승인이나 재전송 신호가 아니다. private control
pipe가 실제로 열린 상태인지 먼저 확인하고, parent는 guard event 처리를 계속 유지한다.
child가 종료돼 business 참조를 잃었다면 이전의 HTTP200 업로드를 재전송하지 않는다.
그 실행은 upload 성공과 attachment binding 미확인으로 구분하고 새로운 parser 검증은
별도 목적·intent로 기록한다.

runner 종료 시 guard를 먼저 제거하지 않는다. v7은 direct start HTTP200 뒤 continuation
capture에 실패했고, finally에서 guard가 제거되자 SDK가 파일을 전송했다. 이후 exact
task session query가 final/12바이트를 반환했다. 이 실행은 browser transfer가 섞인 결과로
보존하며 direct transfer 검증으로 세지 않는다. blank navigation·정확한 marker·quiet
구간까지 확인한 뒤 unroute한다. reset이 실패하면 guard를 유지하거나 정확히 등록된
task-owned target만 닫고 registry에 종료를 기록한다. shared browser/context나 다른
target은 종료하지 않는다.

## 모델 선택과 대화 내용의 검증 위치

Gemini Flash-Lite의 정상 SDK 요청은 metadata header의 `[14]`에 category6, `[15]`에
standard thinking1을 담았다. catalog의 모델 ID를 선택했어도 로컬 category를 null로
두면 실제 capture와의 엄격 비교에서 전송 전에 거절된다. UI label을 일반 enum으로
추정하지 않고 해당 선택의 실제 request capture와 source enum을 연결한다. 이 매핑을
고친 뒤 main CLI의 text 요청은 HTTP200으로 응답했고, 별도 프로세스의 hNv 조회에서
exact prompt·assistant 응답·response ID와 route가 일치했다. 기존 Pro의 불완전한
검증을 이 Flash-Lite 성공으로 덮어쓰거나 전체 모델 entitlement 성공으로 확대하지 않는다.

SDK 준비는 고정된 몇 초 sleep 뒤 시작하지 않는다. 실제 선택 control이 visible인지
bounded wait로 확인한다. 늦은 화면 초기화 때문에 selector가 아직 없는 경우는 owner
불일치나 provider 로그인 실패가 아니다. 전송0이 입증된 preflight 기록을 보존하고,
readiness 조건을 수정한 별도 진단에서 준비를 다시 한다. business intent는 실제
전송된 뒤 자동 반복하지 않는다.

대화 목록은 제목·요약을 반환할 수 있으므로 목록 row에 전체 prompt 문자열이 있는지
확인하는 조건을 task 성공의 필수 gate로 쓰지 않는다. 응답의 conversation ID를 목록과
연결하고 그 same-ID hNv detail에서 exact prompt와 assistant response ID를 확인한다.
파일 내용이 detail의 모든 문자열 중에 존재한다는 사실도 assistant가 파일을 읽었다는
증거가 아니다. 첨부 metadata와 assistant response subtree를 구분하고 실제 응답 ID에
묶인 본문을 비교한다. exact raw file-text 비교, 마지막 newline 차이와 명시적 format
wrapper 비교는 별도 결과로 남기며, 실패한 원 비교를 뒤늦게 true로 덮어쓰지 않는다.

## 공유 링크의 공개 ID와 내부 ID

Grok의 share 생성 응답 `shareLinkId`는 공개 URL alias였고, scoped sharing 조회의
`publicId`와 일치했다. 같은 응답의 `sharing.shareLinkId`는 다른 owner record ID였다.
현재 first-party share dialog도 URL에는 `publicId`, 삭제에는 owner record ID를 쓴다.
생성 응답의 발급 ID를 먼저 보존하고 그 공개 링크의 conversation·response·indexing
상태를 조회한다. scoped publicId와 연결한 뒤 삭제는 그 same-owner record ID에 보낸다.
서로 다른 ID라는 이유만으로 생성 실패로 판정하거나, 관계를 확인하지 않고 다른
scoped 링크를 생성 결과로 바꾸지 않는다.

실제 neutral test에서는 create HTTP200, 공개 링크 조회200·같은 conversation/response,
`allowIndexing:false`, 내부 ID에 대한 DELETE200과 별도 scoped 조회의 링크 없음까지
확인했다. 초기 ID 비교 실패 영수증은 보존하고 read-only 관계 검증과 삭제를 supplement로
연결했다. 최종 결과를 출력하는 wrapper의 오류는 이미 완료된 삭제를 반복하는 근거가
아니다. journal과 저장된 원 응답 metadata를 먼저 확인한다.

## 현재 UI의 구조화된 답변과 ID 범위

현재 Gemini 웹의 실행 script는 `gemini.gstatic.com/_/mss/boq-gemini-web-uiserver`에도
있었다. 예전 `www.gstatic.com`만 허용하면 일반 계정 메뉴 bundle만 보고 답변 renderer를
놓친다. 실제 scriptParsed·network에서 관측한 first-party static asset origin을 사용하고
credential-free GET 또는 그 정확한 target의 Debugger.getScriptSource로 소스를 확인한다.
inline bootstrap은 자격정보가 섞일 수 있으므로 원문을 저장하지 않고 필요한 schema만
메모리에서 검사한다.

현재 renderer 소스는 user query를 `turn.request.textQuery`에서, model response를
`turn.response.Ya.structuredContent`에서 읽으며 `Ya.id`는 draftId로 전달했다. 한 file
task에서 직접 decoder의 21바이트 문자열과 실제 model-response-content의 12바이트
문자열이 달랐다. hNv에는 두 문자열이 모두 있었다. 따라서 배열 아래의 첫 문자열이나
예상 답이 포함된 문자열을 선택해 assistant 답변으로 판정하지 않는다. 실제 같은 turn의
request/response 입력, 구조화된 content와 렌더링 leaf를 연결하고 ID가 turnId·draftId·
clientTurnId·request-context ID 중 어느 범위인지 따로 확인한다. 서로 다른 ID의 equality를
검증 gate로 만들거나, source에 없는 numeric slot을 role로 이름 붙이지 않는다.

## Capture 종료와 실제 브라우저 전달

Grok file/attachment capture에서는 page counter가 HTTP/WSS 전달0이라고 보고했지만,
이후 exact owned CID의 history에 승인한 prompt와 assistant child가 나타났다. 그 counter는
수집 창 안에서 관측한 값이며 전체 브라우저 전달0의 증거가 아니다. 실제 transport host,
기존 connection, worker 소유권과 guard 해제 시점을 조사하고 그 작업을 재전송하지 않는다.

[Playwright Page API](https://playwright.dev/python/docs/api/class-page)는 WebSocket routing이
등록 이후 생성된 socket에만 적용된다고 설명한다. HTTP page routing은 Service Worker가
처리한 요청을 놓칠 수 있다. 해당 한계는 가능한 원인이며, 실제 case의 원인 확정과
구분한다. task target을 blank·marker·quiet 상태로 확인하기 전에 unroute하거나 driver를
종료하면 queued SDK action이 나중에 전달될 수 있다. 실패 경로도 같은 fail-closed
정리를 실행하며, 현재 source-owned target만 종료하는 fallback을 둔다.

## FilesService ZIP과 workspace ZIP

Grok의 task-owned CSV는 content GET200/22바이트였고, FilesService ZIP GET200/194바이트의
유일한 entry가 CSV와 크기·SHA-256까지 같았다. 별도 workspace ZIP은 GET200,
`application/octet-stream`, ZIP magic과 CRC를 확인했지만 해당 CSV entry가 없었다.
두 API를 같은 파일 다운로드의 대체 경로로 완료 처리하지 않는다. octet-stream 허용은
실제 source-resolved workspace ZIP 경로에 한정하고 ZIP signature와 archive entries를
검사한다. 일반 파일 fetcher의 MIME 허용 범위를 넓혀 해결하지 않는다.

## 설정 변경의 현재 코드 검증

Grok `autoWrapLongLinesCode`의 현재 검증은 소유자 GET, 설정 GET, 변경 POST,
독립 GET, 원복 POST, 독립 GET을 각각 기록한다. 실제 변경·원복은 한 번씩이며,
모든 응답은 HTTP 200이었다. 837·838바이트 POST의 원본 응답 해시를 별도 GET과
대조하고 최종 설정 전체가 초기값으로 돌아온 것을 확인했다. 원본 응답 해시와
파싱된 JSON 해시의 종류를 구분하고, 실행 전 import 이전에 기록한 소스 해시가
종료까지 같아야 현재 코드 검증으로 인정한다.

실행 후 인증 함수의 출력 필드가 두 줄 추가되어도 전체 파일 해시로 묶인 증거는
현재 검사에서 drift가 될 수 있다. 기존 실행 결과는 보존하고 변경된 코드는 다시
검증한다. 무관한 변경 때문에 매번 원격 설정을 바꾸는 일을 줄이려면 기능별 계약과
실제 인증·요청·해석·조회 코드의 범위를 따로 기록한다. 과거 증거의 해시만 새 코드로
바꿔 통과시키지 않는다.

## 실제 브라우저로 guard 종료를 재현

격리된 Linux Chromium과 localhost WebSocket 서버에서 양성 대조를 둔다. 페이지가
살아 있는 상태에서 guard를 제거한 대조군은 지연 프레임을 서버로 전달했다. 수정 경로는
socket 생성 전에 guard를 설치하고 control/ACK만 전달한 뒤 business frame을 차단한다.
그 guard를 유지한 채 정확한 소유 target을 blank·marker·quiet로 정리하면 지연 프레임의
서버 수신은 0이었다. 가짜 Page 테스트만으로 Playwright driver 종료 순서를 증명하지
않는다. 최종 정리는 `AsyncExitStack` 또는 driver가 살아 있는 내부 `finally`에서 실행한다.

## 동일 Linux 호스트의 대용량 파일 입력

원격 CDP로 연결한 Playwright의 파일 전송에는 50 MiB 제한이 있었다. 브라우저와 워커가
실제로 같은 Linux 파일시스템을 쓰는 것을 확인한 뒤, HOME 아래의 검증된 파일 경로와
정확한 file input node를 `DOM.setFileInputFiles`에 전달했다. 바이트를 CDP로 직렬화하지
않는다. 149 MiB 시험에서도 서버가 `single_put`을 선택했으므로 multipart만 요구한
검증은 PUT·complete 전에 중단했다. 발급된 해당 upload reference 하나를 abort하고
status의 ABORTED를 확인했다. SDK에 multipart 코드가 있다는 사실과 실제 선택·실행은
별도로 기록한다.

## 구조화된 답변과 citation 중복

Gemini의 같은 작업에서 21바이트 `Ya.vda`와 12바이트 렌더링 답변은 서로 다른 값이었다.
실제 runtime의 `Ya.structuredContent.children[0].children[0].text`와 hNv의 특정 leaf를
길이·해시로 대조하고, 해당 leaf가 `model-response-content` 내부에 표시되는 것을 확인했다.
같은 문자열이 citation/source metadata에도 있으므로 모든 문자열 검색으로 답변을
판정하지 않는다. 관측한 wrapper·node 형태와 typed child path만 해석하고 새로운 형태는
미확인으로 남긴다. 별도의 turnId·draftId 값 비교가 StreamGenerate ID의 의미를 증명하지
않으며, 과거에 잃어버린 writer ID를 이 조회로 복원했다고 주장하지 않는다.
