# Naver: 통계 탐색에서 저장 세션·로그인·발행까지

## 1. 많은 캡처가 전체 전환을 뜻하지 않았다

2026-09-13의 통계 탐색 기록에는 문서 72개, iframe 24개에서 GET JSON 계약 55개를 관측했다고 남아 있습니다. 클라이언트는 55개 경로를 구현했지만 독립 Node HTTP 재현을 확인한 범위는 22개였습니다. 추가 33개를 같은 성공 상태로 합치지 않았습니다.

그때의 `4053103` 통계/관리 영역과 나중의 `aicandoanything` 발행 계정 계약은 서로 다른 관측 범위입니다. 한 계정의 readback이 다른 계정/블로그의 소유권을 증명하지 않습니다.

근거: [통계 재개 기록](../service-packs/naver/docs/resume-2026-09-13.md), [통계 시절 README](../service-packs/naver/docs/history-before-login-20260924.md). source commit과 파일 hash는 [서비스 provenance](../provenance/service-packs.json)에 고정했습니다.

**재사용할 방법:** 메뉴/iframe/contract/구현 operation/live replay를 별도 집계합니다. 커서·selector의 의미를 보존하며 전체 루트와 미방문 형제를 유지합니다.

**반례:** 같은 iframe을 여러 번 방문하거나 source 문자열에서 경로를 찾은 것으로 새로운 XHR/live replay 수를 늘리면 잘못된 진척입니다.

## 2. Chrome 연결 실패와 사이트 인증 실패를 분리했다

일부 세션에서는 브라우저 request-header policy 오류, DevTools 연결 timeout, 최종 300초 handoff timeout이 발생했습니다. 당시 탭 attach/실행기 전달이 실패한 것이지, 그 사실만으로 네이버가 쿠키를 거부했다고 볼 수 없었습니다.

이후 허용된 연결로 세션을 별도 Node 프로세스에 전달했을 때 통계 22개가 HTTP 200, application status 및 배열 검증을 통과했습니다. 다음 작업 프로세스가 같은 인증을 자동으로 받는 것은 아니어서 새 전달 실패는 다시 별도 경계로 남겼습니다.

**재사용할 방법:** 브라우저 인벤토리 → target attach → provider 준비 → 실제 child 전달 → protected owner read를 각각 확인합니다. 이미 보호 저장된 세션이 있으면 먼저 HTTP로 확인합니다.

**반례:** 열린 9222 포트, 화면의 로그인 표시, 실행기 exit 0을 current authenticated API proof로 취급하지 않습니다.

## 3. 브라우저 없는 로그인 구현과 발행 SDK를 분리했다

2026-09-24 standalone 스냅샷에는 HTTP 로그인 및 토큰 준비, 저장 identity/session 재사용, 계정 보호 상태, DPAPI credential CLI, 서비스별 cookie vault, 보호된 관리 조회가 포함되어 있습니다. `login:auto`는 저장 세션을 먼저 확인하고 만료가 확인된 경우 로그인 경로를 사용합니다.

근거: [최신 구현 설명](../service-packs/naver/docs/current-implementation.md), [로그인 관측 기록](../service-packs/naver/apps/naver-blog-api/docs/naver-login-xhr-2026-09-23.md), [명령·저장소·제한](../service-packs/naver/README.md).

반면 신규 발행의 fresh 문서/nCaptcha SDK 입력과 최종 네이티브 미리보기는 해당 pack에서 별도 headless Chromium 단계로 남아 있습니다. 로그인 token 준비를 구현했다고 모든 발행 SDK 입력을 engine-free로 만든 것은 아닙니다. 계정 보호/추가 인증을 무조건 복구한다고 보장하지 않습니다.

**재사용할 방법:** 암호 로그인, 로그인 session 저장, cookie rotation, action input 발급, 글 전송, readback을 분리해서 구현/관측 상태를 기록합니다. 사용자가 허용한 cookie/token 보호 저장을 잃지 않으면서 실제 browser 의존 단계를 좁힙니다.

## 4. 발행과 미디어는 별도 영수증이 필요했다

이미지·영상 업로드가 성공해도 글의 component가 누락되거나 캡션이 본문으로 중복될 수 있습니다. 업로드 결과·문서 삽입·공개 readback을 분리하고, POST 결과가 애매하면 같은 저널로 대사합니다. 미완료 영상의 세션 키가 원래 프로세스에만 있을 수 있다는 경계도 보존했습니다.

근거: [발행/수정 단계](../service-packs/naver/docs/publishing-usage.md), [동적 게이트·영상](../service-packs/naver/docs/adaptive-blog-publishing.md). 이 저장소의 generic request CLI는 서비스 고유의 발행 품질/SDK/readback 규칙을 대체하지 않습니다.

## 이 패키징에서 확인한 것

코드·문서·출처를 재검토해 독립 저장소로 묶었습니다. 이번 패키징 자체에서는 네이버 로그인을 시도하거나 글을 다시 발행하지 않았습니다. 과거 라이브 결과는 해당 문서의 날짜/계정/operation 범위이고 현재 인증 상태는 실제 runner로 별도 확인해야 합니다.
