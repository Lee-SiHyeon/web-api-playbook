# Naver Cafe HTTP client

## SmartEditor ONE 미디어 미러 (2026-10-13)

`lib/media-upload.mjs`는 현재 카페 소유자 편집기 응답의 `cafepc001` 인증 입력과 `service_config`를 확인한 뒤, 블로그의 검증된 PNG 업로드 전송·XML 파서·바이트 readback을 재사용합니다. 업로드 세션은 `platform.editor.naver.com`에서 받고 사진은 `cafe.upphoto.naver.com`으로 한 번 전송합니다. 인증 쿠키를 사진/CDN에 전달하지 않습니다. CDN의 최종 이미지는 `cafeptthumb-phinf.pstatic.net`에서 다시 내려받아 원본 해시와 대조합니다. 불확실한 업로드는 journal로 차단하며 재전송하지 않습니다.

카페 쓰기 payload에는 SmartEditor `contentJson`을 사용합니다. 이미지의 `represent:true`가 대표 이미지 선택이며 별도 썸네일 URL 필드는 쓰지 않습니다. 이미지 캡션, `quotation` 제목, `table/tableRow/tableCell`, 텍스트의 `urlLink` 객체와 이미지의 URL 문자열 `link`를 지원합니다. 광고 고지는 첫 텍스트 컴포넌트에 남기며 파트너 배너/고지 이미지는 대표 이미지에서 제외합니다. 카페 서버는 표 셀의 `textAlign`을 저장하지 않으므로 해당 필드를 보내지 않습니다.

`post-inspect`는 지정 글의 현재 소유자·게시판·태그·공개 옵션을 읽습니다. `post-update`는 게시판·공개 옵션·머리글을 보존하고, 동일 문서의 기존 update journal을 먼저 대조합니다. 일반 쓰기는 `agent:false`인 새 HTTPS 연결을 사용합니다. readback은 전체 문서 fingerprint·공개 본문·이미지 경로·기존 설정을 확인하고, 대표 이미지는 `list.articleList[].representImage`로 검증합니다. 상세 글 읽기 API는 이 썸네일 필드를 반환하지 않습니다.

`mirror-naver-cafe.mjs`의 생성·수정은 미디어 변환기를 사용하고 dry-run은 업로드 없이 미디어 계획을 만듭니다. 원본 영상은 별도 video session-url/token 계약이 있으므로, 미러에서는 검증된 영상 썸네일을 PNG로 변환해 업로드하고 블로그 영상으로 링크합니다. 기존 글의 소급 수정 기록·첫 두 글의 diff·DPAPI 원시 계약 캡처는 Git 밖 `C:\Users\User\Documents\Codex\2026-10-13\naver-cafe-media-backfill`에 있습니다. 소유자 글 업데이트를 조회로 재조정할 때는 같은 journal을 유지합니다.

네이버 카페 웹앱에서 관측한 요청을 Node의 `fetch`와 Windows DPAPI 저장 세션으로 실행합니다. 세렌아카데미(`serenacademmy`, cafe ID `31714934`)의 읽기와 생활이득AI연구소(`lifehackailab`, cafe ID `31796283`)의 읽기·관리 작업을 제공합니다. 계약 관측에만 Chrome CDP를 사용했고, 일반 명령은 브라우저 없이 직접 HTTP로 실행합니다.

## 가능한 작업

| 명령 | 결과 |
| --- | --- |
| `status` | 보호 저장소의 세션 존재 여부와 재인증 필요 상태; 실제 인증 확인은 `member` |
| `member` | 현재 계정의 카페 가입 여부·회원 등급 |
| `menus` | 게시판과 메뉴 ID 목록 |
| `list` | 최신 글 또는 지정 게시판의 글 목록, 페이지당 50개 |
| `search` | 제목·본문 검색, 페이지당 20개 |
| `article` | 글 제목·본문 텍스트·날짜·조회수·댓글 수·첨부파일 메타데이터 |
| `comments` | 댓글 ID·상위 댓글 ID·닉네임·내용·날짜 |
| `scripts/download.mjs` | 조회 권한이 확인된 첨부 PDF를 HTTP로 저장 |

생활이득AI연구소 관리 명령은 아래 별도 절에 있습니다. 댓글 작성·삭제와 가입 신청은 구현하지 않았습니다. 댓글의 다음 페이지 요청은 아직 관측하지 않았으므로 `hasNext=true`이면 전체 수집 완료로 처리하면 안 됩니다. 글 본문은 스크립트와 태그를 제거한 텍스트로 반환하며 원본 HTML과 미디어 전체를 복제하는 내보내기는 아닙니다.

## 준비

- Windows, Node.js **24 이상**. 추가 npm 패키지 설치는 필요 없습니다.
- 이 저장소의 `apps/naver-blog-api/scripts/secure-credential-store.mjs`와 같은 폴더의 `secure-credential-store.ps1`을 함께 둡니다. 해당 모듈의 Windows DPAPI 저장소를 사용합니다.
- 기존 로그인 작업에서 정상적으로 저장한 `naver-blog-session`이 최초 연결에 필요합니다. 다른 컴퓨터나 다른 Windows 사용자로 복사한 DPAPI 파일은 사용할 수 없습니다.
- 카페별 세션은 별도의 DPAPI 항목으로 저장합니다. 기본 세렌아카데미는 기존 `naver-cafe-session` 항목을 유지하고, 추가 카페는 Cafe ID와 slug로 범위를 나눈 항목을 사용합니다.
- 저장된 카페 세션이 있으면 아래 조회 명령부터 실행하면 됩니다.

```powershell
cd C:\Users\User\Documents\GitHub\affiliate-content-operations\apps\naver-cafe-api
node scripts/cafe.mjs status
node scripts/cafe.mjs member
```

## 최초 연결 또는 기존 네이버 세션에서 다시 연결

브라우저에서 확인한 계정과 같은 계정인지 판별할 SHA-256 값을 지정합니다. 이 값은 사용자 비밀번호나 인증 토큰이 아니라 Cafe identity 응답의 `userId`를 SHA-256한 비교값입니다. 계정을 확인하지 않고 실행 결과에서 처음 나온 값을 그대로 신뢰하지 마세요.

```powershell
$actorHash = '브라우저에서_확인한_64자리_SHA256'
node scripts/cafe.mjs bootstrap-shared --expected-actor-hash $actorHash
node scripts/cafe.mjs member
```

### 기존에 검증된 카페 계정 핀으로 제한 갱신

카페 전용 저장 세션이 `REAUTH_REQUIRED` 또는 `AUTH_MISSING`을 반환하면 `renew-shared`가 현재 네이버 블로그 DPAPI 세션을 사용해 기존 카페 번들에 저장된 검증 actor hash와 계정이 같은지, 지정 카페의 회원인지 확인합니다. 두 확인이 모두 통과해야 해당 카페 ID/slug의 DPAPI 세션만 갱신하며, 기존 핀이 없거나 일치하지 않으면 저장하지 않습니다. 현재 네이버 UI 로그인을 수행하거나 actor hash를 출력하지 않습니다.

```powershell
node scripts/cafe.mjs renew-shared --cafe-id 31796283 --cafe-slug lifehackailab
node scripts/cafe.mjs status --cafe-id 31796283 --cafe-slug lifehackailab
node scripts/cafe.mjs member --cafe-id 31796283 --cafe-slug lifehackailab
```

`bootstrap-shared`는 기존 DPAPI의 `NID_AUT`·`NID_SES`를 메모리로 읽고, Cafe identity와 가입 조회를 HTTP로 실행합니다. 계정 해시 일치 및 `cafeMember=true`를 확인한 뒤 별도 **`naver-cafe-session`** 슬롯에 DPAPI로 저장합니다. 원래 블로그 슬롯은 변경하지 않습니다. 이후 프로세스는 카페 슬롯을 사용하며, 새 클라이언트를 만들 때 현재 로그인 계정과 가입 여부를 다시 확인합니다.

`mirror-naver-cafe.mjs`는 읽기 전용 목록 사전확인이 `REAUTH_REQUIRED` 또는 `AUTH_MISSING`으로 끝난 경우에만 `renew-shared`를 한 번 실행합니다. 갱신이 검증되면 전체 목록 검사를 처음부터 다시 시작합니다. `403`/권한 거부, transport, timeout, 글 조회 또는 쓰기 오류에서는 자동 갱신하지 않습니다. 기존 actor pin이 없거나 현재 블로그 세션의 계정 또는 대상 Cafe 회원 여부가 확인되지 않으면 중단하며, 다른 Cafe 범위의 DPAPI 슬롯은 갱신하지 않습니다.

비밀번호 로그인·OTP·CAPTCHA·만료 후 재로그인을 새로 구현한 것은 아닙니다. 정상 응답에서 관측한 인증 쿠키 회전은 보호 저장소에 반영하지만, 실제 만료 후 자동 복구는 확인하지 않았습니다. 인증이 거부되면 기존 네이버 로그인 경로로 정상 세션을 갱신한 뒤 위 연결을 다시 실행합니다.

HTTP 401 또는 명시적인 인증 쿠키 삭제를 받으면 현재 클라이언트를 비활성화하고 보호 저장소에 재인증 필요 상태를 기록합니다. 403만으로 전체 세션을 폐기하지는 않습니다. 200 JSON으로 확인되지 않은 응답의 새 인증값은 채택하지 않으며, 오류·리다이렉트 응답의 명시적 쿠키 삭제는 반영합니다.

## 사용 예시

### 게시판, 최신 글, 게시판별 글

```powershell
node scripts/cafe.mjs menus
node scripts/cafe.mjs list --page 1
node scripts/cafe.mjs list --page 2
node scripts/cafe.mjs list --menu 1 --page 1
```

메뉴 ID는 `menus`의 `id`에서 고릅니다. `list.hasNext`와 실제 반환 건수를 확인하며 다음 `--page`를 요청합니다. 전체 카페를 자동 순회하는 명령은 포함하지 않았습니다.

### 검색, 글, 댓글

```powershell
node scripts/cafe.mjs search --query '소싱' --page 1
node scripts/cafe.mjs search --query '소싱' --menu 1 --page 1
node scripts/cafe.mjs article --id 21
node scripts/cafe.mjs comments --id 21
```

명령은 JSON을 표준 출력으로, 안전한 오류 코드만 표준 오류로 출력합니다. 저장하려면 다음처럼 사용합니다.

```powershell
New-Item -ItemType Directory -Force runtime | Out-Null
node scripts/cafe.mjs article --id 21 | Set-Content -Encoding utf8 runtime\article-21.json
```

### 첨부 PDF

```powershell
node scripts/download.mjs --id 21 --index 0 --out-dir runtime\downloads --receipt runtime\download-receipt.json
```

`--index`는 `article.attachments[].index`입니다. 최신 글 응답에서 다운로드 주소를 가져오고 권한을 확인합니다. 다운로드 주소를 소스에 고정하거나 쿠키를 URL·명령행에 넣지 않습니다. 최대 64 MiB이며 PDF MIME, `%PDF-` 헤더, EOF, 선언된 파일 크기를 확인합니다. 기존 파일을 덮어쓰지 않으므로 재실행 시 새 `--out-dir` 및 영수증 경로를 지정하세요. 다른 첨부 형식은 새 계약 확인 후 추가해야 합니다.

### Node에서 사용

```javascript
import { createStoredCafeClient } from './lib/client.mjs';
import { downloadAttachment } from './lib/download.mjs';

const cafe = await createStoredCafeClient();
const article = await cafe.article({ articleId: '21' });
const comments = await cafe.comments({ articleId: '21' });
const found = await cafe.search({ query: '소싱', page: 1 });
const saved = await downloadAttachment(cafe, {
  articleId: '21', index: 0, outDir: 'runtime/downloads-new',
});
```

## 요청과 인증 범위

- 읽기 계약은 `apis.cafe.naver.com`, `article.cafe.naver.com`, `apis.naver.com`의 명시된 경로만 생성합니다.
- 첨부 URL은 글 API가 반환한 `downapi.cafe.naver.com`의 관측된 다운로드 경로만 받습니다. 임의 리다이렉트를 자동으로 따라가지 않습니다.
- 인증 쿠키는 이름·도메인·경로·만료를 확인한 후 메모리에서 HTTP 헤더에 넣습니다. 다른 출처에 전달하지 않습니다.
- 저장 세션, 비밀번호, 원시 HAR, 전체 네트워크 로그를 프로젝트에 저장하지 않습니다. 콘텐츠 결과와 다운로드 파일은 Git에서 제외한 `runtime/`에 둡니다.
- 계정 ID·memberKey·첨부 URL·광고 추적 토큰을 CLI 결과에서 제외합니다. 댓글 닉네임과 내용은 요청한 카페 콘텐츠로 반환합니다.
- 브라우저의 `buid`와 목록·검색의 광고 추적값은 반복 요청에 넣지 않습니다. 실제 생략 가능 여부는 HTTP 실행 영수증에 기록합니다.

## 오류 처리

| 오류 | 처리 |
| --- | --- |
| `AUTH_MISSING`, `AUTH`, `REAUTH_REQUIRED`, `LOGIN_HTML` | 네이버 정상 로그인 상태를 복구한 뒤 `bootstrap-shared` |
| `ACTOR_MISMATCH` | 현재 계정과 확인한 계정이 같은지 확인; 자동으로 다른 계정을 채택하지 않음 |
| `MEMBERSHIP_REQUIRED`, `FORBIDDEN` | 가입 상태·등급·글 읽기 권한 확인 |
| `SCHEMA`, `APPLICATION`, `MIME` | 웹 응답 계약이 변경됐는지 관측 후 수정 |
| `TIMEOUT`, `TRANSPORT` | 읽기 실패로 취급; 성공으로 기록하지 않음 |
| `REDIRECT`, `ATTACHMENT_REDIRECT` | 리다이렉트 목적지를 새로 확인해야 함 |
| `CAFE_DOWNLOAD_TARGET_EXISTS` | 다른 출력 디렉터리 사용 |

HTTP 200만으로 인증 성공을 판정하지 않습니다. Cafe의 로그인된 계정과 가입 여부, 응답 스키마를 함께 확인합니다.

## 근거 파일

- `discovery/observed-contracts-2026-09-26.json`: 브라우저에서 관측한 URL 구조·필드·응답 해시. 인증값은 없습니다.
- `discovery/live-replay-2026-09-26.json`: 브라우저 관측 탭을 닫은 뒤 별도 Node 프로세스에서 실행한 결과와 다운로드 영수증, 검증 범위.
- `tools/capture-read-receipt.mjs`: 별도 Node 프로세스에서 정해진 범위의 실제 글·댓글·목록·검색을 읽고 `runtime/read-*/`에 콘텐츠와 메타데이터 영수증을 만듭니다. 당일 브라우저 본문·댓글 해시와 비교하므로 글이 수정되면 비교 결과가 달라질 수 있습니다.
- `tools/probe-shared-session.mjs`: 최초 전환 때 사용한 저장 세션의 메모리 전용 진단. 일반 사용은 위 CLI를 사용합니다.
- `discovery/observed-write-contracts-lifehackailab-2026-09-27.json`: 생활이득AI연구소 관리자 브라우저에서 관측하고 직접 HTTP로 재현한 쓰기 계약과 실행 범위. 인증값과 본문은 없습니다.

카페의 slug·ID는 CLI 옵션으로 지정합니다. 2026-09-27부터 `생활이득AI연구소`도 별도 DPAPI 세션으로 읽을 수 있으며, 해당 카페의 범위별 직접 HTTP 결과는 `discovery/live-replay-lifehackailab-2026-09-27.json`에 기록했습니다. 다른 카페의 권한·응답·첨부 다운로드·쓰기까지 이 결과로 검증된 것으로 간주하면 안 됩니다.

### 생활이득AI연구소

```powershell
node scripts/cafe.mjs status --cafe-id 31796283 --cafe-slug lifehackailab
node scripts/cafe.mjs member --cafe-id 31796283 --cafe-slug lifehackailab
node scripts/cafe.mjs menus --cafe-id 31796283 --cafe-slug lifehackailab
node scripts/cafe.mjs list --page 1 --cafe-id 31796283 --cafe-slug lifehackailab
node scripts/cafe.mjs article --id 1 --cafe-id 31796283 --cafe-slug lifehackailab
node scripts/cafe.mjs comments --id 1 --cafe-id 31796283 --cafe-slug lifehackailab
```

기본 Cafe는 계속 세렌아카데미입니다. 위 옵션을 명시하면 `생활이득AI연구소`의 세션을 사용합니다.

## 2026-09-26 실제 실행 결과

- Cafe identity와 현재 계정 일치, 가입 상태 `cafeMember=true`, 등급 `신규회원`.
- 카페 슬롯에 DPAPI 저장 후 **다른 Node 프로세스**에서 다시 로드하여 조회 성공.
- 메뉴 27개 중 게시판 18개, 최신 글 1·2페이지 각 50개(페이지 간 중복 없음), 게시판 1의 글 6개.
- `소싱` 검색: 전체 876건 중 첫 페이지 20건 조회.
- 21번 글 본문과 댓글 83개: 브라우저 XHR에서 얻은 본문·댓글 해시와 일치. 댓글 응답의 `hasNext=false`.
- 첨부 `힘찬 전자책 - 소싱편.pdf`: **15,259,748 bytes**, `application/octet-stream`, PDF 헤더·EOF·크기 확인. SHA-256: `8ee88c12275f23886aadf0b74e316a6819272c2ee11d2517e10086de865ef778`.
- 실제 게시·댓글 쓰기 요청 0건. 전체 876건의 본문을 수집한 것은 아닙니다. 카페 인증 만료 후 복구와 댓글 추가 페이지는 미검증입니다.

재사용 상태는 `captured=true`, `client_exists=true`, `remnant_free=true`(반복 실행에 브라우저·광고 추적값 불필요), `credential_propagated=true`, `live_replay=true`입니다. 이 판정은 위 읽기 범위에 한정합니다. 별도 테스트 스위트는 추가하거나 실행하지 않았고, 구문 검사와 실제 HTTP 조회·다운로드로 확인했습니다.

## 2026-09-27 생활이득AI연구소 직접 실행 결과

- Naver Cafe 홈에서 확인한 target은 `lifehackailab` (Cafe ID `31796283`)입니다. 현재 계정의 가입 여부는 `cafeMember=true`, 등급은 `카페매니저`입니다.
- DPAPI 저장 후 새 Node 프로세스에서 보호 세션을 다시 읽어 메뉴 1개, 최신 글 1개, 1번 글, 댓글 0개를 HTTP로 조회했습니다. 조회 요청에서 브라우저를 사용하지 않았습니다.
- 1번 글 제목은 `생활이득AI연구소 카페를 시작합니다.`이며 본문은 184자로 읽혔습니다. 본문 원문은 영수증에 저장하지 않았습니다.
- 기존 `serenacademmy` 카페 세션도 별도 DPAPI 항목으로 복구한 뒤 새 프로세스에서 membership HTTP read가 성공했습니다.
- 위 세 항목은 처음 읽기 연결을 완료한 시점의 상태입니다. 이후 같은 날 관리 쓰기 기능을 추가하고 임시 글과 게시판으로 재현했습니다.

반복 읽기의 실행 경로는 `pure_http`이며 새 카페의 membership, menus, list, article, comments가 모두 live-replay 되었습니다. 공통 Naver Cafe 읽기 계약은 2026-09-26 브라우저 캡처를 재사용했습니다. 인증 만료 후 복구는 계속 미검증입니다.

### 생활이득AI연구소 관리 명령

`scripts/manage.mjs`는 이 카페의 카페매니저 권한과 보호 세션을 매번 확인합니다. 쓰기는 JSON 객체를 표준 입력으로 받습니다. 다른 카페에는 실행되지 않습니다.

```powershell
node scripts/manage.mjs menus
'{"name":"새 게시판"}' | node scripts/manage.mjs board-add
'{"menuId":"1","subject":"제목","text":"본문"}' | node scripts/manage.mjs post-create
'{"articleId":"2","expectedSubject":"제목","subject":"바뀐 제목","text":"바뀐 본문"}' | node scripts/manage.mjs post-update
'{"articleId":"2","expectedSubject":"바뀐 제목"}' | node scripts/manage.mjs post-delete
'{"menuId":"2","expectedName":"새 게시판","name":"바뀐 게시판"}' | node scripts/manage.mjs board-rename
'{"menuId":"2","expectedName":"바뀐 게시판"}' | node scripts/manage.mjs board-delete
```

위 ID는 사용 예시입니다. `menus`와 글 목록에서 실제 ID를 확인한 뒤 넣습니다. 글 작성은 현재 일반 게시판의 일반 텍스트 본문과 선택적 `tags` 배열을 지원합니다. 수정은 본인 소유 글만 허용하며, 본문 교체 시 기존 문서가 텍스트 구성요소만 포함하는지 확인합니다. 일반 게시판의 추가·이름 변경·빈 게시판 삭제를 지원합니다. 이미지·동영상 편집, 댓글 관리, 회원 관리, 공지 지정, 모든 게시판 유형과 상세 설정은 아직 별도 계약과 구현이 필요합니다.

글 제목과 게시판 이름은 중복·대상 일치 여부를 쓰기 전에 확인합니다. 생성·수정·삭제 전에 `runtime/write-journals/`에 기록하고 POST는 한 번만 보냅니다. 읽기로 결과를 확인하지 못하면 `NEEDS_RECONCILIATION`을 반환하므로 같은 쓰기를 즉시 다시 보내지 말고 저널과 실제 카페 상태를 대조해야 합니다.

2026-09-27 실제 확인: 임시 일반 게시판 두 개와 임시 글 두 개를 직접 HTTP로 생성했습니다. 글 수정·삭제, 게시판 이름 변경·삭제도 직접 HTTP로 성공했고 각 결과를 소유자 읽기 또는 관리자 목록으로 확인했습니다. 마지막 목록에는 원래 `자유게시판`(ID 1)과 환영 글(글 ID 1)만 남았습니다. 영수증은 `runtime/write-journals/`에 있으며 요청·응답 계약 요약은 위 `observed-write-contracts` 파일에 있습니다.
