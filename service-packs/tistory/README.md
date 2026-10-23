# Tistory API-only 클라이언트

`https://i-never-stop-study.tistory.com` 관리 API를 관측된 HTTP 계약에 따라 호출하는 Windows용 Node.js 도구입니다. 저장된 세션 확인과 제한된 Kakao 저장 계정 갱신, 통계 조회, 명시적 관리 요청, 이미지·MP4 첨부 업로드를 제공합니다.

이 저장소의 `request` 명령은 저널을 만들거나 발행 결과를 검증하는 고수준 발행기가 아닙니다. 글 작성·수정 payload를 만들고, 쓰기 의도를 기록하고, 결과를 관리 화면과 공개 페이지에서 대조하는 책임은 호출자에게 있습니다. 저장소에 완전한 범용 POST/PUT payload 계약은 없습니다. 아래에서 관측된 필드와 한계를 구분합니다.

## 사용 순서

1. [설치](#1-설치) → [로그인·세션 확인](#2-로그인과-세션)
2. [통계 조회](#3-통계-조회) / [관리 API 읽기](#4-관리-api-읽기와-명시적-요청)
3. [글 발행·수정 계약](#5-글-발행과-수정-계약)
4. [이미지·영상 업로드와 본문 삽입](#6-이미지와-mp4-업로드-본문-삽입)
5. [오류 복구](#7-오류와-복구)

## 1. 설치

Windows에서 Node.js 24 이상, npm, Windows PowerShell(`powershell.exe`)을 사용합니다. 이 패키지는 로그인 세션을 Windows DPAPI CurrentUser로 보관하므로, 같은 Windows 사용자 계정으로 실행해야 저장된 자격증명을 읽을 수 있습니다.

통합 저장소 설치는 [루트 README](../../README.md)를 따릅니다. 원본 단독 저장소를 추가 clone할 필요는 없습니다. 아래 예제는 모두 이 pack의 `service-packs/tistory` 폴더에서 실행합니다.

```powershell
# xhr-to-api-only 저장소 루트에서 시작. 이미 이 pack 폴더면 이동 생략.
Set-Location service-packs/tistory
node --version
npm ci --ignore-scripts
```

PowerShell에서 한글 JSON을 표준입력으로 보낼 때 UTF-8을 설정합니다. 이 설정은 현재 PowerShell 창에 적용됩니다.

```powershell
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
```

## 2. 로그인과 세션

### 이미 이 PC에 DPAPI 세션이 저장된 경우

```powershell
npm run login:auto
npm run session:health
```

`login:auto`는 저장된 쿠키로 Tistory 계정과 이 블로그를 각각 확인합니다. Tistory 인증이 거부되고 Kakao의 저장 계정 로그인이 아직 유효하면 관측된 HTTP 로그인 흐름으로 세션을 갱신한 뒤 소유자·블로그를 다시 확인하고 회전된 쿠키를 DPAPI에 저장합니다. 통상 작업은 브라우저를 열지 않습니다.

성공 출력의 주요 필드는 아래와 같습니다. 계정 ID, 계정 선택자와 쿠키 값은 출력하지 않습니다.

```json
{
  "authenticated": true,
  "ownerVerified": true,
  "blogOrigin": "https://i-never-stop-study.tistory.com",
  "probes": ["account-init", "blog-settings"],
  "mode": "stored_session",
  "execution": "pure_http",
  "browserUsed": false,
  "provider": "windows_dpapi_current_user",
  "checkedAt": "2026-09-24T00:00:00.000Z",
  "reauthDetected": false
}
```

`session:health`는 저장된 세션만 확인하며 갱신을 시도하지 않습니다. 성공 출력은 상태와 검증 경로 같은 메타데이터이며 쿠키 값은 포함하지 않습니다. 선택적으로 새 파일에 receipt를 저장할 수 있습니다. 부모 폴더가 있어야 하고, 기존 파일은 덮어쓰지 않습니다.

```powershell
New-Item -ItemType Directory -Force .\runtime | Out-Null
npm run login:auto -- --output=.\runtime\login-receipt.json
npm run session:health -- --output=.\runtime\session-status.json
```

`runtime/`은 Git에서 제외됩니다. Receipt에는 세션 값이 없어도, 실행 결과 파일은 작업 기록이므로 저장소에 추가하지 마세요.

보호 상태의 저장 이름은 `tistory-auth-state-v1`이며 위치는 `%USERPROFILE%\.config\affiliate-content-operations\credentials\`입니다. 쿠키, 대상 계정·블로그 식별 정보, Kakao 저장 계정 선택 정보가 DPAPI로 보관됩니다. 같은 PC·같은 Windows 사용자에서 기존 작업의 보호 저장소를 그대로 재사용합니다. clone은 이 인증값을 복사하지 않습니다.

`--renew`는 매일 쓰는 옵션이 아닙니다. Tistory 쿠키를 메모리의 세션 사본에서 제거하고 Kakao 저장 계정 HTTP 갱신 경로를 의도적으로 점검합니다. 성공하고 계정·블로그 확인까지 끝난 경우에만 새 세션을 DPAPI에 저장합니다.

```powershell
node .\scripts\cli.mjs login --renew
```

### 처음 쓰는 PC 또는 DPAPI 항목이 없는 경우

DPAPI 파일은 Git에 들어 있지 않습니다. 새 PC에서 세션 provider 자체가 없으면 `login:auto`는 `TISTORY_PROVIDER_MISSING`으로 끝나며 계정 비밀번호 로그인이나 브라우저 로그인을 자동 시작하지 않습니다. provider는 있지만 Kakao 저장 로그인 쿠키가 만료되었거나 거부되면 `TISTORY_KAKAO_REAUTH_REQUIRED`가 반환됩니다.

```powershell
npm run session:handoff
```

이 명령은 **브라우저를 열거나 쿠키를 캡처하지 않습니다.** 5분 동안 한 번만 받을 수 있는 localhost 폼, 임시 공개키와 주소를 준비하는 수신기입니다. 별도로 승인된 브라우저 도구가 필요한 Tistory/Kakao 쿠키를 읽고, 메모리에서 암호화해 ciphertext를 제출해야 합니다. 이 저장소에는 브라우저 캡처·암호화 UI가 포함되어 있지 않습니다. 수신기는 계정과 블로그를 HTTP로 확인한 뒤 DPAPI에 저장하며 평문 쿠키를 파일로 받지 않습니다.

저장된 Kakao 로그인이 거부되거나 비밀번호·MFA·CAPTCHA·동의가 요구되면 이 클라이언트의 자동 갱신 범위 밖입니다. 해당 단계는 정상적인 승인된 로그인 절차로 완료한 후 암호화 핸드오프를 사용해야 합니다. Chrome 프로필 DB를 읽거나, 쿠키를 클립보드·명령행·로그·Git으로 옮기지 마세요.

`TISTORY_COOKIE` 환경변수는 기존 스크립트 호환용 일회성 override입니다. 이 값을 설정하면 `scripts/client.mjs`와 `scripts/request.mjs`가 DPAPI provider 대신 그 값을 사용하며, 저장하거나 자동 갱신하지 않습니다. 기본 DPAPI 동작을 쓰려면 설정하지 마세요.

## 3. 통계 조회

지원하는 이름은 `count`, `trend`, `top`, `inflow`, `keyword`, `recent`입니다. 각 항목은 실행 시 아래 경로를 조회합니다.

| 이름 | GET 경로 |
|---|---|
| `count` | `/manage/v2/statistics/blog/count` |
| `trend` | `/manage/v2/statistics/dashboard/trend` |
| `top` | `/manage/statistics/dashboard/topEntry.json` |
| `inflow` | `/manage/statistics/dashboard/inflow.json` |
| `keyword` | `/manage/statistics/dashboard/keyword.json` |
| `recent` | `/manage/statistics/dashboard/recentEntry.json` |

```powershell
npm run stats -- count
npm run stats -- trend
npm run stats -- top --data
```

기본 출력은 상태·MIME·크기·해시·응답 schema 등 메타데이터입니다. `--data`를 붙이면 통계 원문 데이터를 출력합니다. 원문에 계정·블로그 데이터가 포함될 수 있으니 로그나 Git에 저장하지 마세요. 지원하지 않는 통계 이름은 요청 전에 실패합니다.

## 4. 관리 API 읽기와 명시적 요청

`npm run request`는 표준입력의 JSON 한 개를 읽어 실제 응답 데이터까지 출력합니다. 허용 범위는 이 저장소에 설정된 블로그의 `https://i-never-stop-study.tistory.com/manage/` 경로와 `GET`, `POST`, `PUT`, `DELETE`입니다. 쿼리 키에 token, cookie, password, secret, authorization이 포함되면 거부합니다. 이는 관측 API 전체의 허용 목록은 아니므로, 카탈로그에서 계약이 확인된 경로만 사용하세요.

다음 예시는 카테고리 API를 읽습니다.

```powershell
@'
{"url":"https://i-never-stop-study.tistory.com/manage/category/simple.json","method":"GET"}
'@ | npm run request
```

`npm run request`의 성공 응답에는 `data` 원문이 있으므로 PowerShell 화면·리디렉션 파일을 공유하지 마세요. `scripts/cli.mjs request`는 같은 형태의 요청을 받고 상태·schema 같은 메타데이터만 출력하는 경로입니다.

```powershell
@'
{"url":"https://i-never-stop-study.tistory.com/manage/category/simple.json","method":"GET"}
'@ | node .\scripts\cli.mjs request
```

이미 JSON 요청 파일이 있다면 다음처럼 전달할 수 있습니다.

```powershell
Get-Content -Raw -Encoding UTF8 .\runtime\request.json | npm run request
```

요청 형식은 `url`, 선택값 `method`(기본 `GET`), 선택값 `body`입니다. 표준입력 한도는 4 MiB입니다. 처리 결과는 애플리케이션 본문까지 직접 살펴야 합니다. HTTP 200이나 정상 종료만으로 업무 성공이 되지는 않습니다.

자동화에서 npm의 안내문 없이 JSON만 받으려면 `node .\scripts\request.mjs` 또는 `npm run --silent request`를 사용합니다. 예를 들어 관리 글 목록을 메모리에서 읽으려면:

```powershell
$Request = @{ url = 'https://i-never-stop-study.tistory.com/manage/posts.json?page=1' } | ConvertTo-Json -Compress
$ResponseJson = $Request | node .\scripts\request.mjs
if ($LASTEXITCODE -ne 0) { throw '관리 목록 조회 실패' }
$Response = $ResponseJson | ConvertFrom-Json
$Response.data.totalCount
```

현재 `scripts/cli.mjs`의 `--output`은 요청을 처리한 **뒤** 결과 파일을 씁니다. 파일 충돌이나 저장 오류가 났다고 API 요청이 전송되지 않았다고 판단하면 안 됩니다. 쓰기 호출자는 요청 전 저널과 새 결과 경로를 별도로 확보해야 합니다.

## 5. 글 발행과 수정 계약

관측된 생성 경로는 `POST /manage/post.json`, 수정 경로는 `PUT /manage/post/{id}.json`입니다. 둘은 별도 작업입니다. POST payload의 `id`를 기존 글 ID로 바꿔도 PUT이 되지 않고 새 글 생성 요청으로 남을 수 있습니다. 삭제 경로는 `DELETE /manage/post/{id}.json`이며, 이 README는 삭제 실행 절차를 제공하지 않습니다.

카탈로그가 기록한 생성 요청 필드는 아래와 같습니다.

| 생성 `POST /manage/post.json` 필드 | 관측된 타입 |
|---|---|
| `id`, `title`, `content`, `slogan`, `tag`, `password`, `type`, `recaptchaValue` | string |
| `visibility`, `category`, `published`, `uselessMarginForEntry`, `cclCommercial`, `cclDerive`, `totalWritingTimeMs` | number |
| `attachments` | array; 원소 schema는 catalog에 없음 |
| `draftSequence` | object; 내부 schema는 catalog에 없음 |

수정 `PUT /manage/post/{id}.json`의 관측 필드는 위 항목에 `acceptComment`(number), `daumLike`(object), `thumbnail`(object)이 더해집니다. `attachments`는 원소 schema가 기록되지 않았고, `draftSequence`·`daumLike`·`thumbnail`의 내부 schema도 확인되지 않았습니다. 카탈로그는 타입만 기록하며 필수 여부, 허용 값·열거값, 현재 UI 상태에 따른 조건을 모두 제공하지 않습니다. 수정은 현재 소유자 편집 표현을 먼저 읽고 관계없는 필드를 보존해야 합니다. 여기에는 임의의 공개/비공개 값이나 완성 payload를 만들어 넣지 않았습니다.

### 공개 발행 전 CAPTCHA 상태 확인

새 공개 글을 만들기 전에는 현재 에디터의 CAPTCHA 상태를 따로 확인해야 합니다. 관측된 상태는 인증된 HTML 에디터 페이지(`/manage/newpost/?type=post&returnURL=...`)의 `needCaptcha` 값입니다. `scripts/request.mjs`와 `requestManagement()`는 JSON 응답만 처리하므로 이 HTML 값을 읽거나 자동 판정하지 않습니다. 이 저장소의 JSON 카탈로그에도 현재 `needCaptcha` 상태는 들어 있지 않습니다. 기존 글을 수정하는 자동 발행 흐름에서도 대상 에디터 문맥을 읽은 뒤 같은 사전 조건을 확인합니다.

따라서 `recaptchaValue`가 문자열이라는 schema만 보고 빈 문자열이나 임의 값을 넣어도 된다고 판단하면 안 됩니다. 과거 한 번의 replay에서 빈 값이 통과한 사실도 다음 요청의 CAPTCHA 상태를 증명하지 않습니다. 이 패키지에는 CAPTCHA 판독·제출 provider가 없습니다. HTML 상태가 `true`이거나 읽을 수 없어 불명확하면 POST/PUT을 보내지 말고 중단해야 합니다. HTML 에디터 상태를 확인할 수 있는 호출자가 별도로 이 게이트를 수행해야 합니다.

따라서 아래 셸 명령은 **이미 현재 편집 화면에서 확인한 payload를 담은 로컬 요청 파일**을 보내는 전달 예시입니다. 저장소에는 안전하게 그대로 실행할 수 있는 범용 발행 JSON이 없습니다.

```powershell
# request.json의 url은 /manage/post.json + method POST,
# 또는 검증한 대상 ID의 /manage/post/{id}.json + method PUT이어야 합니다.
Get-Content -Raw -Encoding UTF8 .\runtime\request.json | npm run request
```

이 일반 요청기는 발행 저널을 만들거나, 중복을 확인하거나, 공개 페이지를 읽어오지 않습니다. 관리 목록은 관측된 JSON 경로 `GET /manage/posts.json?page=1`에서 시작하며 응답의 `items`와 `totalCount`를 대조하고, 모든 페이지를 확인해 정확한 제목 중복을 살펴야 합니다. 이 요청기는 JSON 관리 목록은 읽을 수 있지만, 대상 글의 에디터 원문과 `needCaptcha`를 제공하는 HTML 페이지는 해석하지 않습니다. 공개 URL도 `/manage/` 범위 밖이므로 이 도구로 읽지 않습니다.

실제 쓰기 작업을 별도로 구성할 때는 요청 전 의도와 payload hash를 새 저널에 남기고, HTTP 결과가 모호하면 **같은 저널·전체 관리 글 목록·대상 편집 원문을 먼저 대사한 뒤**에만 다음 행동을 정하세요. POST를 자동 재전송하지 마세요. 응답의 `entryUrl`만으로 발행 완료를 판단하지 말고, 관리 원문과 공개 URL에서 제목·본문·노출 상태를 각각 확인하세요. 관리 목록 readback은 글이 등록됐는지 확인하고, 대상 소유자 편집 문맥 readback은 저장된 본문과 기존 필드 보존을 확인하며, 공개 URL readback은 실제 방문자 화면을 확인합니다. 이 단계들은 서로 다른 증거입니다.

현재 payload 필드·관측 시점과 일반적인 쓰기 주의사항은 [`references/api-catalog.json`](references/api-catalog.json), [`references/operations.md`](references/operations.md), 과거 결과는 [`evidence/write-verification.json`](evidence/write-verification.json)에서 확인할 수 있습니다. 과거 테스트 글이나 API replay는 새 쓰기 권한이나 현재 계약을 대신하지 않습니다.

## 6. 이미지와 MP4 업로드, 본문 삽입

업로드는 **게시글 수정/발행과 별도 작업**입니다. 업로더가 지원하는 로컬 파일은 PNG/JPEG/GIF/WebP 이미지와 MP4이며, 각 파일은 1바이트 이상 10 MiB 이하입니다. 10 MiB는 이 클라이언트의 로컬 제한이지 Tistory 공식 상한이라는 뜻은 아닙니다. 업로더는 파일 signature와 확장자를 확인합니다.

이미지 업로드 예시:

```powershell
$Runtime = Join-Path (Get-Location).Path 'runtime'
New-Item -ItemType Directory -Force $Runtime | Out-Null
npm run upload:image -- "--file=C:\Media\figure.png" "--journal=$Runtime\figure-upload.json"
```

MP4를 일반 파일 첨부로 올리는 예시:

```powershell
$Runtime = Join-Path (Get-Location).Path 'runtime'
New-Item -ItemType Directory -Force $Runtime | Out-Null
npm run upload:video-attachment -- "--file=C:\Media\demo.mp4" "--journal=$Runtime\demo-upload.json"
```

`--file`과 `--journal`은 절대 경로여야 합니다. journal 부모 폴더는 미리 만들고, 해당 `.json` 파일은 새 경로여야 합니다. 업로더는 intent를 파일에 먼저 기록한 다음 `POST /manage/post/attach.json`을 한 번만 보내고, 응답 URL을 DPAPI에 보관한 뒤 계정 쿠키 없이 CDN에서 다시 받아 MIME·signature·길이·SHA-256을 대조합니다. 같은 journal이 이미 있으면 재업로드를 막습니다. 결과가 모호하면 파일명을 바꿔 재시도하지 말고 기존 journal과 DPAPI receipt를 먼저 대사하세요.

성공 출력은 URL 대신 상태, `credentialId`, source/remote hash와 바이트 수를 보여줍니다. 서명 미디어 URL은 `lib/media.mjs`의 `loadStoredMedia(credentialId)`로 메모리에만 가져옵니다. image shortcode에는 캡션을 넣을 수 있습니다.

```js
import { readFileSync } from 'node:fs';
import { loadStoredMedia } from './lib/media.mjs';
import { nativeImageMarkup } from './lib/media-content.mjs';

const receipt = JSON.parse(readFileSync('.\\runtime\\figure-upload.json', 'utf8'));
const image = loadStoredMedia(receipt.credentialId);
const markup = nativeImageMarkup(image, {
  width: 1200,
  height: 800,
  caption: '이미지 설명 및 출처',
});
// markup에는 서명 URL이 들어 있으므로 메모리에서 발행 payload에 합칩니다.
```

위 JavaScript는 저장소 루트의 ES module에서 사용하는 통합 예제입니다. `width`와 `height`는 실제 원본 이미지의 픽셀 크기로 바꿉니다. journal 결과의 `status`가 `verified`인지 확인한 후 본문에 사용하세요.

일반 MP4 첨부는 다운로드 카드입니다. Tistory의 native video 업로드 기능은 종료됐습니다. 이 패키지의 `renderVideo()`는 **검증 성공한** MP4 업로드 receipt의 source/CDN SHA-256 및 바이트 수가 일치할 때 HTML5 `<video>` 요소와 native 파일 다운로드 대체안을 만듭니다. `videoScript`는 본문에 렌더된 파일 링크를 읽어 현재 CDN URL을 설정합니다. 서명 URL을 스크립트에 고정하지 않지만, 생성된 본문에는 파일 shortcode 서명 참조가 있으므로 본문 원문을 로그나 Git에 저장하지 마세요. 업로드 성공만으로 공개 재생이 보장되지는 않으니 실제 공개 페이지에서 확인해야 합니다.

```js
import { readFileSync } from 'node:fs';
import { loadStoredMedia } from './lib/media.mjs';
import { renderVideo, videoScript } from './lib/media-content.mjs';

const uploadReceipt = JSON.parse(readFileSync('.\\runtime\\demo-upload.json', 'utf8'));
const attachment = loadStoredMedia(uploadReceipt.credentialId);
const videoMarkup = renderVideo({
  attachment,
  uploadReceipt,
  caption: '비교 영상 설명',
});
const postContent = videoMarkup + '\n' + videoScript;
// postContent는 서명 참조를 포함하므로 보호된 저장소나 메모리에서만 다룹니다.
```

렌더 함수는 캡션을 HTML escape하며 검증되지 않은 MP4 receipt는 거부합니다. 이미지 shortcode와 video helper 세부사항 및 공식 서비스 변경 안내는 [`references/media.md`](references/media.md)를 참고하세요.

## 7. 오류와 복구

| 오류 코드 | 의미와 다음 단계 |
|---|---|
| `TISTORY_PROVIDER_MISSING` | 이 Windows DPAPI 사용자 저장소에 등록된 세션이 없음. 저장 계정 갱신이 아니라 최초 암호화 핸드오프 절차를 준비해야 함. |
| `TISTORY_REAUTH_REQUIRED` | Tistory 세션이 유효하지 않거나 `status`가 이를 감지함. `login:auto`는 저장된 Kakao 로그인이 가능할 때만 갱신을 시도함. |
| `TISTORY_KAKAO_REAUTH_REQUIRED` | Kakao 저장 로그인이 만료/거부됐거나 추가 인증이 필요함. 비밀번호/MFA/CAPTCHA는 자동화되지 않음. |
| `TISTORY_ACCOUNT_SELECTION_REQUIRED` | 저장 계정 선택 계약에 필요한 계정 구분 정보가 없어 자동 선택할 수 없음. 임의 계정을 고르지 말고 정상 인증 상태를 다시 준비함. |
| `TISTORY_ACCESS_DENIED`, `TISTORY_RATE_LIMITED` | 접근 거부 또는 제한. 이를 세션 만료로 간주해 반복 요청하지 말고 원인과 제한 상태를 확인함. |
| `TISTORY_WRITE_OUTCOME_UNKNOWN` | 비-GET 요청의 응답을 확정할 수 없음. 같은 쓰기를 재전송하지 말고 저널·관리 목록·소유자 편집 원문으로 대사함. |
| `TISTORY_JOURNAL_ALREADY_EXISTS` | 업로드 journal 경로가 이미 있음. 그 기록을 조사하고 새 파일명으로 우회해 중복 업로드하지 않음. |
| `TISTORY_UPLOAD_OUTCOME_UNKNOWN` | 업로드 POST의 결과가 모호함. journal과 DPAPI acknowledgement를 확인하기 전에는 다시 올리지 않음. |

403 접근 거부, 429 제한, 예상하지 못한 JSON/MIME은 인증 만료와 다른 상태입니다. 공통 도구는 실패 시 본문/쿠키 대신 분류된 `TISTORY_*` 코드만 출력합니다.

## 8. 파일 안내

- `scripts/cli.mjs`: `login`, `status`, metadata-only `request` 및 `--output` receipt
- `scripts/client.mjs`: 여섯 통계 조회
- `scripts/request.mjs`: JSON 표준입력 기반 관리 GET/POST/PUT/DELETE
- `scripts/media-cli.mjs`: image 또는 video attachment 업로드
- `scripts/secure-credential-store.*`: Windows DPAPI CurrentUser 저장소 어댑터
- `tools/session-handoff.mjs`: 암호문만 받는 단회 localhost 수신기; 브라우저 캡처기는 아님
- `lib/`: scoped HTTP session, 로그인 갱신, lock, management, media, markup 구현
- `references/api-catalog.json`: 관측한 경로·필드·응답 schema
- `references/operations.md`: 계약, scope, 갱신과 요청 실행 한계
- `references/authentication.md`: 인증 저장과 bootstrap 보안 경계
- `references/media.md`: multipart 업로드, shortcode, HTML5 재생 경계
- `evidence/`: 날짜가 붙은 과거 관측·replay 자료. 현재 세션이나 모든 기능의 작동 보증이 아님

오프라인 단위 테스트는 `npm test`로 실행할 수 있습니다. 통과해도 현재 Tistory 세션이나 서비스의 live API 동작을 증명하지는 않습니다.

문서 기준은 2026-09-24의 현재 코드입니다. 이번 README 정리에서는 로그인·업로드·발행이나 테스트를 새로 실행하지 않았습니다.

## Consolidated workflows (2026-10-14)

This pack is the single source of truth for Tistory HTTP code. Consumers vendor it with
`node scripts/vendor-pack.mjs --pack tistory --dest <consumer>` and keep `PLAYBOOK_VENDOR.json`
(commit + sha256 per file); edit here, then re-vendor.

Ported from other repos:

| Module | From | Phase / status |
| --- | --- | --- |
| `lib/login-identity.mjs` + `tools/session-handoff.mjs` login identity storage | affiliate-content-operations/apps/tistory-api | auth; DPAPI only |
| `lib/workflows/publication-context.mjs` (`/manage/newpost/` bootstrap parser) | affiliate-content-automation | read, `bootstrap-observed-not-publication-verified` |
| `lib/workflows/autosave-draft.mjs` (`/manage/autosave` existing draft update) | affiliate-content-automation | write, read-before/read-after, never publishes |
| `lib/workflows/publish-reviewed.mjs` (`POST /manage/post.json`) | affiliate-content-automation | write, journal `create-intended` → `create-acknowledged` / `needs-reconciliation` → `readback-verified` |
| `lib/workflows/content-update.mjs` (`PUT /manage/post/{id}.json`) | affiliate-content-automation | write, `update-intended` → `needs-reconciliation` / `readback-verified` |
| `lib/workflows/owner-comments.mjs` (`/manage/comments.json`, `/m/api/{id}/comment`) | affiliate-content-automation | read + write, private owner comments only |

No workflow retries a business write; an indeterminate write requires reconciliation by readback.
Workflows accept an injected `request`; the default is the `TISTORY_COOKIE` env transport used by the
original consumer. Contracts stay metadata-only; no cookie or token values are stored in this repo.
