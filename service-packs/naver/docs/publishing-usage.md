# 네이버 발행·수정 사용법

이 문서는 [루트 README](../README.md)의 설치·로그인·미디어 업로드 다음 단계입니다. 모든 명령은 저장소 루트의 PowerShell 7에서 실행하며 경로는 절대경로로 전달합니다. **글의 내용·출처·리뷰가 준비된 작업 폴더를 실행하는 방법**입니다. 저장소에는 개인 글감·계정값·실제 발행 job 묶음이 포함되지 않습니다.

## 1. 실행할 작업을 고르기

| 목적 | 사용 경로 |
|---|---|
| 새 AI 설명·출시·비교 글 | `workflows/adaptive-publish/run.mjs` |
| 기존 글의 전체 문서 수정 | `npm run republish -- <단계>` |
| 이미 완성된 수정 job 실행 | `publisher:api`의 `prepare-update` → authorizer → `update` |
| 기존 저장 초안 갱신 | `prepare-draft` → `save-draft` |

새 글은 `target.type: "create"`, 기존 글은 `target.type: "update"`와 정확한 `logNo`로 구분합니다. 일반 업데이트는 해당 글 형식·대상 계약이 지원하는 범위에서만 동작합니다. 제목만 바꾸어 임의의 글에 적용하는 만능 writer는 아닙니다.

## 2. 신규 AI 글 작업 폴더의 입력

```text
article-run/
  document.json               최종 제목과 전체 blocks
  claim-ledger.json           주장과 근거 연결
  research-snapshot.json     출처·수집 시각·원본 파일 해시
  gate-plan.json             이 글의 독자 목적·적용 품질 조건
  bundle.json                문서·근거·미디어·리뷰를 묶은 bundle
  job.json                   publish:false, dryRun:true인 create job
  editorial-review-raw.json  실제 독립 검토자가 작성한 검토 결과
  reference-sources.json     글쓰기 비교 레퍼런스
  sources/                   출처의 실제 수집 파일
  images/ 또는 media/         로컬 원본 이미지·영상
  publication-journal.jsonl/ 업로드부터 쓰기까지 유지할 저널 디렉터리
```

마지막 경로는 workflow의 실제 기본 이름입니다. 확장자가 `.jsonl`이어도 `WriteJournal`이 사용하는 **디렉터리**입니다. 미디어를 먼저 CLI로 올릴 때도 `--journal=<이 경로>`를 사용해야 해당 영수증을 발행에서 찾을 수 있습니다. 다른 실행 저널을 새로 만들면 같은 업로드의 증거로 인정되지 않습니다.

| 입력 | 맞아야 하는 값 |
|---|---|
| `document.json` | `blogId`, `title`, 전체 `blocks`. 신규 글에는 `logNo` 없음 |
| `job.json` | `mode: "publish"`, `target: {"type":"create"}`, `publish:false`, `dryRun:true`, `executionMode:"independent_http"`, `inputProvider:"headless_sdk"`, `runId`, `jobId`, `blogId`, `title`, `bodyBlocks`, `publishSettings`, `publicationBundle` |
| `publicationBundle` | `schemaVersion:1`, `format:"ai_research_article"`, `layoutReference.id:"adaptive-ai-v1"`, `document`, `claimLedger`, `research`, `gatePlan`, 작성자·중복 판정·리뷰 관련 필드 |
| AI 카테고리 | 현재 계약은 `aicandoanything`, `categoryId:12`, `categoryName:"AI"`. `research.category`와 `publishSettings`가 일치 |
| 공개 조건 | 현재 신규 AI 계약은 `visibility:"public"`, `timing:"current"`, `searchAllowed:true` |
| 출처 | bundle의 `research`와 job의 `researchSnapshot`이 일치. 실제 파일·SHA-256·인용문·claim ID가 연결 |
| 독립 리뷰 | `reviewedDocumentSha256`가 현재 `document.json` 바이트와 일치, `decision:"pass"`, `hardBlocks:[]`, 실제 검토 체크·문단 평가 |

위 표는 입력 관계 설명이며, 실제 리뷰·근거 없이 그대로 발행되는 최소 job 템플릿이 아닙니다. 새 글의 집필/빌드 단계가 각 파일을 준비해야 합니다. `gates`, `lint`, `review` 명령은 글을 새로 집필하거나 독립 검토를 대신 수행하지 않습니다. 특히 `review`는 **이미 존재하는** 검토 결과를 현재 문서에 연결합니다.

[동적 gate plan의 필드와 적용 조건](adaptive-blog-publishing.md), [문서 형식 구현](../apps/naver-blog-api/scripts/gates/publication-document.mjs), [최종 job 검사 구현](../apps/naver-blog-api/scripts/gates/publisher-gates.mjs)을 참고하세요. `tests/support/`의 fixture는 합성 근거·리뷰를 사용하므로 실발행 입력으로 쓰면 안 됩니다.

## 3. 신규 글 실행 순서

```powershell
$Repo = (Get-Location).Path
$Article = (Resolve-Path (Read-Host '준비된 신규 글 작업 폴더')).Path
$Workflow = Join-Path $Repo 'apps\naver-blog-api\workflows\adaptive-publish\run.mjs'
$PreviewPost = Read-Host '읽기 전용 미리보기용 내 기존 글 번호'
$ArticleJournal = Join-Path $Article 'publication-journal.jsonl'
```

미리보기용 글 번호는 native renderer에 원본 문서를 올려보는 컨테이너입니다. `lint`/`preview`는 그 글을 발행·수정하지 않습니다.

### 내용·근거 점검과 최종 미리보기

각 줄의 출력과 결과 파일을 확인한 다음 다음 단계로 진행합니다. `gates`는 초기 작성 중 빠진 리뷰·근거를 알려줄 수 있습니다. 리뷰가 채워져야 마지막 발행 게이트를 통과합니다.

```powershell
node $Workflow gates "--run=$Article"
node $Workflow lint "--run=$Article" "--container=$PreviewPost"
node $Workflow preview "--run=$Article" "--container=$PreviewPost"
node $Workflow review "--run=$Article"
node $Workflow jev "--run=$Article" --attempts=3
node $Workflow preview-bind "--run=$Article"
```

| 단계 | 하는 일·결과 |
|---|---|
| `gates` | 소스·주장·문서·job 실패 항목 출력. 종료 코드 0만으로 통과 판단 금지 |
| `lint` | HTTP 컴파일·본문/표/미디어 확인 → `model-lint.json`. `passed:true` 확인 |
| `preview` | 실제 Chromium으로 PC·모바일 렌더 → `native-preview.json`, 스크린샷 |
| `review` | `editorial-review-raw.json`의 문서 해시·결론 확인 → `independent-review.json`, `job-reviewed.json` |
| `jev` | 레퍼런스 상대 품질 + 동적 조건 판단 → 리뷰 영수증, `job-reviewed.json` |
| `preview-bind` | 문서·리뷰와 실제 미리보기 연결 → `job-native-bound.json` |

Jev는 네이버 인증과 별도입니다. 현재 설정은 `JEV_PROVIDER`, `AI_GATEWAY_API_KEY`/`TYPESAFE_API_KEY` 등 프로세스의 공급자 설정 또는 기존 Windows DPAPI 키를 읽습니다. DPAPI 키 위치는 `%USERPROFILE%\.config\affiliate-content-operations\vercel-ai-gateway-api-key.dpapi` 또는 `typesafe-api-key.dpapi`이며, 네이버 credential CLI의 `credentials` 하위 폴더와 다릅니다. [실제 설정 코드](../apps/naver-blog-api/workflows/affiliate-content-e2e/jev-supervisor.mjs)를 기준으로 공급자를 연결하세요. 키 값은 job이나 문서에 넣지 않습니다.

Jev의 실제 판단이 수정을 요구하면 문서·근거를 고친 뒤 해당 단계부터 다시 수행합니다. 서비스 오류는 통과가 아닙니다. `waive-jev`는 사용자가 그 글에 대한 Jev 면제를 명시한 경우에만 쓰는 별도 기능이며, 평소 실행 순서에 넣지 않습니다.

본문·이미지·영상·캡션을 바꾸면 새 리뷰와 미리보기가 필요합니다. claim ID 등 표시 내용이 바뀌지 않은 메타데이터만 수정했다면 fresh `lint` 후 `preview-rebind`로 이전 렌더를 연결할 수 있습니다. 컴파일 결과나 표시 단위가 다르면 이 명령이 거절합니다.

### 발행 준비 → 승인 기록 → 실제 발행

```powershell
node $Workflow prepare "--run=$Article"
node $Workflow authorize "--run=$Article" '--basis=사용자가 이 작업 폴더의 최종 글 공개 발행을 요청함'
```

`--basis`에는 실제로 받은 요청의 근거를 적습니다. `authorize`는 받은 승인을 현재 문서·대상에 묶어 기록하며 새 승인을 받아오는 명령이 아닙니다. `prepare-create.json`, `publish-job-gate.json`, `job-publish.json`의 대상·제목·카테고리·태그·공개 범위를 확인합니다. preflight의 유효 시간은 30분입니다.

**아래 `create`가 실제 신규 글을 발행합니다. 한 번 실행합니다.**

```powershell
node $Workflow create "--run=$Article"
```

정상 결과가 확인된 후:

```powershell
node $Workflow readback "--run=$Article"
node $Workflow verify "--run=$Article"

$Verified = Get-Content -Raw -Encoding utf8 "$Article\final-verification.json" | ConvertFrom-Json
$Verified.status
$Verified.publicUrl
$Verified.failedChecks
```

최종 성공은 `status:"published_verified"`와 빈 `failedChecks`, 공개 URL로 판단합니다. `create`의 종료만으로 완료 처리하지 않습니다.

현재 adaptive runner의 `prepare`와 `create`는 모두 headless 공급자를 사용합니다. 하위 API에는 브라우저 없는 `prepare-create-http`도 있지만, wrapper 전체가 자동으로 그 경로를 선택하는 것은 아닙니다. 어느 경우든 **새 글의 실제 create에는 fresh SDK 입력이 필요**합니다.

## 4. 기존 글 수정

먼저 수정하려는 글에 맞춘 `job.json`, 전체 `document.json`, 근거·리뷰·미디어 파일을 준비합니다. 문서와 job 모두 같은 기존 `logNo`를 가리켜야 합니다. 원래 글의 공개 범위·설정을 읽고 보존할 baseline을 확보합니다.

매니페스트 예시에서 키 `123456789012`는 **형식 설명용 번호**입니다. 실제 수정 대상 번호로 바꾸세요. 아래 경로는 매니페스트 파일 기준 상대경로입니다.

```json
{
  "schemaVersion": 1,
  "blogId": "aicandoanything",
  "posts": {
    "123456789012": {
      "directory": "revision-01",
      "journal": "original-journal"
    }
  }
}
```

이미 시도한 수정·미디어 업로드를 이어가는 경우 `journal`은 기존 경로여야 합니다. 최초 실행 전부터 작업 폴더에 dry-run `job.json`이 있어야 `baseline`도 실행됩니다.

```powershell
$Manifest = (Resolve-Path (Read-Host 'republish-manifest.json 경로')).Path
$Post = Read-Host '매니페스트에 등록된 수정 대상 logNo'
npm run republish -- status "--manifest=$Manifest"
npm run republish -- baseline "--manifest=$Manifest" "--post=$Post"
npm run republish -- upload "--manifest=$Manifest" "--post=$Post"
npm run republish -- jev-quality "--manifest=$Manifest" "--post=$Post"
```

`upload`는 빠진 PNG·MP4/WebM을 업로드하고 `document.json`에 실제 영수증을 반영합니다. 이 최종 문서로 독립 검토자가 **`editorial-review.json`**을 준비해야 합니다. 신규 글의 `editorial-review-raw.json`과 파일 이름·형식이 다릅니다.

`gate-plan.json`을 사용하는 동적 AI 글이면 추가로 실행합니다.

```powershell
npm run republish -- adaptive-gates "--manifest=$Manifest" "--post=$Post"
```

리뷰 준비 후:

```powershell
npm run republish -- preview "--manifest=$Manifest" "--post=$Post"
npm run republish -- assemble "--manifest=$Manifest" "--post=$Post"
npm run republish -- prepare "--manifest=$Manifest" "--post=$Post"
npm run republish -- authorize "--manifest=$Manifest" "--post=$Post" --approved-by=user
```

각 단계가 통과하고 `authorized-job.json`의 대상을 확인한 뒤, **실제 수정**을 한 번 실행합니다.

```powershell
npm run republish -- publish "--manifest=$Manifest" "--post=$Post"
npm run republish -- readback "--manifest=$Manifest" "--post=$Post"
npm run republish -- verify "--manifest=$Manifest" "--post=$Post"
```

`final-verification.json`의 `passed:true`와 모든 체크를 확인합니다. `status`는 저장된 결과와 시각만 보여주며 실시간 readback이 아닙니다. `baseline`은 기존 기준 파일을 덮어쓰지 않습니다. 새 수정판은 새 문서 폴더로 관리하고 원래 저널의 이력은 유지합니다.

## 5. 이미 준비된 job을 API로 직접 실행

통합 workflow 대신 이미 검토가 끝난 수정 job을 실행할 때의 순서입니다. `$Run`, `$Journal`은 루트 README에서 만든 **동일 실행 경로** 또는 그 작업의 기존 경로를 사용합니다. `job.json`과 승인 job은 같은 폴더에 두어 내부 상대경로를 유지합니다.

```powershell
$Job = (Resolve-Path (Read-Host '기존 글 수정용 dry-run job.json')).Path
$JobDir = Split-Path -Parent $Job
$Preflight = Join-Path $JobDir 'preflight.json'
$AuthorizedJob = Join-Path $JobDir 'authorized-job.json'

npm run publisher:api -- --command=prepare-update "--job=$Job" "--journal=$Journal" "--output=$Preflight"
node .\apps\naver-blog-api\scripts\gates\authorize-api-update.mjs "--job=$Job" "--preflight=$Preflight" --approved-by=user "--output=$AuthorizedJob"
```

검토·승인·preflight가 충족된 후의 실제 수정:

```powershell
npm run publisher:api -- --command=update "--job=$AuthorizedJob" "--journal=$Journal" "--output=$Run\update-receipt.json"
```

기존 초안 저장은 아래처럼 준비 결과를 입력으로 사용합니다. **새 빈 초안을 만드는 API는 이 명령의 지원 범위가 아닙니다.** 문서에는 `list-drafts`에서 확인한 기존 초안 `logNo`가 있어야 합니다.

```powershell
$DraftDocument = (Resolve-Path (Read-Host '기존 초안의 전체 문서 JSON')).Path
npm run publisher:api -- --command=prepare-draft "--document=$DraftDocument" "--journal=$Journal" "--output=$Run\draft-preflight.json"
npm run publisher:api -- --command=save-draft "--job=$Run\draft-preflight.json" "--journal=$Journal" "--output=$Run\draft-save.json"
```

## 6. 이미지·영상·캡션을 문서에 연결

아래는 블록의 모양을 설명하는 JSON입니다. `<...>`는 실제 로컬 해시·경로·영수증으로 바꿔야 하며 완성된 발행 문서가 아닙니다. `rights.basis:"owned"`는 실제로 직접 만든 미디어일 때만 사용합니다.

```json
[
  {
    "type": "image",
    "file": "images/demo.png",
    "sha256": "<로컬 PNG SHA-256>",
    "publishedUrl": "<실제 업로드 결과 URL>",
    "uploadReceipt": { "<설명용 자리>" : "실제 image-upload.json 객체 전체" },
    "purpose": "본문에서 설명하는 화면 확인",
    "rights": { "basis": "owned", "source": "직접 촬영한 실행 화면" }
  },
  {
    "type": "paragraph",
    "presentation": "caption",
    "text": "화면의 출처와 확인할 지점."
  },
  {
    "type": "video",
    "file": "media/demo.mp4",
    "sha256": "<로컬 MP4 SHA-256>",
    "sourceId": "<bundle에 등록한 근거 ID>",
    "videoId": "<실제 업로드 결과 videoId>",
    "uploadReceipt": { "<설명용 자리>" : "실제 video-upload.json 객체 전체" },
    "purpose": "동작의 시간 순서 확인",
    "rights": { "basis": "owned", "source": "직접 녹화한 실행 영상" },
    "mediaMeta": { "title": "직접 실행한 데모", "ai": false }
  },
  {
    "type": "paragraph",
    "presentation": "caption",
    "text": "실행 조건과 영상에서 확인할 동작."
  }
]
```

출처·실험 결과·숫자 같은 사실을 캡션에 적으면 그 문장도 claim 연결이 필요합니다. AI 생성·인용 이미지에는 해당 권리/원본 근거와 실제 제작 방식에 맞는 표시를 사용합니다. 미디어를 새로 넣거나 바꾼 뒤 문서·bundle·리뷰 지문을 다시 연결해야 합니다.

## 7. 응답이 끊겼거나 결과가 불명확할 때

첫 시도의 job·출력·저널을 보존합니다. 새 출력 파일을 만드는 것은 읽기 대사 결과를 남기기 위한 것이며, 같은 글의 재발행을 의미하지 않습니다.

| 원래 작업 | 읽기 대사 명령 |
|---|---|
| 신규 create | `--command=reconcile-create --job=<원래 승인 job>` |
| 기존 글 update | `--command=reconcile --job=<원래 승인 job>` |
| 기존 초안 save | `--command=reconcile-draft --job=<원래 preflight>` |
| 태그 update | `--command=reconcile-tags --job=<원래 승인 job>` |
| 영상 upload | `--command=reconcile-video --file=<원본 파일>` |

예를 들어 신규 AI 글의 create 응답이 사라졌다면:

```powershell
npm run publisher:api -- --command=reconcile-create "--job=$Article\job-publish.json" "--journal=$ArticleJournal" "--output=$Article\create-reconciliation.json"
```

결과의 실제 대상·공개 여부·본문·소유자 확인을 대조합니다. 대사가 완료됐다고 기존 `create-result.json`을 임의로 성공으로 고쳐서 workflow를 이어가지는 않습니다. 저널을 비우거나 파일명을 바꿔 create/update를 재실행하지 마세요. 기존 응답이 모호하면 중복 생성 여부부터 확인해야 합니다.

## 구현과 문서의 경계

CLI 옵션·순서는 현재 소스와 대조했습니다. 이 문서 수정 과정에서 실제 글, 로그인 세션, 미디어를 생성하거나 테스트를 실행하지 않았습니다. 이전 라이브 결과의 기록과 지금 실행 결과를 구분하고, 매 실행의 최종 readback을 완료 증거로 사용하세요.
