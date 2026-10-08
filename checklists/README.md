# 기능 체크리스트

서비스를 추가하거나 기능을 구현할 때 `checklists/services/<service>.json`을 갱신한다. [template.json](template.json)은 시작 예시이고, [Inpock 목록](services/inpock.json)은 현재 기능별 코드 위치, CLI 명령, 테스트 파일과 라이브 영수증을 연결한다. 각 기능의 `priority`는 `required`, `conditional`, `optional` 중 하나이며, `applicability`는 `applicable`, `unknown`, `not_applicable` 중 하나다. 범위가 불명확한 기능은 `unknown`과 근거를 기록한다. `not_applicable`에는 비어 있지 않은 `applicabilityReason`을 명시해야 한다. Inpock의 컬렉션은 소스 후보가 있지만 별도 카테고리 API는 확인되지 않았으므로 둘을 같은 완료 기능으로 묶지 않는다.

```bash
node scripts/checklist.mjs --service=inpock
node scripts/checklist.mjs --all --json
node scripts/checklist.mjs --service=inpock --strict
node scripts/checklist.mjs --service=inpock --run-tests --strict
```

`--strict`는 필수 기능에 미충족 항목이 있으면 종료 코드 2를 반환한다. 형식·경로 오류는 종료 코드 1이다. 기본 실행은 **오프라인**이다. 코드 파일·내보낸 이름·CLI 토큰·문법·테스트 파일 존재 여부와 저장된 영수증만 검사한다. 로그인, 네트워크 요청, 외부 쓰기, 테스트 실행은 하지 않는다. `--run-tests`는 명시했을 때만 지정된 로컬 테스트를 실행하고 자격정보 관련 환경변수는 자식 프로세스에 전달하지 않는다. 테스트가 네트워크를 사용하지 않는지까지 이 감사 스크립트가 보증하지는 않는다.

Gemini·Grok 원본 checkout의 기능 점검을 한 명령으로 모으려면 다음을 실행한다.

```bash
npm run check:ai -- --gemini-repo /absolute/gemini-web-xhr-client --grok-repo /absolute/grok-web-xhr-client --strict
```

매번 경로를 넣지 않으려면 저장소 루트의 `ai-providers.local.json`에 한 번 설정한다.
이 파일은 Git에서 제외되며 자격정보를 넣지 않는다.

```json
{
  "schema": "web-api-ai-provider-repos-v1",
  "repos": {
    "gemini": "/absolute/gemini-web-xhr-client",
    "grok": "/absolute/grok-web-xhr-client"
  }
}
```

이후 `npm run check:ai -- --strict`로 점검한다. 다른 설정 파일은 `--config /absolute/file.json`
으로 지정하고, 명령줄의 개별 repo 경로는 설정 파일보다 우선한다.

이 명령은 두 원본의 `scripts/check-features.mjs --json --strict`만 실행한다. 자격정보
환경변수를 전달하지 않으며 네트워크·로그인·외부 쓰기를 수행하지 않는다. 결과는 저장된
영수증과 현재 checkout의 일치 검사이고 현재 원격 인증·기능 실행 증거가 아니다.
원본이 없거나 필수 기능이 남으면 strict 종료 코드는2, 원본 검사 결과가 잘못되면1이다.
원문 child 출력은 전달하지 않고 검증한 기능 ID·상태·건수만 반환한다.

상태는 다음처럼 읽는다.

| 상태 | 의미 |
|---|---|
| `recorded_live` | 저장된 실제 요청·독립 조회 영수증의 필드가 맞고 범위 안의 현재 코드 해시와 일치한다. 기록 시점의 실증이다. |
| `needs_reverification` | 실제 기록은 유효하지만 해당 영수증 이후 관련 코드가 바뀌었다. 변경된 코드의 실제 재실행은 미확인이다. |
| `pending_live` | 코드와 테스트 파일은 있으나 실제 요청·독립 조회 영수증이 없다. |
| `pending_local_test` / `verified_local` | 로컬 기능의 테스트 미실행 / 명시 실행 통과. 외부 API 실증은 아니다. |
| `source_candidate` | UI 또는 공개 소스의 계약 후보만 있다. |
| `unimplemented` / `partial_implementation` | 필요한 코드가 없거나 일부만 있다. |
| `evidence_invalid` | 영수증은 있으나 요청, 계정, 변경, 독립 조회 등 필수 필드가 맞지 않는다. |
| `scope_unknown` | 제품·계정 적용 가능성이 미확인이다. |
| `blocked` | 코드가 준비됐어도 명시된 외부 조건 때문에 라이브 확인을 진행할 수 없다. |

코드 내보내기와 CLI 토큰 검사는 **정적 재고**다. 테스트 파일 존재는 테스트 통과가 아니다. `sourceEvidence`는 영수증 존재를 표시할 뿐 live 통과에 사용하지 않는다. 기존 Inpock 로그인·발행 영수증은 전용 검증기가 실제 HTTP 상태, owner 일치, POST 횟수, 관리/익명 공개 조회, 공개 화면과 코드 해시를 대조한다. `ok:true` 한 줄, no-op 저장, 코드 존재 또는 모의 테스트만으로 `recorded_live`가 되지 않는다.

새 서비스의 라이브 영수증에는 `web-api-capability-receipt-v1`을 쓸 수 있다. 조회는 다음과 같이 owner 바인딩된 HTTP 영수증을 기록한다.

```json
{
  "schema": "web-api-capability-receipt-v1",
  "service": "example",
  "capabilityId": "auth.owner",
  "checkedAt": "2026-10-05T00:00:00.000Z",
  "secretsPersistedInEvidence": false,
  "authenticated": true,
  "ownerVerified": true,
  "request": {
    "method": "GET", "origin": "https://example.com", "path": "/v1/me",
    "httpStatus": 200, "mime": "application/json", "responseBytes": 123, "browserUsed": false,
    "ownerMatched": true, "checkedAt": "2026-10-05T00:00:00.000Z"
  },
  "implementation": { "lib/example-auth.mjs": "<SHA-256 of the file at verification time>" }
}
```

쓰기 영수증은 `http-write-v1` 검증기와 함께 manifest에 정확한 API `origin`, `writeSent:true`, `postAttempts:1`, 서로 다른 `beforeHash`·`afterHash`(두 상태의 SHA-256), `writeReceipt`의 실제 method/path/2xx status/`application/json` MIME/시각, `readback`의 독립 GET method/path/200 status/`application/json` MIME/시각, `ownerMatched:true`, `fieldsMatched:true`, `stateChanged:true`, 빈 배열이 아닌 `matchedFields`를 기록한다. 실제 저장 응답 코드가 알려진 서비스만 manifest에 `acceptedStatuses:[200,201]`처럼 지정한다. 생략하면 모든 2xx를 허용한다. `implementation`에는 manifest의 `hashPaths`에 기재한 파일 해시를 넣는다. 실제 서비스 요청 전에 원본과 대상 계정, 읽기 전·후 상태를 확인하고 비밀을 기록하지 않는다. 영수증은 감사 가능한 기록일 뿐, 오프라인 검사만으로 현재 원격 상태를 새로 증명할 수는 없다.

소스 후보만 있는 새 서비스는 `sourceEvidence`에 `schema:"web-api-source-candidate-v1"`, `classification:"source_candidate"`, `contracts:[{method,path,...}]`를 담은 JSON 파일을 연결할 수 있다. 소스 후보는 필수 기능 통과에 쓰이지 않는다.

비로그인 공개 조회는 별도 `http-public-read-v1` 검증기와 `web-api-public-read-receipt-v1` 영수증을 쓴다. `anonymous:true`, `credentialsUsed:false`, `secretsPersistedInEvidence:false`, `schemaVerified:true`, `expectedResultVerified:true`와 정확한 method/origin/path, HTTP 200, MIME, 응답 바이트 수, 시각, `browserUsed:false`를 기록한다. 기본 MIME은 `application/json`이다. 관찰한 HTML 조각이나 스트리밍 응답은 manifest에 정확한 `mime`을 지정하고 비즈니스 데이터를 검증해야 한다. 조회용 POST는 `method:"POST",readOnly:true`가 필요하다.

같은 기능에 통화 등 보조 조회가 꼭 필요하면 evidence 항목의 `companionReads`에 `{key:"currencyRequest",origin,path,mime}`처럼 선언한다. 검증기는 영수증의 해당 조회도 독립적으로 검사한다. Shopify 상품 Ajax의 JSON 본문은 `text/javascript` MIME으로 관찰됐으므로 실제 MIME을 그대로 지정한다.

`contractProvenance`는 실제 UI XHR인 `browser_xhr_observed`, 공식 API 문서인 `first_party_documented_api`, 배포된 자사 JS에서 확인한 `first_party_bundle_contract`를 구별하고 `sourceURL`을 연결한다. JS 계약에는 `sourceSha256`도 필요하다. SSR 상품 문서, 텔레메트리, 후보 엔드포인트, MIME/상태만 맞는 응답은 공개 상품 API 실증으로 기록하지 않는다. 체크리스트 자체는 오프라인 필드·해시 검사이므로 원 출처와 실제 실행은 리뷰와 독립 재생으로 확인한다.

공식 정적 상품 피드는 `first_party_documented_feed`로 표시하고 실제 ZIP/CSV MIME을 선언한다. `http-credentialed-read-v1`은 API 키·앱 OAuth·서명·Basic 인증으로 읽는 상품 API에 사용한다. 고객 프로필의 owner 조회를 꾸며 내지 않고, 프로세스 메모리의 서비스/origin 바인딩·HTTP 결과·상품 스키마·기대 결과를 검증한다. 자격 정보가 없으면 영수증을 생성하지 않고 라이브 미확인으로 남긴다. `commerce-collection-v1`은 원 HTTP 조회와 실제 공통 실행기, JSON/CSV 독립 읽기 일치, 전체/샘플 건수, 결과 해시와 구현 해시를 함께 검사한다. 테스트가 정의되지 않은 항목은 `not_run`이며 테스트 실패로 표시하지 않는다.
