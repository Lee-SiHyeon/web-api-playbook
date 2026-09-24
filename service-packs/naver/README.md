# Naver Blog API-only

네이버 블로그의 **HTTP 로그인, 로그인 정보·쿠키 저장과 재사용, 통계 조회, 게시글 읽기·발행·수정, 이미지·영상 업로드**를 모은 개인용 클라이언트입니다. 현재 코드는 이 pack의 `apps/naver-blog-api/`에 있으며, 아래 명령은 모두 **`service-packs/naver` 폴더의 PowerShell**에서 실행합니다.

현재 로그인·소유자 확인 대상은 `aicandoanything`입니다. 여러 계정에 바로 적용하는 범용 SDK는 아니며, `NAVER_BLOG_ID` 하나를 바꾼다고 로그인·발행 대상까지 전환되지는 않습니다.

## 사용 순서

1. [설치](#1-설치)
2. [처음 로그인 또는 기존 세션 재사용](#2-로그인과-세션-재사용)
3. [게시글·초안 조회](#3-게시글과-초안-조회) / [통계 조회](#4-통계-조회)
4. [이미지·영상 업로드](#5-이미지와-영상-업로드)
5. [글 발행·수정](#6-글-발행과-수정)
6. [실패 시 복구](#8-오류와-복구)

## 1. 설치

| 준비물 | 필요한 작업 |
|---|---|
| Windows, Node.js 24 이상, npm, Git | 기본 실행. 보호 저장소는 Windows DPAPI CurrentUser 사용 |
| PowerShell 7 (`pwsh`) | 아래 예제와 최초 비밀번호 입력 도우미. 도우미는 .NET의 `ArgumentList`를 사용하므로 Windows PowerShell 5.1 대신 7 사용 |
| Windows PowerShell (`powershell.exe`) | Node에서 호출하는 DPAPI 저장소 도우미에 필요 |
| Playwright Chromium | 최종 네이티브 미리보기와 신규 발행용 SDK 입력 준비 시 필요 |
| 별도 인증된 Codex CLI | 현재 로그인 흐름의 이미지 확인 공급자가 호출될 때 필요. 정상 세션 재사용에서는 호출하지 않음 |
| Jev 공급자 인증 | 글 품질 리뷰 단계에 필요. 네이버 로그인과 별도 |

```powershell
# xhr-to-api-only 저장소 루트에서 시작
Set-Location service-packs/naver
npm ci --ignore-scripts
```

통합 저장소 설치는 [루트 README](../../README.md)를 따릅니다. 원본 단독 저장소를 추가 clone할 필요는 없습니다. 이미 이 pack 폴더라면 이동 명령을 생략합니다. 글 발행·네이티브 미리보기도 사용할 때는 브라우저 런타임을 한 번 설치합니다.

```powershell
npm run setup:browser -w @affiliate-content-operations/naver-blog-api
```

이후 예제에서 사용할 **로컬 결과 폴더**를 만듭니다. 인증값이 아닌 결과·저널용 폴더이며 Git에서 제외됩니다.

```powershell
$Repo = (Get-Location).Path
$BlogId = 'aicandoanything'
$Run = Join-Path $Repo ('.runtime\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $Run | Out-Null
$Journal = Join-Path $Run 'publisher-journal'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
```

`publisher:*` 런처는 자식 프로세스의 작업 폴더를 `apps/naver-blog-api`로 바꿉니다. 따라서 **`--file`, `--metadata`, `--job`, `--journal`, `--output`에는 절대경로**를 전달하세요. 문서 안의 이미지·증거 파일 경로는 해당 작업 문서 폴더를 기준으로 합니다.

## 2. 로그인과 세션 재사용

### 이 PC에 이미 로그인 정보를 저장한 경우

```powershell
npm run login:auto
npm run session:health
npm run publisher:api -- --command=session-status "--blog-id=$BlogId"
```

`login:auto`는 저장된 세션으로 보호된 관리 페이지를 먼저 확인합니다. 유효하면 로그인 POST 없이 재사용하고, 로그인 만료가 확인되면 저장된 ID·비밀번호로 HTTP 로그인을 수행해 검증된 세션을 다시 저장합니다. 네트워크 오류·403·다른 소유자 응답은 만료로 간주하지 않습니다.

| 명령 | 확인할 결과 |
|---|---|
| `login:auto` | `protectedOwnerRead: true`. 재사용이면 `sessionReused: true`, `loginPostCount: 0` |
| `session:health` | `protectedOwnerRead: true`, `actorMatched: true`, `adminShell: true` |
| `publisher:api … session-status` | 결과의 `protectedOwnerVerified: true` |

`session:health`는 읽기 확인이며 새 비밀번호 로그인을 시작하지 않습니다. 저장 유무만 보려면 다음 명령을 사용합니다. **저장 파일 존재와 현재 로그인 유효성은 다른 결과입니다.**

```powershell
npm run login:http -- --status
npm run credentials -- status naver-login-identity
npm run credentials -- status naver-blog-session
```

### 처음 사용하는 PC / ID·비밀번호를 다시 입력할 때

```powershell
pwsh -NoProfile -File .\apps\naver-blog-api\scripts\naver-login-prompt.ps1 -RememberIdentity -RememberSession
npm run session:health
```

도우미가 계정 ID와 숨김 비밀번호 입력을 받습니다. 보호된 소유자 확인이 성공한 경우에만 `-RememberIdentity`가 로그인 정보를, `-RememberSession`이 세션을 저장합니다. 계정 ID는 블로그 주소와 다를 수 있습니다. 도우미 출력뿐 아니라 후속 `session:health` 결과도 확인하세요.

이후에는 `npm run login:auto`를 사용합니다. 다른 PC나 다른 Windows 사용자로 clone한 경우 인증을 다시 준비해야 합니다.

### 자동화에서 사용하는 옵션

```powershell
# 저장 세션 확인 → 필요하면 로그인 → 검증된 세션 저장
node .\apps\naver-blog-api\scripts\naver-login-cli.mjs --reuse-session --remember-session --output "$Run\login.json"

# 세션 재사용 없이 저장된 ID·비밀번호로 HTTP 로그인 시도
npm run login:http -- --remember-session
```

로그인 CLI의 출력 경로는 **`--output 경로`** 형식입니다. 발행 CLI의 **`--output=경로`** 형식과 다릅니다. `--output` 파일은 이미 존재하면 실행 전에 거절합니다.

`--identity-stdin`은 UTF-8 JSON `{ "username": "…", "password": "…" }`을 신뢰하는 자격증명 공급자에서 직접 파이프로 받을 때 사용합니다. 비밀번호가 포함된 명령이나 평문 파일로 입력하지 마세요. `--remember-identity`와 `--remember-session`은 각각 저장 여부를 결정합니다. `--identity-stdin`과 `--reuse-session`은 함께 사용할 수 없습니다.

## 3. 게시글과 초안 조회

조회할 **기존 게시글 번호**를 입력합니다. 이 절의 명령은 글을 수정하지 않습니다.

```powershell
$LogNo = Read-Host '조회할 게시글 번호(logNo)'

npm run publisher:api -- --command=read-post "--blog-id=$BlogId" "--log-no=$LogNo" "--output=$Run\public.json"
npm run publisher:api -- --command=inspect-editor "--blog-id=$BlogId" "--log-no=$LogNo" "--output=$Run\owner.json"
npm run publisher:api -- --command=audit-post "--blog-id=$BlogId" "--log-no=$LogNo" "--output=$Run\audit.json"
npm run publisher:api -- --command=list-drafts "--blog-id=$BlogId" "--output=$Run\drafts.json"
```

| 명령 | 결과 |
|---|---|
| `read-post` | 공개 글의 제목, 순서가 보존된 본문, 이미지·영상·링크 등. `smartEditorBodyPresent` 확인 |
| `inspect-editor` | 소유자 편집 모델에서 추출한 문서와 지문. `protectedOwnerVerified` 확인 |
| `audit-post` | 공개 본문·미디어 검사. `passed`, 실패 항목 확인 |
| `list-drafts` | 현재 계정의 저장된 초안 목록 |
| `read-draft --log-no=…` | 목록에서 확인한 기존 초안의 문서 |
| `inspect-styles --log-no=…` | 해당 글의 실제 문단·텍스트 스타일 |

`--output`이 있으면 파일에는 결과 객체, 터미널에는 요약이 나옵니다. 런처 상태 JSON과 명령 결과 JSON이 각각 출력될 수 있으므로 stdout 전체를 단일 JSON으로 파싱하지 말고 결과 파일을 읽으세요.

```powershell
$Owner = Get-Content -Raw -Encoding utf8 "$Run\owner.json" | ConvertFrom-Json
$Owner.protectedOwnerVerified
```

공개 읽기 자체는 인증 없이 가능하지만, 위 DPAPI 런처는 시작 시 저장 세션을 요구합니다. 공개 읽기만 독립 실행하려면:

```powershell
node .\apps\naver-blog-api\scripts\api\publisher-cli.mjs --command=read-post "--blog-id=$BlogId" "--log-no=$LogNo" "--output=$Run\public-anonymous.json"
```

## 4. 통계 조회

관측 계약과 **각 계약이 요구하는 쿼리 필드**를 먼저 확인합니다.

```powershell
npm run operations
```

조회 입력은 stdin JSON입니다. `operation + query` 또는 `url` 중 하나를 받습니다. 다음 예제는 `visit/cv`의 필드 목록을 읽어 값을 입력받습니다. 기간·필터 값은 현재 관리 화면에서 사용하는 값 또는 직접 확인한 요청값을 입력하세요. 카탈로그는 필드 이름을 제공하며, 모든 필터의 값 목록을 제공하지는 않습니다.

```powershell
$env:NAVER_BLOG_ID = $BlogId
$Operations = npm run --silent operations | ConvertFrom-Json
$Operation = 'visit/cv'
$Query = @{}
foreach ($Field in $Operations.$Operation.queryFields) {
    $Query[$Field] = Read-Host "통계 요청값 $Field"
}
$StatRequest = @{ operation = $Operation; query = $Query } | ConvertTo-Json -Depth 5 -Compress
$StatRequest | npm run --silent stats
$StatRequest | npm run --silent stats -- --data
```

첫 호출은 HTTP 상태·응답 길이·해시·구조를, `--data`를 붙인 호출은 실제 통계 JSON을 반환합니다. **위 두 줄은 각각 별도 GET 요청**입니다. 필요한 출력 방식 하나를 선택해 실행하면 됩니다.

반복 실행할 요청은 인증값을 제외한 `operation/query` JSON으로 `.runtime`에 저장해 사용할 수 있습니다.

```powershell
[IO.File]::WriteAllText("$Run\stats-request.json", $StatRequest, [Text.UTF8Encoding]::new($false))
Get-Content -Raw -Encoding utf8 "$Run\stats-request.json" | npm run --silent stats -- --data
```

현재 클라이언트는 저장된 DPAPI 세션을 기본으로 읽습니다. `NAVER_COOKIE`가 설정되어 있으면 통계 경로에서 우선 사용·저장하므로 보통은 설정하지 않습니다. `NAVER_BLOG_ID`는 통계 Referer에 쓰이며 기본값은 과거 통계 대상 `4053103`입니다. 실제 조회 계정은 인증 세션에 의해 정해집니다.

계약에 없는 경로, 누락·추가·중복 쿼리 필드, 숫자형 쿼리 값, `<관측값>` 같은 미완성 값은 거절합니다. 모든 쿼리 값은 문자열이어야 합니다. 계약 목록은 [current-contracts.json](apps/naver-blog-api/references/current-contracts.json)에 있습니다.

## 5. 이미지와 영상 업로드

업로드는 서버에 파일을 만드는 작업이며 글 발행과 별개입니다. **업로드부터 발행까지 동일한 `$Journal`을 유지**합니다. 각 결과 파일은 새 경로를 사용합니다.

### PNG 이미지

```powershell
$Image = (Resolve-Path (Read-Host '업로드할 PNG 절대경로')).Path
npm run publisher:api -- --command=upload-image "--blog-id=$BlogId" "--file=$Image" "--journal=$Journal" "--output=$Run\image-upload.json"
```

지원 입력: PNG, 최대 10 MiB, 각 변 최대 4096 px, 파일명은 영문·숫자·`_`·`-`와 소문자 `.png`입니다. JPEG를 이름만 바꿔 넣으면 안 됩니다. 결과의 `readbackVerified`, SHA-256, 크기·가로·세로를 확인합니다.

본문 이미지 블록에는 로컬 `file`, `sha256`, `publishedUrl`, **반환된 전체 `uploadReceipt`**, 용도와 권리 근거를 연결합니다. 이미지를 다시 다운로드해 원본 바이트와 일치해야 발행에 사용할 수 있습니다.

### MP4 / WebM 영상

```powershell
$Video = (Resolve-Path (Read-Host '업로드할 MP4 또는 WebM 절대경로')).Path
$VideoMeta = @{ title = '직접 실행한 데모'; description = '실행 과정'; tags = @('AI'); ai = $false }
[IO.File]::WriteAllText("$Run\video-meta.json", ($VideoMeta | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
npm run publisher:api -- --command=upload-video "--blog-id=$BlogId" "--file=$Video" "--metadata=$Run\video-meta.json" "--journal=$Journal" "--output=$Run\video-upload.json"
```

지원 입력: MP4/WebM, 최대 256 MiB, 5 MiB 청크. 파일명은 영문·숫자·`_`·`-`와 소문자 확장자입니다. `title`은 1–40자, `description`은 최대 1000자, 태그는 최대 10개·각 30자입니다. `ai`는 **해당 영상의 실제 제작 방식**에 맞춥니다.

결과의 `fileTransferred`, `processingReady`, `sourceHashVerified`, `readbackVerified`를 확인하고, 전체 영수증과 `videoId`를 영상 블록에 연결합니다. 인코딩 대기나 응답 유실이면 새 업로드 대신 원본 파일·저널로 대사합니다.

```powershell
npm run publisher:api -- --command=reconcile-video "--blog-id=$BlogId" "--file=$Video" "--journal=$Journal" "--output=$Run\video-reconcile.json"
```

미완료 업로드를 대사하려면 원래 실행의 메모리 업로드 세션 키가 필요할 수 있습니다. `VIDEO_RUNTIME_SESSION_REQUIRED`이면 현재 구현은 재시작 후 자동 복구를 보장하지 않습니다. 키를 명령 인자에 넣거나 새 저널로 다시 업로드하지 마세요.

이미지·영상 바로 다음 문단에 `presentation: "caption"`을 지정하면 네이티브 캡션으로 변환됩니다. [블록·캡션 예제와 발행 순서](docs/publishing-usage.md)를 참고하세요.

## 6. 글 발행과 수정

**제목과 HTML만 넘기는 CLI가 아닙니다.** 최종 문서, 근거 파일, 주장 목록, 미디어 영수증, 리뷰, 대상·공개 범위를 묶은 작업 폴더가 입력입니다. 초안 생성·사실 조사·리뷰를 수행한 산출물이 있어야 발행 단계로 진행할 수 있습니다.

| 작업 | 진입점 | 주요 입력 | 결과 |
|---|---|---|---|
| 새 AI 글 | `workflows/adaptive-publish/run.mjs` | `document.json`, `claim-ledger.json`, `bundle.json`, `job.json`, 출처·리뷰 | `create-result.json`, 공개/소유자 readback, `final-verification.json` |
| 기존 글 수정 | `npm run republish -- <단계>` | `republish-manifest.json`, 기존 글 번호, 수정 작업 폴더·원래 저널 | 수정 영수증, readback, `final-verification.json` |
| 준비된 수정 job 직접 실행 | `publisher:api --command=prepare-update/update` | dry-run job → 사전확인 → 승인 job | 동일 저널의 수정·대사 결과 |
| 기존 초안 저장 | `publisher:api --command=prepare-draft/save-draft` | 기존 초안 `logNo`를 포함한 전체 문서 | 초안 저장·대사 결과 |

**[발행 사용법: 입력 파일, 신규 글 단계별 명령, 기존 글 수정, 캡션, 응답 유실 복구](docs/publishing-usage.md)**

이미 준비된 신규 글 작업 폴더의 처음 두 단계는 다음과 같습니다. `$Article`은 빈 폴더가 아니라 해당 파일들이 있는 절대경로입니다.

```powershell
$Article = (Resolve-Path (Read-Host '준비된 신규 글 작업 폴더')).Path
$Workflow = Join-Path $Repo 'apps\naver-blog-api\workflows\adaptive-publish\run.mjs'
$PreviewPost = Read-Host '읽기 전용 미리보기에 사용할 내 기존 글 번호'
node $Workflow gates "--run=$Article"
node $Workflow lint "--run=$Article" "--container=$PreviewPost"
```

`gates`는 실패 항목 목록을 출력합니다. 종료 코드만 보지 말고 항목이 비었는지 확인하세요. 최종 단계는 별도 문서에 있는 리뷰 → 미리보기 → 준비 → 승인 기록 → **create 1회** → readback → verify 순서입니다. 리뷰 결과를 실제로 생성하지 않은 상태에서 pass 값을 채워 넣어서는 안 됩니다.

## 7. 어디까지 브라우저 없이 동작하나

| 단계 | 현재 구현 |
|---|---|
| 저장 세션 확인·HTTP 비밀번호 로그인·통계·소유자 읽기 | 브라우저 엔진 없는 HTTP 경로 |
| PNG·MP4/WebM 업로드와 대사 | HTTP. 미완료 영상 대사에는 원래 실행 키가 필요할 수 있음 |
| 문서 컴파일·`lint-model` | HTTP |
| 최종 PC/모바일 네이티브 미리보기 | Playwright Chromium 필요 |
| 신규 글의 fresh SDK 문서·nCaptcha 입력 | 짧은 헤드리스 Chromium 단계 필요 |
| 실제 글 쓰기 요청 | 준비된 입력으로 독립 HTTP 실행 |

로그인 성공과 신규 글 발행에 필요한 SDK 입력 확보는 별도입니다. SDK 입력을 얻지 못하면 create 전에 중단합니다. 저장된 로그인 쿠키를 재사용한다고 발행용 일회성 토큰까지 재사용하는 것은 아닙니다.

## 8. 오류와 복구

| 오류/상태 | 다음 동작 |
|---|---|
| `LOGIN_IDENTITY_MISSING` | 최초 입력 도우미로 정상 로그인 후 ID·세션 저장 |
| `AUTH_MISSING`, `NAVER_AUTH_COOKIES_MISSING` | 같은 Windows 사용자에서 `login:auto` → `session:health` |
| `LOGIN_SESSION_OWNER_MISMATCH`, `AUTH_SCOPE_AMBIGUOUS` | 대상·인증 계정 확인. 자동 재로그인 반복으로 해결하지 않음 |
| `ACCOUNT_PROTECTION_REQUIRED` | 네이버에서 계정 복구를 완료한 다음에만 아래 복구 확인 명령 실행 |
| `ADDITIONAL_VERIFICATION_REQUIRED`, `LOGIN_IMAGE_*` | 결과의 추가 인증/이미지 공급자 상태 확인 |
| `CREDENTIAL_STORE_*`, `WINDOWS_SESSION_REQUIRED` | Windows PowerShell에서 실행 중인지, 같은 Windows 사용자·프로필인지 확인 |
| `COMMAND_REQUIRED`, `INPUT`, `UNKNOWN_OPTION` | 발행은 `--command=값`; 로그인 `--output 경로`와 구분. 발행 CLI에 `health` 명령은 없음 |
| `ENOENT`, `DIRECT_LAUNCH_FAILED` | 저장 세션·입력 파일 존재 및 절대경로 확인 |
| 출력 파일 충돌, `LOGIN_OUTPUT_RESERVATION_FAILED` | 기존 영수증 보존. 읽기 명령에는 새로운 출력 경로 사용 |
| `PREFLIGHT_EXPIRED`, 지문 불일치 | 바뀐 문서 기준 리뷰·사전확인 갱신 |
| `WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED`, `*_OUTCOME_UNKNOWN` | **원래 job·저널로 reconcile**. 파일명을 바꿔 create/update 재전송 금지 |
| `VIDEO_RUNTIME_SESSION_REQUIRED` | 미완료 업로드의 원래 실행 키 필요. 자동 재시작 복구 미지원 경계 |
| 통계 `UNOBSERVED`, `INPUT`, `MIME` | 계약 목록·문자열 쿼리·JSON 응답 여부 확인. 로그인 HTML은 성공이 아님 |

계정 복구를 실제로 완료한 경우에만 로컬 차단 기록을 해제합니다. 이 명령 자체는 네이버 계정 복구를 수행하지 않습니다.

```powershell
npm run login:http -- --account-recovered --status
npm run login:auto
```

발행 CLI는 실패 시 보통 종료 코드 2, 통계 CLI는 1을 반환합니다. 성공 판정은 종료 코드와 결과의 소유자·리드백·품질 확인 항목을 함께 사용합니다. PowerShell의 `$LASTEXITCODE`를 확인하고 다음 쓰기 단계를 무조건 연속 실행하지 마세요.

## 9. 저장 위치와 프로젝트 구조

인증값은 `%USERPROFILE%\.config\affiliate-content-operations\credentials\` 아래 DPAPI로 저장합니다. 주요 이름은 `naver-login-identity`, `naver-blog-session`, `naver-login-control`입니다. 기존 작업 환경과 같은 이름을 사용하므로 **같은 PC·Windows 사용자라면 기존 저장소를 재사용**합니다. Git에는 저장·갱신 코드만 있고 실제 인증값은 없습니다.

```text
apps/naver-blog-api/
  scripts/naver-login-*.mjs     로그인·ID 저장·계정 보호
  scripts/session-*.mjs         세션 저장·보호된 HTTP 읽기
  scripts/publisher-direct.mjs  DPAPI → 발행 자식 프로세스
  scripts/api/                 게시글·미디어·저널
  scripts/hybrid/              네이티브 미리보기·SDK 입력 준비
  scripts/gates/               문서·근거·리뷰·대상 검증
  workflows/adaptive-publish/  신규 AI 글 단계 실행
  workflows/republish/         기존 글 수정 단계 실행
  references/                 관측 계약
  tools/discovery/            필요할 때 사용하는 탐색 도구
packages/contracts/           공유 타입·지문·계약
docs/                         사용법과 날짜별 구현 기록
.runtime/                     사용자별 작업 파일·영수증·저널 (Git 제외)
```

루트의 옛 `scripts/`, `references/`, `discovery/`는 통계 전용 시절의 자료입니다. **일반 사용은 이 README의 루트 npm 명령을 사용**하세요. 제휴상품 전체 수집 workflow에는 별도 `affiliate-api-hub`가, 모델 비교 workflow에는 별도 모델 CLI·FFmpeg가 필요합니다. 네이버 HTTP 조회·로그인·업로드의 필수 요소는 아닙니다.

## 더 읽기

- [발행·수정 실사용 가이드](docs/publishing-usage.md)
- [통합본 출처와 포함 범위](docs/current-implementation.md)
- [동적 AI 글 품질 기준](docs/adaptive-blog-publishing.md) — 설계와 과거 실행 기록
- [로그인 HTTP 관측 기록](apps/naver-blog-api/docs/naver-login-xhr-2026-09-23.md)
- [현재 편집기 API 계약](apps/naver-blog-api/references/editor-api-contracts.json)
- [통계 전용 시절 README](docs/history-before-login-20260924.md)
- [원본 반입 기록](IMPORT-2026-09-24.json)

문서 기준: 2026-09-24의 저장소 구현. 날짜가 붙은 과거 성공 기록은 현재 세션이나 모든 API의 성공을 보장하지 않습니다. 이 사용법 정리에서는 로그인·업로드·발행 또는 테스트를 새로 실행하지 않았습니다.
