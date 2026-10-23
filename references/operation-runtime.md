# 공통 기능 실행기

## 범위와 진입점

기존 Node 서비스 pack·v1 `profile.operations`·체크리스트를 교체하지 않는 추가 계층이다.
기존 서비스는 [서비스 CLI](service-cli.md)의 `--service` 연결을 사용하면 수동 profile 작성이 필요 없다.
하나의 기능 명세에서 입력 검증, `describe`, `run`, MCP 도구 입력을 함께 만든다.
공통 모듈 검증은 로컬 합성 fixture이며, 개별 사이트의 현재 동작이나 배포 증거가 아니다.

| 파일 | 역할 |
|---|---|
| `lib/operation-registry.mjs` | v1/v2 등록, typed 입력·출력, HTTP/form 및 adapter 연결 |
| `lib/operation-extract.mjs` | JSON·HTML·SSR JSON·text·empty 응답 추출 |
| `lib/prepare-operations.mjs` | 저장 HAR·HTML·번들에서 후보·누락 정리, 네트워크 요청 없음 |
| `lib/operation-health.mjs` | executor를 주입받아 읽기 점검·결과 참조·오류 분류 |
| `lib/operation-flow.mjs` | 순차 결과 바인딩과 실제 페이지 수집·체크포인트 재개 |
| `lib/operation-mcp.mjs` | 동일 registry를 쓰는 MCP stdio 서버 |
| `scripts/playbook.mjs` | `describe/tools/run/check/flow/collect/mcp` |
| `scripts/prepare-operations.mjs` | 오프라인 준비 CLI |

## v2 명세

`templates/profile-v2.example.json`은 실행 가능한 서비스가 아닌 합성 구조 예시다.
`schemaVersion:2`, `serviceId`, `allowedOrigins`, `operations`를 선언한다.
HTTP 기능에는 `origin`, `method`, `path`, `semantics`, `evidence`, `expected.status`가 필요하다.
`expected.mime`을 지정하면 응답 MIME도 확인한다. `transport`는 `http`만 내장되어 있다.

입력은 `{path,query,body}` 그룹을 유지한다. 각 그룹의 필드 정의 예:

```json
{
  "query": {
    "keyword": { "type": "string", "required": true, "minLength": 1 },
    "page": { "type": "integer", "default": 1, "minimum": 1 }
  },
  "body": {
    "variables": {
      "required": true,
      "schema": {
        "type": "object",
        "properties": { "limit": { "type": "integer", "minimum": 1 } },
        "required": ["limit"],
        "additionalProperties": false
      }
    }
  }
}
```

숫자/boolean을 문자열에서 자동 변환하지 않는다. 기본값은 실행 시 복사해 적용하며,
필드 바깥의 `default`와 필드 `schema.default`를 모두 지원한다(바깥 값 우선).
지원하는 JSON Schema 부분집합은 `type`, `properties`, `required`, `items`,
`additionalProperties`(boolean), `enum`, `minimum/maximum`, `minLength/maxLength`,
`minItems/maxItems`, 설명·기본값이다. `$ref`, 정규식, combinator 같은 미지원 키는
등록 시 실패한다. 필드의 `required:true`와 중첩 object의 `required:[...]`를 함께
쓰려면 위와 같이 `schema` 안에 중첩 명세를 둔다. `outputSchema`도 같은 부분집합이다.

`bodyEncoding`은 `json`(기본) 또는 `form`이다. form은 평면 scalar 값만 인코딩한다.
GraphQL은 관측한 문서와 변수 구조를 JSON body 입력/기본값으로 선언하고 `graphql:true`로
오류 envelope를 검사할 수 있다. 임의 문서 발견이나 전체 GraphQL introspection을 제공하지 않는다.

응답 `response` 예:

- JSON: `{ "format":"json", "requiredPointers":["/items"] }`
- SSR: `{ "format":"ssr_json", "ssr":{"key":"__NEXT_DATA__","pointer":"/props/pageProps"} }`
- HTML: `html.items`, `html.fields`, `html.page`, `html.limit`를 선언한다.
  필드에는 `selector`, 선택적으로 `attribute`, `required`, `absoluteUrl`을 쓴다.
  HTML `data`는 레코드 배열이고 페이지 필드는 별도 `pageInfo`로 반환한다.
  필수값 누락·단일 필드의 다중 매칭은 오류다. JS 실행·브라우저 클릭은 하지 않는다.

## 명령

```powershell
# 정의 조회는 네트워크를 사용하지 않는다.
node scripts/playbook.mjs describe --profile=work/site.json
node scripts/playbook.mjs tools --profile=work/site.json
node scripts/playbook.mjs run --profile=work/site.json --operation=search --input=work/input.json
node scripts/playbook.mjs check --profile=work/site.json
node scripts/prepare-operations.mjs --har=work/capture.har --html=work/page.html --bundle=work/app.js --base-url=https://example.invalid --intent=상품검색 --output=work/prepared.json
```

`prepare`는 발견 근거와 정규화 충돌·미구현 범위를 남기는 오프라인 인벤토리다.
후보로부터 경로 변수·커서·본문값을 만들어 실행하거나, 라이브 재현 성공으로 표시하지 않는다.
공식 문서를 자동 검색하거나 브라우저를 자동 조작하는 기능은 이 단계에 포함되지 않는다.

`check`는 `profile.health.checks` 또는 `--plan`의 `{operation,input}` 배열을 순서대로 실행한다.
명시적 점검이 없으면 입력 없이 실행할 수 있는 read만 선택한다. write는 실행하지 않는다.
앞선 결과는 `{"$result":{"operation":"search","pointer":"/items/0/id"}}`로 참조한다.
응답 변경·요청 제한·접속 실패·건너뜀을 구분하며, 점검 없음은 정상으로 표시하지 않는다.
기존 `checklist:strict`의 증거·revision 검사를 대체하지 않는다.

## 흐름과 페이지 재개

```powershell
node scripts/playbook.mjs flow --profile=work/site.json --plan=templates/operation-flow.example.json --checkpoint=work/flow.json
node scripts/playbook.mjs collect --profile=work/site.json --plan=templates/operation-collection.example.json --checkpoint=work/pages.json
```

같은 명령과 체크포인트로 재실행하면 완료한 단계/페이지를 다시 요청하지 않는다.
워크플로 참조는 `{"$result":{"step":"search","pointer":"/items/0/id"}}`이다.
`onMissing:"skip"`은 명시적으로 건너뛰며 부분 결과로 남긴다.

페이지 수집은 `page/cursor/offset/next_url`을 지원한다. `inputPath`는 실행 입력의 위치,
`itemsPointer/nextPointer`는 응답 `data`의 위치다. `idPointer`는 개별 레코드에 상대적이다.
`page/offset`에서 `nextPointer`를 생략하면 선언한 증가폭으로 진행하고 빈 페이지나 예산에서 멈춘다.
커서/next_url은 관측한 `nextPointer`가 필요하다. next_url도 선언된 입력에 전달할 뿐
임의 URL을 별도 요청하지 않는다. HTML의 `pageInfo`가 필요한 경우 adapter에서
`data:{items,next}` 모양으로 합친 뒤 그 경로를 선언한다.

예산은 **호출마다** `maxPages/maxItems/deadlineMs`이며, 전체 누적치는 체크포인트 counters에 남는다.
같은 예산으로 재개하면 그만큼의 다음 분량을 처리한다. 중복 ID 제거·반복 커서/페이지 감지·취소·
403/429 중단을 지원한다. 예산/실패/취소는 부분 결과이며 재개 가능한 상태로 남긴다.
반복 감지는 자연 종료로 부르지 않는다. 페이지 중간의 레코드도 체크포인트에 보존한다.
체크포인트에는 실행 입력·커서·결과가 있으므로 일반 discovery frontier와 혼용하지 않는다.
자동 백그라운드 스케줄러나 사이트에 없는 서버 정렬 기능은 제공하지 않는다.

## 기존 adapter 연결

```js
import { createOperationRegistry } from '../lib/operation-registry.mjs';

const registry = createOperationRegistry(profile, {
  adapters: {
    'existing.search': async (input, { signal }) => ({
      data: await existingClient.search(input.query, { signal }),
      pageInfo: {},
    }),
  },
});
const { data, pageInfo, receipt } = await registry.execute('search', { query: { q: 'example' } });
```

기능에 `adapter:"existing.search"`를 선언하면 위의 명시적 함수 연결을 사용한다.
문자열 경로에서 모듈을 자동 import하지 않는다. 기본 CLI는 공개 HTTP 읽기를 제공하며,
로그인 필요 작업은 기존 서비스 adapter/provider를 라이브러리에서 연결한다.
쓰기도 기존 저널·readback 실행기를 `writeExecutor`에 연결한다. 연결하지 않은 기능은
명시적 오류이며 임의 HTTP 쓰기·재시도로 대체하지 않는다. 기본 CLI flow/collect는 read만 실행한다.

## MCP

클라이언트 command는 `node`, args는 `scripts/playbook.mjs`, `mcp`, `--profile=...`의
절대 경로를 사용한다. npm 배너가 stdio를 오염시키지 않도록 Node를 직접 지정한다.
프로토콜은 [MCP 2025-06-18 stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
부분집합이며 initialize·ping·tools/list·tools/call·요청 취소를 제공한다.
stdin이 끝나면 진행 중인 요청에 기본 1초의 종료 유예를 준 뒤 취소한다.
취소는 반환 대기를 끝내며, signal을 무시하는 외부 실행 자체의 강제 종료를 보장하지 않는다.
HTTP MCP, 동적 도구 추가 알림, 대시보드, 자동 클라이언트 등록은 포함하지 않는다.

검증: `npm run test:operations`. 개별 서비스의 현재 readiness는 해당 체크리스트와
독립 라이브 readback으로 따로 확인한다.
