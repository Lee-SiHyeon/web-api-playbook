# XHR → API-only

브라우저에서 관측한 요청을 **로그인·세션 재사용이 가능한 독립 HTTP 작업**으로 바꾸는 개인 작업 도구와 노하우 모음입니다. 기존 스킬, 세션 분석, 실패 원인, 인증 저장·갱신, 재귀 탐색, 발행·업로드 구현을 한 저장소에 담았습니다.

**바로 시작:** [설치](#1-설치) → [로그인 없이 도구 실행](#2-로그인-없이-도구부터-실행) → [서비스 선택](#3-기존-서비스를-사용할-때) → [새 서비스 전환](#4-새-서비스를-http로-전환할-때).

실제 계정 비밀번호·쿠키·토큰·브라우저 프로필은 포함하지 않습니다. **이들을 로컬에서 보호 저장하고 재사용하는 구현은 포함**합니다. Git clone과 인증 이전은 별개입니다.

## 무엇이 들어 있나

| 구성 | 용도 |
|---|---|
| [SKILL.md](SKILL.md) | 에이전트가 따르는 전환 절차와 증거 기준 |
| [공통 도구](references/runtime-modules.md) | origin별 HTTP 세션, 쿠키 회전, DPAPI, 잠금, 쓰기 저널 |
| [웹 로그인 실행기](references/web-login-usage.md) | MyRealTrip·LinkPrice·[Inpock](references/inpock-login.md) 비밀번호 로그인, Coupang 웹 세션, X 요청별 transaction ID와 조회 CLI |
| [아고다 공개 요금·행사](references/agoda-http.md) | 알려진 16개 숙소의 날짜별 KRW 요금과 행사 카드 direct HTTP, 독립 계약·부분 제공 범위 표시 |
| [쇼핑·여행커넥트](references/naver-connect.md) | 네이버 브랜드커넥트 상품 검색·상세·수수료·링크 발급 및 관리, DPAPI 세션 재사용 |
| [해외 쇼핑몰 공개 조회](references/retail-public-apis.md) | 비로그인 AliExpress 상품 SEO, eBay 검색 제안, Shopify 기반 Allbirds 상품·예측 검색과 해외몰 기능 체크리스트 |
| [해외 제휴·드랍쉬핑 상품 수집](references/commerce-collection.md) | 공식 제휴/공급사 API, Printful 공개 가격 피드, Allbirds·ColourPop, JSON·CSV 수집과 가격 변화 비교 |
| [제휴 프로그램별 연결](references/affiliate-program-adapters.md) | Olive Young·Shopee·Sephora·Ulta·Rakuten, 브랜드 카탈로그 확인과 제휴 링크·수수료의 검증 범위 |
| [상품 상세·리뷰 조회](references/catalog-read-apis.md) | 상세 설명·이미지·옵션, 리뷰 본문·사진·페이지 조회와 제휴 링크를 제외한 기능 감사 |
| [발견 도구](references/discovery-tools.md) | HAR → 계약 목록, 저장 HTML → 후보, 재개 가능한 탐색 상태 |
| [네이버](service-packs/naver/README.md) | HTTP 로그인, 저장 세션, 블로그 API, 통계, 이미지·영상, 발행·수정 |
| [티스토리](service-packs/tistory/README.md) | 저장된 카카오/티스토리 세션, 보호 조회, 발행·수정, 이미지·MP4 첨부 |
| [제휴 API](service-packs/affiliate/README.md) | 마이리얼트립, 애드픽, 쇼핑커넥트, 쿠팡 HTTP 가격·배송비·행사·파트너스 [반복 진단](references/coupang-debugging.md), 올리브영 구현 |
| [X·Reddit](service-packs/social-x/README.md), [Threads](service-packs/threads/README.md) | 서비스별 세션·요청 계약과 공개 자료 수집 경계 |
| [사례](case-studies/README.md) | 무엇이 됐고 어디서 실패했는지, 다른 서비스에 적용할 교훈 |
| [출처](provenance/README.md) | 원본 저장소 commit, 미커밋 스냅샷, 파일 SHA-256, 이식 변경 |

서비스 구현은 저장소 안에 포함된 **고정 버전 사본**입니다. 예전 작업 폴더나 다른 개인 레포를 다시 받아야 코드를 읽을 수 있는 구조가 아닙니다. 각 서비스의 설치 의존성과 실행 경계는 해당 README를 따릅니다.

## 1. 설치

### 공통 요구사항

- Node.js **24 이상**, npm, Git. 브라우저는 공통 도구 실행에 필요하지 않습니다.
- 이 비공개 저장소를 읽을 수 있는 GitHub 계정.
- Windows 보호 저장에는 Windows PowerShell 5.1 이상의 `powershell.exe`와 현재 Windows 사용자 프로필이 필요합니다.

```powershell
git clone https://github.com/Lee-SiHyeon/web-api-playbook.git
cd web-api-playbook
npm ci --ignore-scripts
npm run doctor
```

macOS/Linux도 공통 Node 도구 설치 명령은 같습니다. `doctor`의 `dpapiAvailable:false`는 그 OS에서 예상되는 결과입니다. 지속 저장은 별도 OS 보관함 공급자를 연결해야 하며, 공통 요청기는 `--session-stdin`으로 메모리 세션을 받을 수 있습니다. Windows DPAPI 파일을 다른 OS나 사용자에게 복사해 재사용하지 않습니다.

`doctor`는 런타임·파일·의존성을 확인합니다. 사이트에 로그인하거나 실제 서비스 세션을 검증하지 않습니다. 환경별 경계는 [이식 안내](references/portability.md)를 보세요.

### Codex 스킬로 설치

```powershell
npm run install:skill
```

기본 대상은 `$CODEX_HOME/skills/xhr-to-api-only`, `CODEX_HOME`이 없으면 사용자 홈의 `.codex/skills/xhr-to-api-only`입니다. 스킬과 도구·서비스 사본을 함께 복사합니다. 복사된 위치로 이동해 `npm ci --ignore-scripts`와 `npm run doctor`를 실행한 뒤 새 에이전트 세션에서 사용합니다.

다른 에이전트나 폴더에 설치하려면:

```powershell
node scripts/install-skill.mjs "--target=C:/agent-skills/xhr-to-api-only"
```

**이미 존재하는 대상에는 덮어쓰지 않습니다.** 업데이트할 때 기존 폴더를 별도로 보관하고 새 대상에 설치하거나, 저장소를 Git으로 관리하며 변경을 합치세요. `node_modules`, 인증값, 작업 기록, `.git`은 설치 사본에 복사하지 않습니다. `agents/openai.yaml`은 Codex용 메타데이터이며 다른 에이전트는 `SKILL.md`부터 읽으면 됩니다.

## 2. 로그인 없이 도구부터 실행

아래 명령은 저장소의 **합성 예제 파일만** 처리합니다. 브라우저·네트워크·로그인이 필요 없습니다. 파일 경로는 저장소 루트를 기준으로 합니다.

```powershell
node -e "require('node:fs').mkdirSync('work', { recursive: true })"
node scripts/har-to-contracts.mjs --input=examples/sanitized.har.json
node scripts/discover-html.mjs --input=examples/navigation.html --base=https://example.invalid/
node scripts/frontier.mjs init --input=templates/frontier.example.json --output=work/frontier-001.json
node scripts/frontier.mjs next --snapshot=work/frontier-001.json
node scripts/frontier.mjs report --snapshot=work/frontier-001.json
```

예상 결과:

- HAR: `xhr-contract-inventory-v1`, 요청 필드·응답 타입·상태. 토큰·본문 값은 출력하지 않음.
- HTML: `xhr-html-candidates-v1`, 링크·iframe·스크립트 **후보**. `liveNetworkUsed:false`.
- Frontier: 대기 노드와 단계별 집계. 아직 방문하지 않았으므로 탐색 완료가 아님.

`--output`은 **새 파일만** 받습니다. 같은 명령을 다시 실행할 때 `frontier-002.json`처럼 다른 이름을 쓰세요. 상세 옵션과 상태 전이는 [도구 안내](references/discovery-tools.md)에 있습니다.

## 3. 기존 서비스를 사용할 때

### 해외 쇼핑몰 비로그인 조회

해외 제휴·드랍쉬핑 상품과 가격 수집은 [commerce 실행법](references/commerce-collection.md)을 사용한다. `npm run commerce -- providers`로 공개 피드·스토어와 자격 정보가 필요한 공식 API 구현을 구분하고, 결과를 JSON·CSV로 수집할 수 있다. 실제 인증 조회를 확인하지 못한 서비스는 체크리스트에 미완료로 남긴다.

```bash
npm run retail -- aliexpress product-seo --product-id=1005011947482958
npm run retail -- ebay suggest --query="usb cable"
npm run retail -- shopify predictive-search --query=runner --limit=5
npm run retail -- status
```

지원 명령은 브라우저 없이 HTTP로 실행한다. 검색 제안, SEO 정보, 가격·재고, 상품 목록을 별도 기능으로 구분하며 [현재 지원 범위와 차단 지점](references/retail-public-apis.md)을 확인한다. 새 서비스의 기능은 자동 [체크리스트](checklists/README.md)에 포함한다.

### 웹 로그인·세션 자동 복구

마이리얼트립·쿠팡 파트너스·X·링크프라이스·인포크의 실제 웹 요청 기반 실행기는 [웹 로그인 사용법](references/web-login-usage.md)을 따른다.

```powershell
node scripts/web-login.mjs myrealtrip ensure
node scripts/web-login.mjs coupang ensure
node scripts/web-login.mjs x ensure
node scripts/x-read.mjs sama 3
node scripts/web-login.mjs linkprice ensure
node scripts/web-login.mjs inpock ensure
```

저장 비밀번호 로그인, 저장 웹 세션 재사용, SSO 복구는 서비스별 지원 범위가 다르다.
위 문서에 최초 연결, OTP 재개, 업무 API 연결과 실제 확인 범위를 구분했다.
요청 필드와 계정 제한은 [현재 관측 계약](references/web-login-observed-contracts.md),
실제 HTTP 성공 단계는 [실행 기록](verification/web-login-2026-09-24.json)에 있다.

인포크의 Linux/macOS 메모리 stdin 실행과 Windows 보호 저장 연결은
[Inpock 사용법](references/inpock-login.md)을 따른다. 비밀번호 로그인과 보호 계정 조회를 추가했으며,
실제 HTTP 확인 범위는 [2026-10-04 검증 기록](verification/inpock-login-2026-10-04.json)에 있다.

인포크의 [블록·프로필·통계 조회와 제휴 발행 준비](references/inpock-features.md)는
`scripts/inpock.mjs inventory --credentials-stdin`, `scripts/inpock-prepare.mjs`를 사용한다.
발행 준비 도구는 후보 JSON만 만든다. 실제 공개 카드 등록은
`scripts/inpock.mjs publish --input=CARD.json --credentials-stdin`으로 실행하며,
쓰기 저널·중복 방지·쿠키 없는 public readback과 실제 공개 화면까지 검증했다.
[발행 증거](verification/inpock-publication-proof-2026-10-05.json)를 참고한다.

외부 Gemini·Grok·ChatGPT·Google Flow 클라이언트의 로그인 producer 경계와
Google UA/Cloudflare 실측은 [로그인 진단 기록](references/provider-login-diagnostics.md)을 참고한다.

먼저 [서비스별 실행표](service-packs/README.md)에서 필요한 pack을 고릅니다. 공통 CLI에 서비스 인증을 억지로 변환할 필요 없이, 각 pack의 기존 로그인/발행 런처를 사용할 수 있습니다.

### 아고다 공개 요금·행사

```powershell
node scripts/agoda.mjs campaigns
'{"checkIn":"2026-10-13","checkOut":"2026-10-14"}' | node scripts/agoda.mjs rates
```

날짜는 실행 시점의 유효한 날짜로 바꾼다. 공개 bootstrap의 새 익명 ID는 메모리에서만 사용한다.
현재는 관측한 베트남 숙소 16개 범위이며 전체 행사 상품 목록·회원 요금·결제 총액은 미검증이다.
[관측 계약과 확인 범위](references/agoda-http.md)를 따른다.

### 네이버

```powershell
cd service-packs/naver
npm ci --ignore-scripts
npm run login:auto
npm run session:health
```

`login:auto`는 **해당 pack의 저장소에 이미 준비된 인증**을 사용합니다. 첫 PC에서는 [네이버 README의 최초 로그인 절차](service-packs/naver/README.md#처음-사용하는-pc--id비밀번호를-다시-입력할-때)를 먼저 따르세요. 통계·글 조회·미디어·발행 명령과 입력 파일은 [사용법](service-packs/naver/README.md), [발행 안내](service-packs/naver/docs/publishing-usage.md)에 있습니다.

로그인과 일반 HTTP 작업이 가능해도 신규 발행의 fresh SDK 입력은 별도 경계입니다. 모든 발행 단계가 브라우저 엔진 없이 동작한다고 간주하지 않습니다.

### 티스토리

```powershell
cd service-packs/tistory
npm ci --ignore-scripts
```

이후 [티스토리 README](service-packs/tistory/README.md)의 세션 등록 → `status` → 보호 조회 → 업로드/발행 순서를 따릅니다. 저장된 카카오 세션을 통한 갱신과 **ID·비밀번호부터 시작하는 완전한 카카오 로그인**은 구현 범위가 다릅니다. 본 pack은 후자의 완료를 주장하지 않습니다.

### 제휴·소셜

- 제휴 pack: `cd service-packs/affiliate` → `npm ci --ignore-scripts` → [명령/제한](service-packs/affiliate/README.md).
- X·Reddit pack: `cd service-packs/social-x` → `npm ci --ignore-scripts` → [인증과 명령](service-packs/social-x/README.md).
- Threads: 루트 의존성을 사용합니다. [사용법](service-packs/threads/README.md). 익명 HTTP bootstrap과 로그인 계정 인증을 구분합니다.

## 4. 새 서비스를 HTTP로 전환할 때

### 기능 체크리스트 자동 검사

```bash
npm run checklist
node scripts/checklist.mjs --service=inpock --run-tests
npm run checklist:strict
```

첫 명령은 등록된 모든 서비스의 코드·테스트·저장된 실측 증거를 검사한다.
로그인이나 사이트 쓰기는 수행하지 않는다. 마지막 명령은 필수 기능이 누락되거나
실측/현재 revision 확인이 부족하면 실패 코드로 종료한다.
관측한 소스 후보, 구현, 실제 요청, 결과 대사, 증거의 코드 버전 일치를 분리한다.
[체크리스트 작성·확장 방법](checklists/README.md)을 따른다.

새 서비스 작업은 스킬의 기본 종료 조건으로 이 검사를 사용한다.
로그인 하나만 만든 뒤 프로필·분류·등록/수정/삭제·이미지 같은 누락 기능을 잊지 않도록 목록에 남긴다.
새 서비스는 `checklists/template.json`을 기반으로 기능 적용 범위를 명시한다.

인포크 [프로필 편집 실행기](references/inpock-profile.md)는 `profile-get`, `profile-preview`, `profile-edit`를 제공한다.
현재 코드·테스트·실제 조회는 확인했으며, 지정된 새 값으로 저장하는 API 실증은 아직 대기 상태다.

### 4-1. 관측 자료에서 계약 만들기

1. 기존 코드·계약·최근 영수증에서 재사용할 수 있는 요청을 찾습니다.
2. 없으면 사용자에게 권한이 있는 세션에서 실제 요청을 관측합니다. 브라우저 도구는 환경에 있는 것을 사용합니다. 공통 도구가 Chrome/CDP 연결을 자동으로 제공하는 것은 아닙니다.
3. 민감한 HAR 원본은 Git 밖에서 관리하고, 아래 도구에는 파일 경로나 stdin으로 전달합니다.

```powershell
node scripts/har-to-contracts.mjs "--input=C:/private-runtime/capture.har" --output=work/contracts-001.json
```

이 명령은 원본을 재저장하지 않고 메타데이터만 추립니다. 변환 완료 후 원본 보관·삭제는 원본을 만든 수집 도구의 정책을 따릅니다. 정규화가 서비스별 비밀을 모두 알아볼 수는 없으므로 생성물을 검토한 뒤 공유하세요.

### 4-2. 관측한 요청을 profile로 확정

`templates/profile.example.json`을 작업 폴더로 복사하고 **실제 관측값**으로 고칩니다. `example.invalid` 예시는 실행 가능한 서비스 API가 아닙니다.

- `allowedOrigins`: 정확한 HTTPS origin. 리다이렉트도 이 목록 안에서만 처리.
- `cookieOrigins`: 쿠키 전송을 허용할 origin 부분집합.
- `probeOperation`: 동일 runner에서 계정 소유권을 확인할 읽기 작업.
- `operations`: method/path, `semantics:read|write`, 인증 필요 여부, 입력 필드 이름, 관측 근거.
- `expected`: HTTP 상태, JSON MIME, 결과·스키마·소유자 확인.

공통 CLI는 **JSON 요청/응답**을 대상으로 합니다. HTML 로그인, multipart 업로드, GraphQL 동적 입력, 서명 발급, 바이너리 다운로드는 관측한 서비스 adapter를 작성하거나 기존 pack을 사용합니다. 일반 profile은 쿠키·비밀번호·토큰을 query/body 입력 필드로 받지 않습니다.

### 4-3. 쿠키·토큰 보호 저장 및 재사용

Windows 입력 모양은 `templates/session-input.example.json`을 참고합니다. 필요한 cookie/header만 사용하고 불필요한 인증 필드는 지우세요. 실제 값은 Git 파일에 채우지 말고 승인된 획득 도구나 비밀 저장소에서 **stdin**으로 넘깁니다.

JSON을 클립보드에 준비한 경우의 PowerShell 예시:

```powershell
Get-Clipboard -Raw | node scripts/session.mjs import --name=example-main --profile=work/profile.json
Set-Clipboard -Value ''
node scripts/session.mjs status --name=example-main
```

`imported:true`는 보호 저장 완료이며 로그인 성공 확인이 아닙니다. 다음 보호 조회가 실제 인증을 검증합니다.

```powershell
node scripts/request.mjs --profile=work/profile.json --operation=owner --session=example-main --output=work/owner-001.json
node scripts/request.mjs --profile=work/profile.json --operation=items --input=templates/items-input.example.json --session=example-main --output=work/items-001.json
```

실행 순서는 저장 세션 잠금 → 보호 owner 조회 → 실제 요청 → 검증 → 서버가 바꾼 쿠키 보호 저장입니다. 출력에는 상태·해시·검증 결과만 남고 원문 응답/계정값/인증 헤더는 나오지 않습니다. 실제 데이터를 소비하려면 [ScopedSession 라이브러리](references/runtime-modules.md)를 사용하는 서비스 adapter에서 필요한 필드만 처리하세요.

기본 저장 위치는 사용자 홈의 `.config/xhr-to-api-only/credentials`입니다. 별도 위치는 `--store-dir=...`로 지정하며, 같은 이름을 공유하는 실행기는 같은 경로를 써야 잠금이 동작합니다. core와 서비스 pack의 저장 형식은 자동 호환으로 간주하지 않습니다.

macOS/Linux 또는 일회성 runner에서는 승인된 provider의 JSON을 pipe로 받아 `--session-stdin`을 사용합니다. 형식은 위 session-input과 같으며 `schemaVersion:1`이 필요합니다. 이 모드의 쿠키 회전은 해당 프로세스 메모리에만 유지됩니다. 재시작 후 갱신값 재사용은 adapter가 OS 보관함에 저장하도록 구현해야 합니다.

### 4-4. 쓰기와 대사

실제 사용자 지시와 확정 payload가 있는 작업만 실행합니다. 예시 profile의 update를 서비스 계약으로 교체한 뒤:

```powershell
node scripts/request.mjs --profile=work/profile.json --operation=update-item --input=work/update.json --session=example-main --execute --journal=work/journal --output=work/update-001.json
```

쓰기 ACK만으로 완료 처리하지 않습니다. 정상 ACK는 `acknowledged_requires_readback`, 결과를 받지 못했으면 `WRITE_RECONCILIATION_REQUIRED`입니다. **같은 키를 재전송하거나 저널을 지워 재시도하지 마세요.** 대상 조회/관리 목록 등 독립 readback을 수행하고 [저널 절차](references/write-and-reconcile.md)로 결과를 대조합니다.

## 5. 오래 쓰기 위한 기준

이 저장소의 노하우는 다음 구분을 유지하는 데 있습니다.

1. `AUTH_MISSING`이면 provider가 없는지, child process에 전달이 빠졌는지 먼저 구분합니다.
2. Chrome 포트가 열리거나 탭이 보여도 연결·로그인·HTTP 재현 성공은 각각 확인합니다.
3. 쿠키 회전, 토큰 재발급, 만료된 로그인 복구, 새 프로세스 재시작은 따로 기록합니다.
4. HTTP 200, 요청 캡처, 코드 존재, 로컬 검사 통과를 실제 서비스 성공으로 확대하지 않습니다.
5. 게시·수정 응답이 끊기면 같은 의도 저널로 대사합니다. 전송이 빨리 실패했다고 미생성을 추정하지 않습니다.
6. 탐색 범위와 미완료 가지를 저장합니다. 한 카테고리나 iframe 반복을 전체 사이트 탐색으로 세지 않습니다.
7. 업로드 성공, 문서 삽입, 공개 접근, 동영상 재생을 각각 확인합니다.

증거 구분과 사례는 [사례 색인](case-studies/README.md), 상세 설명은 [SKILL.md](SKILL.md)에 있습니다.

## 6. 오류가 나면

| 증상 | 먼저 확인할 것 |
|---|---|
| `MODULE_NOT_FOUND` | 실행 중인 사본의 루트에서 `npm ci --ignore-scripts` 실행 여부 |
| `TARGET_ALREADY_EXISTS` | 스킬 설치 대상이 이미 있음. 새 경로/보관 후 설치 |
| `PROVIDER_MISSING` | 저장 이름/폴더/Windows 사용자 및 실제 child runner 전달 |
| `PROTECTED_STORE_PROVIDER_REQUIRED` | Windows 외 OS에서 DPAPI 지속 저장을 요구했는지. stdin/provider 경로 사용 |
| `OWNER_MISMATCH` | 준비한 identity와 서버의 실제 계정/블로그/조직이 같은지 |
| `SESSION_SCOPE_MISMATCH` | 저장 시점 profile과 현재 origin/cookie 범위가 달라졌는지 |
| `MIME_UNEXPECTED` | JSON 대신 로그인 HTML/SPA/오류 페이지를 받았는지 |
| `ACCESS_DENIED` | 403 사실만 확인. 만료·권한·서비스 차단 원인은 추가 증거로 판단 |
| `WRITE_JOURNAL_EXISTS` | 기존 의도와 대사 기록 확인. 자동 재시도 금지 |
| `WRITE_RECONCILIATION_REQUIRED` | 읽기로 실제 대상 상태를 확인하고 동일 저널에 대사 기록 |
| `EEXIST` / output 오류 | 새 출력 파일 이름인지 확인. 기존 영수증 보존 |

## 7. 이 버전의 검증 범위

패키징 과정의 확인 내역은 [verification](verification/README.md)에 기록합니다. 과거 서비스 라이브 결과와 이 저장소의 로컬 설치 확인은 구분합니다. 다른 OS에서 실행했다는 근거가 없으면 지원 설계만으로 실행 검증 완료라고 부르지 않습니다.

원본에 있던 회귀 검사 코드는 service pack 안에 보존했습니다. 설치 명령은 이를 실행하지 않습니다. 필요한 범위가 정해지면 각 pack의 기존 명령을 이용할 수 있습니다.

개인 비공개 사용을 전제로 하며 [NOTICE](NOTICE.md)의 출처와 라이선스 경계를 확인하세요.
