# 전수조사와 브라우저 증거 연결

등록 서비스의 모든 기능, 저장 영수증, 로컬 테스트와 저장소 실행기 후보를 함께 조사한다. 새 CLI는 기존 capability 판정기를 호출하며, 서비스별 HTTP 클라이언트나 인증 방식을 변경하지 않는다.

## 실행

```powershell
npm run audit:playbook -- --output-dir=work/audit-new
npm run audit:playbook -- --output-dir=work/audit-with-tests --run-tests
npm run audit:playbook -- --output-dir=work/audit-strict --run-tests --strict
```

상위 폴더는 존재해야 하고 출력 폴더는 새 이름이어야 한다. 기존 결과를 덮어쓰지 않는다. `audit.json`은 상세 기계 판독 결과, `audit.md`는 모든 기능의 상태표다. `--strict`는 필수 조건이 남으면 exit 2, 읽기·형식 오류는 exit 1이다. 기본 exit 0은 조사 완료이며 모든 기능의 동작 성공을 뜻하지 않는다.

`--run-tests`는 선언된 테스트 파일을 중복 없이 한 번씩 실행한다. 서비스 CLI나 package script를 자동 실행하지 않는다. 테스트 프로세스는 제한된 환경변수를 받지만 네트워크·파일·DPAPI 접근을 차단하는 sandbox는 아니다. 검토된 저장소의 로컬 테스트에 사용하고, 테스트가 네트워크를 사용하지 않았다는 주장을 이 도구만으로 하지 않는다.

## 조사 범위

- `checklists/services/*.json` 전체를 읽고 기존 검사기로 코드·export·CLI 토큰·로컬 테스트·증거 해시와 상태를 확인한다. 파일별 오류를 모아 다른 서비스 조사를 계속한다.
- 저장소에서 `work`, `node_modules`, `.git`, runtime·private·secret 폴더와 심볼릭 링크를 제외하고 소스 파일을 색인한다.
- Node `.mjs`의 root scripts 위치, `process.argv`, 직접 `node file.mjs` package 명령을 실행기 후보로 합친다. 확장 manifest의 service worker·background/content script와 PowerShell의 명시적 로컬 JavaScript 참조는 `runtimeEntrypoints`에 별도로 기록한다. 다른 언어도 `sourceAssets`와 browser/UI 문자열 검사에 포함하지만 임의 shell·위임 명령의 전체 호출 그래프는 해석하지 않는다.
- 매니페스트에 없는 실행기, 참조 파일 부재, browser/CDP 문자열, 복수 증거 그룹을 검토 후보로 남긴다. 일반 공통 도구도 이 목록에 들어가므로 후보 수를 누락된 사업 기능 수로 해석하지 않는다.
- 서비스 팩의 API catalog는 파일별 저장 항목 수다. 복제된 catalog의 숫자를 고유 계약 수로 합하지 않는다.

`allManifestAuditsCompleted`는 등록 기능의 판정 완료, `allReferencedFilesPresent`는 참조 파일 존재, `allRequiredGatesPassed`는 필수 조건 충족을 각각 뜻한다. 계획된 eBay/Inpock 구현·테스트가 없으면 이를 분리해 표시한다. 증거 그룹은 기존 판정기의 “하나의 유효한 그룹이면 통과” 의미를 유지한다. 자동으로 AND 조건으로 바꾸지 않는다.

`recorded_live`는 기존 영수증을 현재 소스와 대조한 기록이다. 현재 원격 결과, 세션·owner 상태, 모든 페이지·옵션의 범위까지 검증한 것이 아니다. 이번 직접 HTTP 표본은 별도 파일에 시각·상태·MIME·내용 검증·인증 방식과 다섯 상태를 기록한다. 전체 사이트의 새 라이브 검증으로 승격하지 않는다.

실행 클라이언트와 오프라인 검증 도구의 변경은 구분한다. 일본·아마존·해외 리테일 검증기는 과거 영수증의 실행 코드 및 응답 해시를 그대로 검사하며, 명시한 validator/verifier 파일의 해시 차이는 `verificationToolProvenance`에 남긴다. 현재 판정기로 증거의 계약도 다시 검사한다. 검증 도구만 바뀐 경우는 새 HTTP 실행도, 실행 클라이언트 변경도 아니다. 클라이언트·CLI·증거 본문 변경은 계속 검증 실패다. `verify-overseas-retail.mjs`도 읽기 전용이며 기존 proof의 해시·시각을 다시 쓰지 않는다.

등록 목록 밖에도 유지 실행기가 있을 수 있다. LinkPrice와 MyRealTrip의 미등록은 미구현 판정이 아니며, Google Trends·Threads의 `pending_live`에는 저장 재생 증거를 판정하는 validator의 미지원 범위가 포함된다. 기능별 경로와 상태 해석, 현재 HTTP 표본 및 교정 내용은 [2026-10-15 경로 재감사](../verification/playbook-path-audit-2026-10-15/README.md)에 기록한다.

쿠팡 일반 검색은 `coupang-retail/catalog.search`가 `scripts/coupang-retail-session.mjs search`를 가리킨다. `coupang-public.mjs retail-search --anonymous`는 별도의 cookie-free Document 진단이다. 같은 `/np/search`라도 RSC 헤더·응답 MIME·세션 적용이 다르므로 진단의 403을 검색 기능 전체의 결과로 합치지 않는다. 로컬 세션 preflight 거부는 HTTP 요청 0건이며 서버 응답과 구분한다. [2026-10-15 정정과 실제 HTTP 결과](../verification/coupang-recheck-2026-10-15/README.md).

## REA와 agent-browser 적용

```powershell
npm run evidence:browser -- --format=har --input=work/local.har --output=work/har-summary.json
npm run evidence:browser -- --format=rea --input=work/rea-capture.json --output=work/rea-summary.json
```

`lib/browser-evidence.mjs`가 기존 HAR 정제기와 REA 시나리오 캡처 형식을 연결한다. REA는 [고정 commit의 계약](https://github.com/morluto/rea/blob/e45eb33f03deaa2ab047f876736ccaa22498448f/docs/browser-scenario-contract.md)을 참조한 좁은 import adapter다. 요청·응답·본문의 transaction/sequence 연결, 본문 길이와 SHA-256, 행동 인덱스, 누락·완료 상태를 검사한다. 요청 본문의 JSON 구조와 form 필드도 남기며 헤더값·본문값·원본 transaction ID는 출력하지 않는다.

REA 전체 런타임이나 전체 schema 검증기를 이식한 것은 아니다. upstream Evidence envelope 인증, 원본 wire bytes 출처, 사이트 동등성은 확인하지 않는다. 실제 REA 프로세스 출력과의 통합 실행은 미검증이며 import 회귀는 합성 fixture다. DOM·접근성·화면은 artifact 상태만 가져오므로 시각 비교가 수행됐다고 주장하지 않는다. 생략 집계가 불일치하거나 본문이 없으면 gap을 남긴다.

HAR 비교는 정제된 method·route·필드·응답 schema의 차이만 다룬다. 값이 다른 동일 schema는 `same_contract_shapes`일 수 있고 `websiteEquivalent`는 항상 `unknown`이다. HAR가 본문을 내보내지 못한 경우 빈 본문으로 취급하지 않는다. 경로·host·필드명도 사용자 정보를 포함할 수 있으므로 정제 출력은 공유 전에 검토한다. 실제 인증 캡처를 Git에 직접 넣지 않는다.

## Rust 브라우저 fixture

검토한 [agent-browser 0.39.1](https://github.com/vercel-labs/agent-browser/blob/dac13bb87468fe9d74a040d862720f6cc17a9565/README.md)의 사전 빌드 Rust 바이너리를 선택적으로 쓴다. 저장소의 기본 dependency, 전역 설치, 브라우저 엔진 교체는 아니다. npm install script를 실행하지 않는다.

```powershell
npm install --prefix work/browser-tools --no-save --ignore-scripts agent-browser@0.39.1
npm run verify:browser-fixture -- --agent-browser=work/browser-tools/node_modules/agent-browser/bin/agent-browser-win32-x64.exe '--browser=C:/Program Files/Google/Chrome/Application/chrome.exe' --output=work/browser-fixture-new.json
```

runner는 바이너리 버전을 확인하고 명시한 브라우저를 새 임시 프로필·고유 namespace로 실행한다. 기존 사용자 브라우저에 attach하지 않는다. 로컬 서버의 검색·다음 페이지·옵션·redirect·iframe·503·유한 SSE·오디오를 DOM 버튼 클릭으로 발생시키고 독립 Node fetch와 합성 상품값을 비교한다. 이것은 사이트 로그인이나 실제 음성 생성 검증이 아니다. 자동 새 프로필은 로컬 합성 fixture에만 사용한다.

동작 전에 HAR 수집을 켜고 행동 전후 request 수를 남긴다. 이 창은 initiator 인과관계 증명이 아니다. pinned HAR exporter의 initiator/redirect ancestry 부재와 본문 누락은 별도 gap이다. 302 hop 보존 여부도 core 행동 성공과 분리한다. timeout은 `blocked_runtime`으로 취급하고 같은 서비스 세션 만료로 판단하지 않는다. close가 확인되지 않으면 임시 파일 삭제 성공으로 표시하지 않는다.

2026-10-15 로컬에서는 바이너리의 버전·도움말은 실행됐지만 Canary와 Stable 양쪽의 첫 `open about:blank`가 데몬의 `outcome_unknown` 응답으로 실패했다. 이 Rust runner의 운영 사이트 캡처는 0건이다. 조사 CLI, 정제 adapter, 로컬 fixture runner와 회귀는 적용됐지만 Rust 브라우저 실증은 통과하지 않았다. 후속 쿠팡 재검증에서는 기존 Chrome 확장/CDP 연결로 정상 RSC 200을 관측했으며 이는 별도 경로다. 상세 결과는 [2026-10-15 전수조사](../verification/playbook-audit-2026-10-15/README.md)에 기록한다.

## 출처와 라이선스

- REA: `morluto/rea`, MIT, `e45eb33f03deaa2ab047f876736ccaa22498448f`. 계약과 [event/body schema](https://github.com/morluto/rea/blob/e45eb33f03deaa2ab047f876736ccaa22498448f/src/domain/browserScenarioCaptureValues.ts)를 참고했다. upstream 코드를 복사하지 않았다.
- agent-browser: `vercel-labs/agent-browser`, Apache-2.0, `dac13bb87468fe9d74a040d862720f6cc17a9565`, npm `0.39.1`. 바이너리는 ignored `work/`에만 설치했으며 재배포하지 않는다.
- npm integrity: `sha512-0zdIq0v2r9Gio7K5wIe/e2W9nyLoVC6tUGpGV+btuynBQT9aCgOk5IEIyK+6OtfKRzQjp96DQ/3akBqxccigTQ==`.
- mitmproxy2swagger·oasdiff·Crawlee·Hurl·Katana 등은 [조사 문서](browser-analysis-rust.md)의 검토 후보이며 이번에 일괄 설치하거나 운영 호출하지 않았다.
