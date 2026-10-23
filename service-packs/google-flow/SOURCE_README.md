# Google Flow 웹 프로젝트 direct HTTP client

## 2026-10-10: 전용 프로필 동기화와 gflow 백엔드

현재 독립 HTTP `status`는 소유자 일치·프로젝트 미디어 49개·`SNlM0e/FdrFJe/cfb2h` 존재를 확인했습니다. 이것은 이번에 gflow 전용 프로필에 새로 로그인했다는 증거가 아닙니다. Codex Chrome의 Flow 화면은 로그인·PRO 상태였지만 이후 CDP가 `Debugger unattached`로 실패했습니다. Windows 창 제어 도구도 native pipe에 연결되지 않았습니다. 전용 gflow 로그인 크롬은 실행 중이나 디버깅 포트가 없습니다. 따라서 아래 명령의 live 프로필 동기화·브라우저 갱신 관측·Frames 생성·원래 gflow `doctor` 통과는 **미검증**입니다. 승인된 영상 검증은 생성 전 단계에서 `FLOW_PROFILE_NOT_DEBUGGABLE`로 끝났습니다. 생성·프레임 업로드·크레딧 사용은 0회입니다.

새 명령은 전용 프로필의 Chrome이 정상적으로 갱신한 쿠키를 받아 HTTP 클라이언트에 인계하는 방식입니다. [Chrome의 DBSC 설명](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials)에 따르면 장치 키를 가진 Chrome이 짧은 쿠키 갱신을 수행합니다. 이번 계정이 DBSC 때문에 만료됐는지는 브라우저 네트워크 증거가 없어 확정하지 않았습니다. 쿠키 복사는 장치 키를 복사하지 않으며, 키·서명 헤더·챌린지를 합성하지 않습니다.

~~~powershell
node src/cli.mjs sync-from-profile
node src/cli.mjs observe-profile --seconds 60
# 전용 프로필이 다른 위치일 때만 두 명령에 --profile-dir FULL_PATH 추가
node src/cli.mjs status

node src/cli.mjs generate --backend gflow --start-frame IMAGE.jpg --end-frame END.jpg --aspect 9:16 --duration 8 --prompt "Slow camera push in." --out VIDEO.mp4 --confirm-generation
node src/cli.mjs generate --backend gflow --character "Saved Character" --prompt "Slow camera push in." --out VIDEO.mp4 --confirm-generation
# 연장 1회만. --extend 값은 현재 프로젝트의 기존 media ID
node src/cli.mjs generate --backend gflow --extend EXISTING_MEDIA_ID --prompt "Continue the slow camera move." --out EXTENDED.mp4 --confirm-generation
~~~

기본 프로필은 `C:\Users\User\tools\gflow\.gflow\profiles\default`입니다. 실제 해당 프로필의 Chrome 프로세스와 디버깅 포트를 확인하고 loopback CDP에만 연결합니다. 실행 중인 일반 로그인 창을 강제 종료하거나 프로필을 복사하지 않습니다. `FLOW_PROFILE_NOT_DEBUGGABLE`이면 로그인 창에서 정상 로그인과 정상 종료가 필요하며, 종료한 뒤 `sync-from-profile`이 같은 프로필을 최소화한 정상 Chrome으로 실행할 수 있습니다. Chrome 재시작이 필요한 UI 작업에는 `chrome://restart`를 사용합니다. 재시작만으로 기존 실행 인자에 없던 디버깅 포트가 추가되지는 않습니다. 자동화 신호 숨김·브라우저 보안 완화 옵션은 사용하지 않습니다.

동기화는 자체 임시 Flow 탭 하나만 열고 Google/Flow URL에 범위를 제한한 `Network.getCookies`를 사용합니다. 다른 탭·OAuth 탭을 열거하지 않습니다. 만료·다른 도메인·분할 쿠키는 제외합니다. 기존 Google broker의 소유자와 프로젝트를 확인한 뒤 메모리 후보로 독립 HTTP 문서와 보호 RPC를 검증합니다. 성공하고 기존 보호 레코드가 바뀌지 않았을 때만 Flow와 Google broker를 CurrentUser DPAPI에 순서대로 저장합니다. 두 번째 저장만 실패하면 `FLOW_PROFILE_PARTIAL_COMMIT`이며 검증된 Flow 레코드는 보존합니다. 저장은 두 레코드의 원자적 트랜잭션이 아닙니다.

CLI 시작 단계에서 HTTP SSO가 로그인 필요로 거부되거나 복구 후 문서 인증이 다시 실패하면 프로필 동기화를 한 번 시도합니다. 정상 HTTP 세션에는 Chrome 연결을 추가하지 않습니다. 생성 전송 이후에는 이 경로를 실행하거나 생성 요청을 재전송하지 않습니다. 반복 동기화가 필요한 예약 작업은 기존 숨김 런처를 다음 형태로 사용합니다. 이번에는 준비되지 않은 프로필을 반복 실행할 예약 작업을 등록하지 않았습니다.

~~~powershell
wscript.exe //B //NoLogo "$env:LOCALAPPDATA\affiliate-content-operations\hidden-run.vbs" "C:\Program Files\nodejs\node.exe" "C:\Users\User\Documents\GitHub\affiliate-content-operations\apps\google-flow-api\src\cli.mjs" sync-from-profile
~~~

예약 작업은 현재 로그인한 동일 Windows 사용자로 실행해야 DPAPI와 전용 프로필 키를 사용할 수 있습니다. 로그인·기기 승인·눈에 보이는 CAPTCHA가 요구되면 중단합니다. 무기한 자동 로그인을 보장하지 않습니다.

`observe-profile`은 자체 탭의 Network 요청·응답·ExtraInfo와 지원되는 Chrome의 DBSC 이벤트를 관측하며 Google/Flow 범위만 보존합니다. [CDP Network 계약](https://chromedevtools.github.io/devtools-protocol/tot/Network/)의 `enableDeviceBoundSessions`는 설치된 Chrome에서 미지원일 수 있으며, 그때는 지원 여부를 별도로 기록합니다. 저장 위치는 `%LOCALAPPDATA%\affiliate-content-operations\flow-captures\2026-10-10\`입니다. 요청별 JSON에는 호스트·정규화한 경로·헤더 이름·본문 구조·상태만 쓰고 문자열 값은 제거합니다. 원본은 별도 `.dpapi`에 암호화합니다. 제한된 실행 토큰이 ACL 쓰기 권한을 갖지 못하면 기존 디렉터리 ACL을 유지하고 DPAPI 암호화는 반드시 수행합니다. 평문 쿠키·토큰·CSRF·서명 URL은 파일이나 로그에 남기지 않습니다. 쿠키 변화는 메모리에서 비교해 이름만 기록합니다. 한 번의 관측으로 갱신 주기나 만료 원인을 확정하지 않습니다.

Frames·character·extend HTTP 본문 계약은 아직 미확정입니다. `--backend gflow`는 설치된 MIT gflow-cli 1.1.1의 UI 라이브러리를 호출합니다. upstream 런처의 자동화 신호 숨김 옵션과 Windows 프로세스 탐지 누락을 피하기 위해 검증된 전용 CDP 연결을 사용합니다. 기본 `--backend http`와 기존 9:16 빌더는 유지합니다. gflow에서는 설정·정확한 프레임 선택을 확인하지 못하면 생성 전 거부합니다. 오디오·대사 전용 옵션은 `FLOW_AUDIO_CONTRACT_UNVERIFIED`로 거부합니다. 화면 조작의 영어 레이블과 선택 상태가 현재 UI와 다르면 `FLOW_GFLOW_*_UNVERIFIED`로 중단하며, locale 호환과 실제 생성은 아직 확인되지 않았습니다.

gflow 생성도 기존 프로젝트 의도 저널·배타적 잠금을 공유합니다. 생성 버튼은 한 번만 클릭하며 upstream 재클릭 로직을 사용하지 않습니다. 관측 가능한 생성 전송의 추가 요청을 차단하고, 실제 웹 요청 ID를 전송 전에 저널에 기록합니다. 일반 영상은 정확한 요청 ID의 보호 목록 대조 이후 기존 HTTP 폴링·다운로드로 완료합니다. 연장은 gflow 씬의 길이 증가와 정상 내보내기로 확인합니다. 미확정 결과는 `needs_reconciliation`과 잠금을 유지하며, `reconcile --job JOB.json`은 기존 결과만 조회하고 재생성하지 않습니다. 요청 ID가 관측되지 않으면 자동 연결이나 재시도를 하지 않습니다.

오프라인 회귀 검사 182/182을 통과했습니다. 새 검사는 범위 쿠키 필터링·소유자 불일치·동시 저장 변경·부분 저장 실패·CDP 외부 주소 거부·중복 클릭 차단·미확정 생성 잠금 유지·캡처 값 제거·복구 반복 제한을 포함합니다. 기존 issuer 테스트의 오래된 checkout 절대 경로는 현재 모듈 기준 URL로 수정했습니다.

실제 HTTP 조회 증거는 `C:\Users\User\AppData\Local\affiliate-content-operations\flow-captures\2026-10-10\live-status.json`과 같은 폴더의 요청별 `.http.json/.http.dpapi`입니다. 최종 증거 조회의 기존 transport 쿠키 회전 저장은 2회였고 프로필 sync 저장은 0회입니다. 이 HTTP 자료는 브라우저 갱신·DBSC 관측 자료가 아닙니다. 작업 보고와 재개용 검증 명령은 `C:\Users\User\Documents\Codex\2026-10-10\flow-upgrade\`에 보관합니다.

2026-10-08 재검증: 정상 Flow·Google Accounts 화면에서 각각 서비스 범위 인증을 암호화해 DPAPI에 인계한 뒤, 유지 관리 CLI의 HTTP `ServiceLogin → SetOSID` 복구가 소유자·프로젝트·보호 조회를 통과했습니다. 새 9:16·720p·8초 영상 7건(초기 5건과 서로 다른 프롬프트의 연출 수정 2건)을 각각 한 번 생성하고 완료 상태 3 및 MP4 다운로드를 확인했습니다. 생성 요청 재전송은 없었습니다. 최종 독립 HTTP 검증은 프로젝트 미디어 49개, 완료 상태·서명 URL·문서와 RPC 입력 일치를 확인했습니다. [안전한 재검증 영수증](discovery/recovery-debug-2026-10-08.json)

Flow 화면의 로그인 상태만으로 Google 복구용 broker의 재사용을 판단하지 않습니다. Flow 범위 쿠키만으로 만든 Google shared-cookie 후보는 로그인 필요로 거부됐고, 별도 Accounts 범위 현재 번들 인계 뒤 SSO 복구가 성공했습니다. 특정 쿠키 하나의 인과관계나 Google 기본 로그인 자체의 무기한 유효성을 입증한 것은 아닙니다. 복구 실패 시 최초 문서 마커와 안전한 HTTP 홉을 함께 남기고, DPAPI status/read/write timeout을 구별합니다. 읽기 검증기는 양수 바이트만 보고 생성 중 미디어를 고르지 않으며 완료 상태 3도 확인합니다. 완료 영상이 없는 경우에는 인증된 목록 조회와 다운로드 검증 불가를 구분합니다.

기존 Flow 웹 프로젝트와 웹 크레딧을 대상으로 합니다. 반복 조회·다운로드는 관측한 HTTP 계약을 Node 클라이언트로 실행합니다. 별도 Gemini Developer API 과금 계정이나 Chrome 확장·WebSocket 브리지는 사용하지 않습니다.

## 현재 검증: 2026-10-06

**유지 관리 CLI의 기본 generate 경로로 8초 원본 영상을 실제 생성·다운로드하고, 480p로 변환해 검증했습니다.** 현재 Flow 문서에서 키를 읽고, 수정하지 않은 Google Enterprise SDK를 Node 24.10.0 + jsdom 26.1.0 worker에서 실행했습니다. 브라우저 엔진과 위조한 브라우저 신호는 사용하지 않았습니다. SDK가 만든 새 reload protobuf 9,389바이트를 Google에 한 번 보냈고, HTTP 200 응답의 토큰과 SDK 반환값이 일치한 것을 메모리에서 확인한 뒤 YhhmEf 생성 요청을 한 번 보냈습니다.

기준 프로젝트 미디어 수는 39개였습니다. 생성 요청은 HTTP 200을 받았고, 보호된 프로젝트 조회로 새 생성물을 재확인했습니다. jwpduf를 다섯 차례 조회해 이 미디어의 완료 상태 3을 확인한 다음, 유지 관리 CLI가 같은 저널로 flow-content.google에서 HTTP 200·video/mp4 파일을 다운로드했습니다. 생성 재시도는 0회입니다.

| 단계 | 실제 결과 |
| --- | --- |
| 기본 Node issuer | 현재 Flow 키·anchor를 HTTP로 읽음; 수정하지 않은 SDK와 worker_threads 실행 |
| Google reload | 9,389바이트 POST 1회, HTTP 200, 응답 토큰과 SDK 토큰 일치 |
| Flow 생성 YhhmEf | POST 1회, HTTP 200, 기준 미디어 수 39 |
| 서버 완료 | jwpduf 5회 조회, 관측 상태 3, 3,083,154바이트 |
| HTTP 다운로드 | flow-content.google GET 1회, HTTP 200 video/mp4, 3,083,154바이트; 생성 재시도 0 |
| 원본 720p | 1280×720, 8초, 24fps·192프레임, H.264; 3,083,154바이트 |
| 요청한 480p | 원본에서 로컬 변환, 854×480, 8초, 24fps·192프레임, H.264; 1,373,017바이트; 전체 디코드와 프레임 시각 검증 통과 |
| 운영 CLI 기본 경로 | 실제 generate 1회, 소유자 재확인·완료 조회·같은 저널 다운로드 성공 |

전체 단계와 안전한 요청 식별자는 [유지 관리 CLI 순수 HTTP 영수증](discovery/maintained-cli-pure-http-generation-2026-10-06.json)에 기록했습니다. Flow 인증은 생성 전에 공식 세션에서 범위 쿠키를 DPAPI에 저장한 전제이며, 로그인 자체는 생성 작업 범위 밖입니다. 생성 입력 발급·생성·완료 확인·다운로드에서는 브라우저 엔진을 사용하지 않았습니다.

이번 성공은 앞서 격리 harness에서 완료한 yellow-boat 영상과 별도 실행입니다. 2026-10-05 브라우저 SDK가 입력을 발급하고 Node HTTP가 생성한 hybrid 결과도 이 영수증과 합치지 않습니다. 이전 유지 관리 CLI worker/startup 오류는 Flow create 요청 전 단계에서 끝났고, 해당 실행의 create 시도 수는 0입니다. 2026-10-05 입력 생략 진단의 RPC 거부 이력도 별도 저널에 남아 있으며, 현재 성공 경로와 혼동하지 않습니다.

이번 라이브를 막았던 호환성 문제는 세 곳에서 수정했습니다. jsdom ResourceLoader 응답의 표준 metadata를 Node 응답과 함께 보존하고, 공유된 window/frame 메시지의 실제 source와 origin을 추적하며, 관측된 표준 Node HTTPS agent를 사용합니다. 임의의 proxy·사용자 정의 agent와 약한 TLS 설정은 계속 차단됩니다. 입력 원문·쿠키·서명 URL은 로그나 영수증에 저장하지 않습니다.

2026-10-05의 정상 UI 생성·hybrid Node HTTP 생성·입력 생략 거부는 서로 다른 과거 실행입니다. 각 기록은 [정상 UI 생성](discovery/live-ui-generation-lifecycle-2026-10-05.json), [SDK 입력 hybrid 생성](discovery/sdk-input-http-create-2026-10-05.json), [첫 HTTP 거부 진단](discovery/live-create-diagnostic-2026-10-05.json), [Referer 수정 뒤 진단](discovery/root-referer-create-probe-2026-10-05.json)에 있습니다. 앞선 격리된 순수 HTTP yellow-boat 실행은 [별도 영수증](discovery/node-sdk-pure-http-generation-2026-10-06.json)에 보존했습니다. 다른 참조 이미지·프레임·편집·연장·업스케일 작업은 별도 live 검증이 필요합니다.

## 정상 발급 시퀀스 조사 기록

2026-10-05의 [발급 연결 검증](discovery/normal-sdk-issuance-lineage-2026-10-05.json)은 정상 SDK의 anchor GET → reload POST → 응답 토큰 → 생성 본문을 대조했습니다. 12,057바이트 application/x-protobuffer 본문은 13개 필드로 완전히 해석됐고, 필드 1·2·8·14와 응답 토큰의 전달 경로를 확인했습니다. 당시에는 독립 Node 실행으로 새 토큰을 발급하지 못했습니다. 다음 날의 [전체 Node SDK HTTP 영수증](discovery/node-sdk-pure-http-generation-2026-10-06.json)이 그 당시 남아 있던 발급 공백을 채웠습니다.

2026-10-05의 별도 Node anchor GET은 초기화 논스까지만 읽었고 최종 작업 토큰을 발급하지 않았습니다. 브라우저 SDK 입력 전달 시도와 iframe 중단 오류도 당시 도구 진단이며, 서버가 Node HTTP를 거부했다는 뜻은 아닙니다. 앞선 전체 조사에서 미디어가 37→38개로 변한 활동은 생성 전송 경로가 연결되지 않아 이 HTTP 성공으로 세지 않았습니다. 당시 이벤트를 모두 0건이라 단정하지도 않았습니다. 세부사항은 [issuer 후속 진단](discovery/issuer-debugging-followup-2026-10-05.json)에 보존합니다.

## 정상 UI 생성·완료 흐름 (2026-10-05 비교 자료)

UI에서 모델 목록을 열어 Omni 1.1 Flash를 선택하고 720p·8초·x1 항목을 클릭했습니다. 화면비는 16:9였고 비용은 12크레딧으로 표시됐습니다. 입력 후 생성 버튼을 한 번 눌렀습니다.

정상 웹 경로는 reCAPTCHA Enterprise SDK의 VIDEO_GENERATION 입력을 만들고 YhhmEf에 보냅니다. reCAPTCHA reload는 HTTP 200 JSON, clear는 HTTP 200 binary로 관찰됐습니다. 입력 값은 재사용하거나 저장하지 않았습니다. YhhmEf 요청의 모델 키는 abra_t2v_8s, 화면비 코드는 2였고, 접수 응답에서 미디어 ID·CAE·잔여 크레딧 1,038을 받았습니다. 생성 전 잔여 크레딧은 1,050이었습니다.

브라우저는 jwpduf를 대략 5초 간격으로 반복했습니다. 상태 코드 6 다음 2가 반복되다가 3으로 바뀌었고, POST 약 39.625초 후 완료 응답에 영상 바이트 수가 들어왔습니다. 3은 이 영상의 완료 화면·영상 URL·실제 파일과 함께 확인한 관측값이며, 미확인 전체 상태 열거형으로 확대하지 않습니다. 이어 as29s가 영상 URL을 반환했고 UI에 새 썸네일과 8초 재생기가 나타났습니다.

완료 화면의 다운로드 선택지는 270p GIF, 720p 원본, 1080p 업스케일과 비활성 4K였습니다. 720p 다운로드를 클릭한 뒤 CUA 탭 식별자가 바뀌고 화면 조회가 시간 초과됐으므로 UI 다운로드 완료는 주장하지 않습니다. 독립 HTTP 클라이언트의 새 영상 다운로드와 파일 검증은 완료했습니다. 생성·다운로드 UI에는 480p 항목이 없어 720p 원본을 별도로 변환했습니다.

## SDK와 HTTP 요청 비교 (2026-10-05 과거 진단)

2026-10-05에 정상 Flow 화면에서 새 요청을 관찰했지만, YhhmEf를 보내기 전에 취소했습니다. 따라서 이 비교 작업의 생성 POST는 0건입니다. 별도 HTTP 프로세스의 보호 조회는 HTTP 200으로 완료됐고 프로젝트 미디어 36개를 읽었습니다.

| 비교 항목 | 실제 관찰 | 해석 |
| --- | --- | --- |
| 생성 본문 | 일회성 입력과 요청별 UUID를 마커로 바꾸면 HTTP 빌더의 비즈니스 본문과 일치. YhhmEf, 모델, 화면비, 현재 프로젝트와 입력 필드 형태가 같음 | 요청 직렬화가 맞는다는 증거이며 HTTP에서 입력을 발급하거나 생성이 성공한다는 증거는 아님 |
| 폼·쿼리 | `f.req`·`at` 및 쿼리 키 구성이 같고 source path·build·언어·응답 형식이 일치 | 문서 세션 값 `f.sid`, `at`, 요청 카운터 `_reqid`는 각 문서와 호출에서 달라짐. 이를 생성 실패 원인으로 단정하지 않음 |
| 헤더 | `content-type`, `origin`, `x-same-domain`, `accept` 값이 같음. 브라우저는 User-Agent와 `sec-ch-ua*`를 더 보냄 | 브라우저 지문 헤더를 흉내 내지 않음. 관측한 Flow 문서 루트 `/`를 Referer로 사용. 이를 적용한 입력 생략 진단도 아래의 broad denial을 받음 |
| 세션 쿠키 | 초기 캡처는 브라우저 요청 21개와 HTTP 19개를 비교했고 RTS 두 이름이 HTTP 쪽에 없었음. 그 비교 당시 보호 저장에는 21개가 있었고 RTS 두 쿠키는 만료되어 HTTP 요청은 19개만 보냄 | 쿠키 차이만으로 그 거부의 원인을 입증하지 못함. 당시 보호 프로젝트 조회는 HTTP 200, 미디어 36개 |
| 완료 대기 | 읽기 전용 대기에서 대상 미디어의 `jwpduf` 상태 3과 양수 바이트를 확인한 뒤 `as29s` HTTP 200으로 다운로드 준비 응답을 받음 | 이 관찰 작업은 생성 0건·다운로드 0건. 상태 3은 확인한 이 미디어의 완료 모양이며 전체 상태 열거형을 뜻하지 않음 |

Flow 응답에서 관측한 새 쿠키명도 이름 allowlist 없이 추가할 수 있도록 회전 처리를 보강했습니다. 응답 출처, 허용 도메인, 경로, 만료, Secure 속성을 검사하며 보호 저장소는 scope별 쿠키 메타데이터를 유지합니다. 이번 요청 비교에서 새 생성 쿠키를 보냈다는 뜻은 아닙니다.

비교 캡처 뒤 Referer를 프로젝트 경로에서 관측된 Flow 루트로 맞춘 상태로 입력 없는 YhhmEf 진단을 한 번 보냈습니다. 2026-10-05 09:08:00Z 응답은 HTTP 200 JSON이었지만 RPC 상태 7, `PUBLIC_ERROR_UNUSUAL_ACTIVITY`였고 접수 확인이나 미디어 ID가 없었습니다. 요청 UUID를 저널에 저장했습니다. 즉시, 15초 뒤, 약 180초 뒤 소유자 조회에서 해당 요청 UUID의 씬은 보이지 않았고 미디어 수 36개·크레딧 1,038은 그대로였습니다. 당시 `needs_reconciliation`과 잠금을 유지했습니다. 11:51:13.553Z에 약 9,792초 뒤의 정확한 부재 확인과 원래 no-ack 오류를 대조해 같은 저널을 수동 `rejected`로 정리하고 잠금을 해제했습니다. 당시 표시 크레딧은 1,050으로 바뀌어 있었으므로 미생성 근거에 쓰지 않았습니다. 해당 요청을 재전송하지 않았습니다. 이 응답은 Referer 하나가 유일한 문제라는 설명을 지지하지 않지만, 입력 생략이 유일한 원인이라는 증거도 아닙니다. 이 문장은 2026-10-05 진단 당시 기본 HTTP 경로 상태를 설명하며, 2026-10-06 Node SDK 발급 실험에 대한 설명이 아닙니다. 당시에도 미해결 저널이 있으면 같은 저널 확인을 먼저 요구했습니다.

## Shorts 파이프라인에서 가져온 검증 단계

Shorts의 `video-kit`에서 사용할 만한 부분은 생성 입력이 아니라 완료된 영상의 검사 단계입니다. 이번 기존 8초 영상은 그 흐름으로 전체 파일을 디코드하고 검사했습니다. 원본 1280×720과 변환본 854×480 모두 8초·24fps·H.264/AAC였고, 검출된 검은 화면이나 정지 구간이 없었습니다. 이번 확인에서는 새 Flow 생성이나 추가 다운로드를 하지 않았습니다.

이 검사는 Flow 다운로드 뒤 결과물 품질 확인에 적용할 수 있습니다. 로컬 FFmpeg 쇼츠 렌더러와 `video-kit`은 서버 생성 상태를 폴링하거나 Flow용 reCAPTCHA 입력을 발급하지 않으므로, 순수 HTTP 생성 발급기의 대안은 아닙니다. YouTube의 브라우저 보조 업로드 사례도 서비스별 전송 계약이므로 Flow 생성 성공 근거로 사용하지 않습니다.

## 재확인 UUID 매칭 수정

실제 생성 후 소유자 목록에서 미디어를 찾지 못하는 버그를 발견했습니다. 생성 요청 내부 request[4]의 두 클라이언트 UUID와 최상위 payload[2][0]의 요청 UUID는 다릅니다. 서버 프로젝트 목록의 scene[3][5]에는 후자가 저장됩니다.

이제 buildTextVideoSubmission은 requestId를 반환하고, 입력 바인딩과 의도 저널에 저장합니다. 재확인은 scene[4]의 프로젝트 범위와 scene[3][5]의 정확한 requestId를 대조하고 scene[3][4]의 미디어 ID를 읽습니다. 새 저널의 요청 ID가 불일치하면 두 클라이언트 UUID로 우회하지 않습니다. requestId가 없는 구형 저널은 읽을 수 있지만 두 클라이언트 UUID로 결과를 자동 연결하지 않고 미해결 상태를 유지합니다. 구형 저널 복구에는 별도의 확인 가능한 증거가 필요합니다.

실제 새 UI 저널은 관측된 요청 UUID와 같은 씬·미디어를 HTTP로 확인한 뒤 기존 미디어를 다운로드했고 downloaded로 완료됐습니다. 같은 생성 요청을 다시 보내지 않았습니다. 실제 서버 씬 구조와 요청 ID 불일치·다른 프로젝트·다운로드만 수행하는 재개 회귀 검증을 추가했습니다.

## Node SDK direct HTTP 발급과 운영 CLI 검증

유지 관리 CLI의 generate 명령은 현재 Flow 문서의 공개 키를 읽은 뒤 Google의 관측된 loader·anchor·worker·runtime을 Node HTTP로 가져오고, 수정하지 않은 Enterprise SDK를 jsdom worker 안에서 실행합니다. 2026-10-06 라이브 실행에서 SDK는 reload 요청을 한 번 만들었고, HTTP 200 응답 프레임을 해석해 받은 토큰과 SDK 반환값이 같음을 확인했습니다. 일치 확인 뒤에만 Flow YhhmEf create를 한 번 보냈습니다. 토큰과 원시 본문은 입력·저널·로그에 남기지 않았습니다.

생성 전송 뒤 프로젝트 소유자 읽기, 서버 처리 폴링 5회, HTTP 200 video/mp4 다운로드와 파일 검증이 모두 같은 의도 저널에 연결됐습니다. [유지 관리 CLI 라이브 영수증](discovery/maintained-cli-pure-http-generation-2026-10-06.json)은 기본 CLI generation 경로의 발급·생성·완료 확인·다운로드를 증명합니다. 실행 요약에서는 기준 프로젝트 미디어가 39개였고, YhhmEf POST는 한 번이었습니다. 다운로드 재개 중 create 재시도는 없었습니다.

Node SDK 호환 층은 공식 SDK의 실제 웹 요청 순서를 실행하는 데 필요한 범위로 제한됩니다. jsdom에서 표준 응답 metadata를 보존하고 공유 frame의 실제 메시지 source/origin을 연결하며, 관측된 기본 Node HTTPS agent를 사용합니다. Chrome UA·client hints·하드웨어 신호를 만들어내지 않고 browser engine도 실행하지 않습니다. proxy, 임의 custom agent와 약한 TLS 설정은 허용하지 않습니다. 공식 SDK 소스는 수정하지 않았습니다.

첫 maintained CLI startup/worker 오류는 create 전 단계에서 종료돼 Flow create 0회였습니다. 위 영수증은 그 뒤 기본 CLI 경로가 성공한 별도 실행입니다. 과거 yellow-boat harness 성공은 [독립 영수증](discovery/node-sdk-pure-http-generation-2026-10-06.json)에, 2026-10-05 browser-SDK-input hybrid와 입력 생략 거부는 이전 기록에 각각 분리해 보존했습니다. 이 텍스트 영상 한 건의 성공을 다른 생성 모드나 모든 계정으로 확대하지 않습니다.

## 저널과 실패 처리

프로젝트별 배타적 예약과 의도 저널을 먼저 기록하고, 접수 media ID를 다운로드 전에 체크포인트로 남깁니다. 전송 후 결과가 불확실하면 잠금을 유지하고 같은 저널의 보호 조회로 재확인합니다. HTTP 200 오류나 임의의 로컬 MP4만으로 잠금을 풀지 않습니다.

2026-10-05 입력 생략 진단 두 건은 RPC 상태 7과 보호 소유자 조회를 대조해 별도로 정리했습니다. browser-SDK-input hybrid 실행도 10-06 maintained CLI generation과 다릅니다. 새 기본 CLI 성공 실행은 새 일회성 입력·의도·request UUID로 create를 한 번 보냈고, 정확한 media를 확인한 뒤 같은 저널에서 다운로드했습니다. 초기 startup/worker 오류의 create count는 0이었으며, 거부 응답이나 HTTP 200만으로 create를 재시도하지 않았습니다.

2026-10-05 당시 browser_sdk_diagnostic 저널 모드를 로더가 다루지 못해 보류 작업 탐색이 실패하던 버그를 수정했습니다. 해당 모드는 기록 출처로만 읽습니다. 완료 진단은 다음 탐색을 막지 않고, 불확실한 진단은 보류 상태를 유지하며, 알 수 없는 모드는 예약 전에 거부합니다. 이 과거 코드 기준 회귀 검사는 93/93이었습니다.

입력 만료는 획득 직후와 전송 직전에 검사합니다. 최대 2분과 시계 차이 5초는 클라이언트 정책입니다. 입력 원문과 지문은 저널·로그에 남기지 않습니다. 브라우저에서 얻은 토큰, 다른 출처·작업에 바인딩된 입력, 변조·만료 입력은 전송 전에 거부합니다. 현재 verified live proof는 위 영수증의 Node SDK generation 실행입니다.

## 인증과 실행

Windows, Node.js 24 이상이 필요합니다. 2026-10-06 공식 Flow UI는 인증된 상태였습니다. 범위가 제한된 CUA 쿠키 부트스트랩은 21개 항목을 반환했고, 만료 시각을 확인해 이미 만료된 임시 RTS 두 개를 제외한 19개 유효 항목만 Windows CurrentUser DPAPI의 google-flow-session-v1에 저장했습니다. 2026-10-06T00:31:24.262Z의 CLI status는 인증됨과 프로젝트 미디어 39개를 반환했습니다. 이는 기존에 인증된 UI 세션에서 가져온 자격 증명과 현재 보호 HTTP 읽기가 통한다는 증거이며, 만료된 세션의 로그인·복구를 입증하지는 않습니다. 원문 쿠키는 명령행·로그·프로젝트 파일·Git에 쓰지 않습니다.

반복 실행은 보호 저장소를 읽고 GET https://flow.google.com/project/{projectId}에서 SNlM0e·FdrFJe·cfb2h를 새로 파싱합니다. cookies[]의 도메인·hostOnly·경로·만료·Secure 정보를 검증하고 보존하며, 만료 항목을 요청 쿠키에 포함하지 않습니다. 과거 2026-10-05 회전 시험에서는 관측된 https://accounts.google.com/RotateCookiesPage GET과 공개 쿼리 og_pid=749, rot=3, origin=https://flow.google.com, exp_id=0를 Node HTTP로 재생해 HTTP 200 및 세 쿠키 회전을 확인했습니다. 그 시점의 별도 보호 읽기는 인증됨·미디어 38개를 반환했지만, 세션은 회전 전에 이미 인증돼 있었습니다. 따라서 이 과거 38개 읽기는 만료 복구 증거가 아닙니다. 더 늦은 2026-10-05T23:57:20.330Z의 같은 페이지 GET도 HTTP 200과 저장된 쿠키 3개를 남겼으나, 그 다음 Flow 문서에는 SNlM0e가 없었습니다. 이 최신 회전 응답만으로 Flow API 인증이 성립했다고 보지 않습니다. 후속 정상 UI 세션에서 얻은 CUA 부트스트랩이 현재 보호 읽기의 기반입니다. 만료 RTS 쿠키를 사용한 별도 CLI 갱신 시도는 유효한 복구 검증이 아니었습니다. 정적 코드의 POST /RotateCookies는 네트워크에서 관측하지 않아 보내지 않았고, 별도 로그아웃·로그인도 하지 않았습니다. 생산용 발급 및 갱신 경로의 live 검증 상태는 아래 표를 참조하세요.

앱은 Node.js 24 이상을 요구합니다. package.json에 jsdom 26.1.0과 parse5 7.3.0이 지정돼 있습니다. jsdom은 수정하지 않은 first-party SDK에 필요한 DOM·worker 인터페이스를 제공하며, 생성 경로는 브라우저 엔진을 실행하지 않습니다. generate 기본값은 16:9·8초·720p이며, 실제 생성에는 --confirm-generation이 필요합니다.

~~~powershell
cd C:\Users\User\Documents\GitHub\affiliate-content-operations\apps\google-flow-api
npm install
node src/cli.mjs status
node src/cli.mjs generate --prompt-file .runtime\prompt.txt --out .runtime\generated.mp4 --confirm-generation
node src/cli.mjs list
node src/cli.mjs generation-state --media-id EXISTING_MEDIA_ID
node src/cli.mjs download --media-id EXISTING_MEDIA_ID --out .runtime\existing.mp4
node src/cli.mjs reconcile --job .runtime\jobs\EXISTING_JOB_ID.json
npm test
# 선택: 정상 쿠키 회전이 필요할 때만 실행; 최초 로그인이나 만료 로그인 복구가 아님
node src/cli.mjs renew-session
~~~

download는 기존 미디어의 프로젝트 소속과 새 출력 경로를 확인하고 저널을 만듭니다. 서명 URL은 메모리에만 유지하고 flow-content.google HTTPS /video/{mediaId}만 받습니다. MIME·길이·MP4 시그니처를 확인하고 원자적인 배타적 링크로 파일을 생성합니다.

실패 시 안전한 오류 코드·HTTP 상태·RPC 상태·RPC 이름·시각과 재개 경로를 남깁니다. 재개는 URL을 새로 조회해 처음부터 다운로드하며 Range 이어받기는 없습니다. 강제 종료 시 .part 파일이 남을 수 있습니다. .runtime과 영상 파일은 Git에서 제외합니다.

## 검증 범위

| 작업 | captured | client_exists | remnant_free | credential_propagated | live_replay |
| --- | --- | --- | --- | --- | --- |
| 프로젝트·상태·미디어 조회 | true | true | true, 반복 조회 | true, DPAPI → HTTP | 10-06T09:50Z CLI SSO 복구 후 41개; 09:54Z 자동 복구 후 42개 보호 조회 |
| 기존·새 완성 영상 다운로드 | true | true | true, 반복 다운로드 | true, URL 조회에 DPAPI 사용; 파일 GET에는 쿠키 없음 | true, maintained CLI GET 200·video/mp4 |
| 정상 UI 영상 생성 | true, 실제 완료 | 별도 브라우저 관찰 | false | UI 세션 사용 | 브라우저 생성 1건, 10-05 |
| SDK 입력을 이용한 과거 Node HTTP 영상 생성 | true | 별도 hybrid 진단 | false, 입력은 browser SDK 발급 | 캡처 세션·새 SDK 입력 사용 | HTTP 생성 1건, 10-05 |
| 격리 Node SDK 발급 전체 흐름 | true, 실제 reload→token 연결 | 별도 Node harness | true, 생성 단계 browser engine 없음 | true, DPAPI 세션 → Node HTTP | yellow-boat 생성·완료·다운로드, 별도 영수증 |
| 유지 관리 CLI Node SDK generation | true, 실제 reload→token 연결 | true, 기본 generate 경로 | true, 발급·생성에 browser engine 없음 | true, DPAPI 세션 → Node HTTP | reload 200·create 200 1회·5 polls·download 200·same journal, 10-06 영수증 |
| 관측된 Google SSO → Flow 문서 세션 읽기 | true, GET 리다이렉트와 SetOSID 응답 | true, recover-session 및 생성 전 자동 복구 | true, 브라우저 엔진 없이 관측한 HTTP 체인 | Google DPAPI broker의 쿠키 → Node HTTP; 최초 요청에는 Flow host 쿠키 없음 | CLI 복구로 새 OSID 발급·소유자·41개 보호 조회; 이후 새 생성·다운로드 및 42개 자동 복구 조회 통과 |
| `RotateCookiesPage` 쿠키 회전 | true, 관측된 GET 계약 | true, renew-session | true, Node HTTP | 기존 Google 세션 쿠키 → Node HTTP | SIDCC 계열 3개 회전은 확인; 로그인 세션 복구가 아님 |
| 현재 Nano Banana 이미지 생성 | UI만 확인 | false | 미검증 | 미검증 | false |

captured는 관측된 계약, live_replay는 명시한 실행 모드의 실제 결과입니다. 10-06의 유지 관리 CLI 행은 한 개의 텍스트 영상에 대한 실제 end-to-end 성공입니다. Cookie rotation 성공을 expired-login recovery로 확대하지 않습니다.

2026-10-06 최신 읽기 검증에서는 별도 Google 계정 세션 broker의 Windows CurrentUser DPAPI 쿠키를 사용했습니다. broker가 제공한 25개 Google 범위 쿠키로 새 Node HTTP 요청을 시작했으며, 첫 요청에는 Flow host 쿠키가 없었습니다. Flow 프로젝트 GET이 accounts.google.com의 `ServiceLogin`으로 302 이동했고, 관측된 SSO 리다이렉트를 따라 `/accounts/SetOSID` 응답에서 Flow host의 OSID 계열 쿠키를 받은 뒤 같은 프로젝트 URL이 `?pli=1`로 HTTP 200을 반환했습니다. 문서의 `SNlM0e`와 활성 소유자 필드 `oPEP7c`를 확인하고 보호 RPC로 현재 프로젝트 미디어 41개를 읽었습니다. 이는 이미 정상 로그인된 Google 계정 세션에서 Flow 세션 문서와 보호 읽기를 HTTP로 복구한 결과입니다. 비밀번호·MFA 로그인, 만료된 Google 계정 세션의 복구, 무기한 세션 유지는 검증하지 않았습니다. `RotateCookiesPage`는 SIDCC 계열 쿠키 회전만 보여 주었고 이 SSO/SetOSID 흐름을 대체하지 않습니다. 후속 정식 CLI `recover-session`이 같은 흐름을 통과했습니다. 생성 전에 문서 토큰 누락·인증 쿠키 삭제·Google 로그인 리다이렉트·401/403을 만나면 보호 Google broker가 있는 경우 한 번만 HTTP 복구합니다. 생성 요청 이후에는 자동 인증 복구나 생성 재전송을 하지 않습니다.

[2026-10-06 Google SSO → Flow 읽기 복구 영수증](discovery/login-recovery-live-2026-10-06.json)

## 캡처 로그 주의

관측된 Flow URL-encoded 폼만 f.req·at 필드명으로 해석합니다. reCAPTCHA 바이너리에 URLSearchParams를 적용하면 일회성 값이 가짜 필드명으로 출력될 수 있습니다. 검증된 protobuf 디코더로 필드 번호·wire type·길이·메모리 내 일치 여부만 기록할 수 있으며, 원시 값·본문·토큰 지문은 남기지 않습니다. 이전 진단에서 출력에 섞인 일회성 값은 파일에 저장하거나 생성에 재사용하지 않았습니다.

과거 영수증은 [읽기·다운로드](discovery/api-only-replay-2026-10-05.json), [앞선 생성 전 차단 캡처](discovery/http-generation-path-2026-10-05.json), [09-27 브라우저 생성 추적](discovery/full-generation-xhr-trace-2026-09-27.json)에 보존했습니다.

2026-10-06T03:14Z 배포 후 세션 점검: 앞서 정식 CLI의 HTTP 전용 발급·생성·완료 관찰·다운로드 성공은 그대로 유효합니다. 이후 문서 GET은 HTTP 200과 Flow 설정 마커를 반환했지만 SNlM0e 요청 토큰이 없었습니다. 저장된 19개 쿠키는 만료되지 않았으며, 이것만으로 로그아웃이나 세션 만료를 판정할 수 없습니다. 관측된 RotateCookiesPage GET의 정상 회전은 HTTP 200으로 끝나 DPAPI에 반영됐지만 Flow 보호 읽기 검증은 통과하지 못했습니다. 진단 중 Flow RPC와 추가 생성은 모두 0회입니다. 현재 세션 재사용 가능 여부는 미확인으로 남기며, 요청 토큰이 있는 정상 문서와 보호 읽기를 확보하기 전에는 다음 생성으로 진행하지 않습니다. 지원 CUA 진단도 focus emulation 시간 초과로 현재 UI 상태를 확인하지 못했습니다. 별도 post-delivery-session-readback-2026-10-06.json에 안전한 점검 메타데이터를 기록했습니다.

이후 새 공식 Flow 탭에서 동일 소유자 계정의 로그인과 PRO 상태를 확인했습니다. 새 탭의 scoped 인증 자료를 읽는 지원 CDP 연결은 Debugger unattached로 실패하여 DPAPI 재부트스트랩은 완료하지 않았습니다. 따라서 공식 UI 인증 확인과 기존 DPAPI HTTP 세션 재사용 검증은 구분하며, 현재 HTTP 보호 읽기는 여전히 요청 토큰 누락으로 검증되지 않았습니다. 추가 생성 요청은 없습니다.

2026-10-06T04:09Z 후속 복구 및 고양이 영상 검증: 새 공식 Google 로그인 세션의 현재 소유자·PRO 상태를 확인하고, 지원 CUA CDP로 얻은 유효한 서비스 범위 쿠키 21개를 암호화해 Windows DPAPI에 다시 저장했습니다. 같은 유지 관리 CLI의 보호 HTTP 조회는 인증됨·프로젝트 미디어 40개를 반환했습니다. 이어 기본 Node issuer로 새 입력을 발급하고 고양이 춤 8초 영상을 한 번 생성해, 보호 프로젝트 재확인·서버 완료 조회 4회·HTTP 200 MP4 다운로드를 완료했습니다. 생성 재시도는 없습니다. 720p 원본을 로컬에서 480p로 변환했고 854×480·8초·24fps·192프레임, 전체 디코드 및 video-kit 검사를 통과했습니다. 32개 표본 프레임의 독립 검토에서 외형과 춤을 확인했지만, 회전 각도는 계획보다 크고 흰 반짝임 표식이 남습니다. 이전 요청 토큰 누락과 진단 연결 실패는 과거 관측으로 보존하며, 이번 새 부트스트랩·보호 읽기·새 생성으로 현재 경로를 재검증했습니다. 비밀번호 로그인 자체, 만료 로그인 복구, 무기한 세션 유지나 광고 성과는 입증하지 않습니다.

[고양이 영상 HTTP 검증 영수증](discovery/cat-dance-http-generation-2026-10-06.json)


2026-10-06T06:28Z 로그인 복구 조사: 05:55Z에는 동일한 전체 DPAPI 번들로 보호 프로젝트 조회(미디어 41개)가 성공했지만, 이후 전체 번들 문서 GET은 HTTP 200 HTML에서 SNlM0e가 누락됐습니다. 현재 쿠키 21개 중 __Secure-1PSIDRTS·__Secure-3PSIDRTS 두 개의 만료를 확인했으나, 만료가 원인이라는 인과관계는 검증하지 않았습니다. 격리 메모리의 활성 shared Google 쿠키 17개로 관측된 GET 리다이렉트를 따라가면 ServiceLogin → 계정 입력 화면에 도달합니다. 관측된 RotateCookiesPage GET은 HTTP 200으로 SIDCC 계열 세 쿠키를 회전시켰지만, 이후 부분 번들은 여전히 계정 입력 화면에 머물렀습니다. 전체 번들 요청은 프로젝트 HTML 200을 받았지만 SNlM0e 누락으로 세션 상태가 미정이고 보호 RPC readback은 실행되지 않았습니다. 시험에서 보호 저장소를 덮어쓰거나 로그인 폼을 POST하거나 영상을 생성하지 않았습니다. 기존 Node 발급·영상 생성 성공과 이번 로그인 복구 실패를 구분합니다.

요청 토큰 누락은 이제 FLOW_DOCUMENT_REQUEST_TOKEN_MISSING·sessionStatus=undetermined로 보고하고, CLI에는 상태 코드·허용된 MIME·경로 종류·마커 존재 여부만 남깁니다. 인증 쿠키 삭제는 리다이렉트 상태와 함께 별도 코드로 우선 보고하며 리다이렉트 자동 추적은 하지 않습니다. 정상 로그인 제출 계약은 아직 캡처하지 못했습니다. 지원 브라우저의 DOM·스크린샷·scoped 쿠키 조회가 시간 초과이고, 당시 PC 여유 메모리는 140MB였습니다. 자원 부족이 시간 초과의 원인이라고 확정하지 않습니다. 브라우저 연결이 응답하면 정상 Google 로그인 요청 순서를 관찰해 HTTP 복구 구현을 이어가야 합니다.

[로그인 복구 조사 근거](discovery/login-recovery-investigation-2026-10-06.json)

2026-10-06T06:51Z 추가 소스 점검: 비로그인 홈과 현재 프로젝트 HTML이 참조한 공개 Flow JS(995,891바이트)는 동일했고, 기존 보호 RPC 식별자 YhhmEf·Zzl0ze·jwpduf가 없었습니다. 다른 관측된 공개 스크립트(79,905바이트)에서도 로그인·RTS 갱신 계약은 찾지 못했습니다. 이 파일들의 결과를 전체 인증 앱의 기능 부재로 확대하지 않습니다. 프로젝트 문서는 계속 HTTP 200·SNlM0e 누락으로 세션 상태 미정이며, 지원 DOM·프레임 조회·네트워크 이벤트 조회도 시간 초과였습니다. 이번 소스 점검의 보호 RPC·로그인 제출·생성·보호 저장소 쓰기는 모두 0회입니다. 정상 로그인 흐름 관측에는 응답하는 브라우저 연결이 필요합니다.

2026-10-06T09:54Z 정식 CLI 복구·생성 검증: 기존 프로필로 Canary를 재시작해 지원 연결을 복원하고 정상 Google 계정 선택 요청을 관찰했습니다. 이후 캡처 탭 두 개를 닫았습니다. CLI `recover-session`은 Flow host 쿠키 없이 새 리다이렉트로 OSID를 발급받고 활성 소유자와 41개 미디어 보호 조회를 확인한 뒤 DPAPI에 저장했습니다. 이 HTTP 복구 세션으로 기본 Node SDK 발급과 고양이 춤 영상 생성 1회, 서버 완료 상태 3, 정확한 MP4 다운로드를 완료했습니다. 저널 ac48516e-ea4f-44bc-8130-777ec26cb08e는 downloaded이며 재전송은 없습니다. 720p 요청 원본 1,514,421바이트를 854×480·8초·24fps·192프레임의 436,496바이트 MP4로 변환하고 전체 디코드를 통과했습니다. 별도 메모리에서 Flow host 쿠키를 누락시킨 startup 시험도 한 번의 자동 복구 후 42개 보호 조회를 통과했습니다. 최종 테스트 153/153 및 JS 구문 검사 21개가 통과했습니다.

Google 세션 최초 부트스트랩용 `src/bootstrap-google-receive.mjs`는 RSA-OAEP+AES-GCM 전달을 검증하고 accounts.google.com의 Google 인증 자료만 지정 DPAPI broker에 저장합니다. 재사용 비밀값과 계정 식별자는 평문 명령행·로그·Git에 남기지 않습니다. Google의 기본 계정 인증 자체가 거부되면 정상 재인증이 필요합니다.

보호 저장은 두 레코드에 순서대로 수행하며 원자적 트랜잭션은 아닙니다. 네트워크 검증 중 원본 레코드 변경은 비교 검사로 거부합니다. 두 번째 broker 저장만 실패하면 FLOW_SSO_RECOVERY_PARTIAL_COMMIT와 flowStored=true·googleAuthStored=false를 보고하고 검증된 새 Flow 세션을 유지합니다. 동시 변경·첫 저장 실패·부분 저장 실패 테스트가 포함됩니다.
