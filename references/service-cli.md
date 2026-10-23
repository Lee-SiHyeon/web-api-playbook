# 기존 서비스를 공통 CLI로 실행하기

이 계층은 기존 클라이언트를 실제 함수로 연결한다. 새 서비스의 API를 추정하거나
저장된 예시 응답을 라이브 성공으로 반환하는 계층이 아니다. 기존 `--profile` 방식도 유지한다.

## 목록과 실행

```powershell
npm run services
node scripts/playbook.mjs describe --service=coupang-retail
node scripts/playbook.mjs describe --service=retail-amazon --operation=product
node scripts/playbook.mjs run --service=ably --operation=categories
node scripts/playbook.mjs run --service=retail-amazon --operation=search --input=examples/operation-services/amazon-search.json
node scripts/playbook.mjs run --service=coupang-retail --operation=retail-search --input=examples/operation-services/coupang-search.json
```

`list`는 연결된 서비스, `list --all`은 기존 체크리스트의 미연결 범위도 보여 준다.
`connected`는 실행기 연결이지 로그인·사이트 전체 동작 보장이 아니다.
문서/집계용 체크리스트는 `scope_only`, 구현 없는 사이트는 `not_connected`로 분리한다.
실행할 수 없는 placeholder 도구를 만들어 목록 수를 늘리지 않는다.

## 현재 읽기 점검

```powershell
node scripts/playbook.mjs check --service=retail-amazon
node scripts/playbook.mjs verify --service=oliveyoung-public --progress --timeout=30000
node scripts/playbook.mjs verify --all --include-unconnected --progress --timeout=30000 --output=work/services-current.json
```

`verify`는 각 서비스의 관측 근거가 있는 기본 named read를 실행한다.
검색에서 얻은 ID를 다음 상세/리뷰 입력으로 넘기는 점검도 포함할 수 있다.
모든 기능/모든 페이지가 검증됐다는 뜻은 아니며 결과의 **정확한 operation 목록**이 범위다.
단순 로컬 상태와 라이브 읽기는 구분한다. `liveReadVerified:true`에는 선언한 live read와
실제 네트워크 사용 근거가 모두 필요하다. 데이터 원문 대신 결과 구조·개수·hash를 기록한다.

- `PROVIDER_MISSING`/인증 누락: 준비된 해당 서비스 provider가 필요하다.
- `REAUTH_REQUIRED`: 기존 세션이 만료됐다. 자동 재로그인은 하지 않는다.
- `no_checks`: 채널/상품/광고주 ID 등 필수 입력이 없어 기본 점검을 만들 수 없었다.
- CDP 필요 작업: 실제 페이지 연결이 필요하다. HTTP 작업으로 조용히 바꾸지 않는다.
- TLS 오류, 403, 429와 스키마 변경: 실제 실패로 남긴다. 403/429 후 같은 서비스의 후속 점검은 재전송하지 않는다.

검증에서 미완료가 하나라도 있으면 CLI는 exit 1을 반환하되 전체 결과 파일을 남긴다.
라이브 성공, 로컬 fixture 통과, 전체 체크리스트 readiness는 서로 다른 사실이다.
보고서에는 공통 실행기와 각 operation evidence가 명시한 소스 파일 hash 및 실행 중 변경 여부를 담는다.
이는 모든 transitive dependency의 완전한 fingerprint는 아니다.

## 실제 검색 → 상세 workflow

```powershell
node scripts/playbook.mjs flow --service=retail-amazon --plan=examples/operation-services/amazon-detail-flow.json --checkpoint=work/amazon-flow.json
```

첫 검색의 실제 ASIN을 다음 단계로 전달한다. 체크포인트는 실행 입력과 결과를 포함한다.
아마존의 상세 작업은 기존 보호 retail session이 필요하다. 없으면 검색 단계만 완료되고
`AMAZON_RETAIL_SESSION_MISSING` 부분 결과가 남는다. 공개 검색 성공을 상세 성공으로 확대하지 않는다.
동일 plan으로 재개하면 완료된 단계는 다시 실행하지 않는다. 종료·부분 결과 의미는
[operation runtime](operation-runtime.md)을 따른다.

## 기존 provider 재사용

기본 실행기는 서비스가 원래 사용하던 provider를 지연 로드한다. 목록·설명 조회만으로
provider를 열거나 네트워크 요청을 보내지 않는다. `--session`과 `--store-dir`은 이를 지원하는
서비스의 기존 이름/위치를 선택하며, 서로 다른 pack의 저장 형식을 자동 변환하지 않는다.
카탈로그 API credentials는 원래 provider가 없으면 library의 `credentialProvider` 또는
선택한 서비스에 한정된 `--credentials-stdin`으로 공급할 수 있다.

stdin envelope는 `{ "service":"선택한 ID", "credentials":{...기존 클라이언트 필드...} }`다.
계정 값은 명령행/일반 profile에 넣지 않는다. MCP의 stdio와 credentials stdin은 함께 사용하지 않는다.
저장 계정의 새 로그인, credential 복사, 갱신, 게시·수정·링크 발급은 검증에서 수행하지 않는다.
서비스별 쿠키 회전의 지속 저장 여부는 기존 adapter 범위를 확인한다.

## 구성과 테스트

`lib/service-operations/{commerce,retail,native,travel,extras}.mjs`는
`definitions` 배열을 제공한다. 각 정의는 v2 profile, `createAdapters`, `verificationChecks`를 가진다.
`index.mjs`는 중복 ID/alias 및 read binding을 검증하고, `verify.mjs`는 실제 읽기 결과를 모은다.

```powershell
npm run test:services
npm test
```

MCP도 동일한 연결을 사용한다: `node scripts/playbook.mjs mcp --service=ably`.
이 변경은 로컬 CLI 연결이며 Vercel 배포나 원격 서버 IP의 접근 가능성을 증명하지 않는다.
