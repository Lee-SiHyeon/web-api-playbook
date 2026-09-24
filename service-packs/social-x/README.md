# sns-X — XHR API-only

> 아래는 원본 service-pack의 관측 시점 기록이다. 2026-09-24에 추가한 DPAPI 세션·보호 계정 조회·
> 브라우저 없는 transaction ID 생성·조회 CLI는 저장소 루트의
> [웹 로그인 사용법](../../references/web-login-usage.md#x-웹-세션과-수집기)을 따른다.
> 루트에서 `node scripts/x-read.mjs sama 3`으로 실행한다. 이 pack의 기존 쓰기 CLI에는 자동 연결하지 않았다.

Node.js 22+의 직접 HTTP 클라이언트. 프로필, 원본 게시물 목록, 게시물 상세, 일반 텍스트 글쓰기를 제공합니다. 반복 실행에 브라우저 자동화 라이브러리를 사용하지 않습니다.

## 현재 검증 범위

- 기존 계정의 Gmail 코드 인증 및 X 브라우저 로그인 성공.
- `UserByScreenName`, `UserOriginalsTimeline`: 로그인된 브라우저에서 실제 요청과 타임라인 JSON을 관찰함.
- `TweetDetail`, `CreateTweet`: 2026-09-22 사용자 요청으로 실제 HTTP 발행 및 상세 readback 성공. [발행글](https://x.com/shyeon0528/status/2102165417796202582).
- 독립 Node HTTP 프로세스에서 프로필·타임라인 200 JSON, 글쓰기 200 및 작성자·본문 readback 확인. 쿠키만 전달한 최초 요청은 404였고, 현재 캡처의 transaction ID·클라이언트 헤더·features를 함께 전달한 실행은 성공함. 어느 한 필드만 원인인지는 분리 검증하지 않음.
- 이번 실행은 브라우저가 세션과 요청 입력을 준비한 뒤 HTTP로 재실행한 일회성 검증. 자동 세션 갱신이나 브라우저 없는 transaction ID 생성은 미구현. 전체 무인 API-only 완성으로 해석하지 않아야 함.
- `contracts/x.json`은 날짜가 있는 계약 스냅샷. X의 비공식 내부 API 변경 또는 인증 정책에 따라 갱신이 필요함.

## 실행

```powershell
npm test
'{"operation":"profile","handle":"sama"}' | node src/cli.mjs
'{"operation":"timeline","handle":"elonmusk","pages":2}' | node src/cli.mjs
'{"operation":"detail","handle":"sama","postId":"2100351958167220547"}' | node src/cli.mjs
```

호출 프로세스에 `X_AUTH_TOKEN`, `X_CSRF_TOKEN`, `X_BEARER_TOKEN`을 승인된 비밀정보 공급자로 주입해야 합니다. 쿠키를 저장소, 명령 인수, 로그 또는 평문 파일에 저장하지 마세요. 브라우저 쿠키 DB 추출이나 자동 로그인 우회는 구현하지 않습니다. 브라우저 로그인만으로 CLI 인증이 자동 연결되지는 않습니다.

## 글쓰기

```powershell
# 검토용: 네트워크 발행 없음
'{"operation":"publish","text":"검토한 게시물 본문","expectedHandle":"YOUR_HANDLE","expectedUserId":"YOUR_NUMERIC_ID","jobId":"unique-job-001"}' | node src/cli.mjs
# 실제 발행: 위에서 검토한 동일 JSON 입력에 --execute 추가
```

`--execute`가 있을 때만 CreateTweet POST를 보냅니다. `expectedHandle`과 숫자 ID는 공개 프로필 일치 검증용이며, 인증 토큰 소유자를 증명하는 보호된 계정 조회는 아직 구현되지 않았습니다. 따라서 실행 전에 세션 공급자에서 의도한 계정인지 확인해야 합니다. 생성된 게시물은 ID·작성자·본문을 별도 상세 API로 읽어 확인합니다.

일반 텍스트만 지원합니다. `twitter-text`로 가중 글자수와 URL 길이를 검증합니다. 이미지 업로드, 장문, 스레드, 수정·삭제는 미지원입니다. readback은 HTML entity 및 t.co의 expanded URL을 정규화한 뒤 원문과 대조합니다.

`runtime/<jobId>.json`을 독점 생성해 동일 작업 ID의 재발행을 차단합니다. POST는 자동 재시도하지 않습니다. 응답 유실은 `unknown_needs_review`, 생성 후 조회 실패는 `created_needs_review`입니다. 재실행하려고 journal을 삭제하거나 새 ID를 만드는 대신 실제 계정에서 결과를 먼저 확인하세요. 원문·쿠키는 journal에 저장하지 않습니다.

## 계약과 제한

`npm run discover`는 X 공개 소스에서 쿼리 ID와 feature metadata만 갱신하며 스크립트와 인증값을 저장하지 않습니다. 관찰된 요청 경로는 `https://x.com/i/api/graphql/...`입니다. 누락 feature는 임의로 false 처리하지 않습니다. 한 flag의 false 값은 2026-09-22 로그인된 실제 요청에서 확인한 값입니다. 새 소스 스냅샷의 IDs는 다시 브라우저 요청과 대조해야 합니다.

일부 요청에서 X가 `x-client-transaction-id`를 요구할 수 있습니다. 라이브러리 및 CLI에 요청별 공급자 인터페이스가 있습니다. 현재 요청 캡처의 일회성 전달은 라이브 검증했으며 장기 공급자·토큰 생성기는 미구현입니다. 캡처 토큰은 프로세스 메모리에서 경로별 한 번만 소비합니다. 401/403은 인증 오류, 429는 rate limit으로 명확히 실패합니다. 로그인 HTML을 데이터로 사용하지 않습니다.

## 검증된 일회성 전달 경로

`node scripts/session-run.mjs runtime/job.json`은 127.0.0.1 임의 포트에서 3분간 대기합니다. 명시한 작업 파일만 실행하며 발행 작업은 시작 자체가 실제 실행 선택입니다. 로컬 폼의 password 입력에 승인된 공급자가 인증 envelope를 메모리로 전달합니다. Host·Origin·일회성 nonce를 검사하고 인증값을 파일이나 콘솔에 저장하지 않습니다. 결과는 gitignore된 `runtime/latest-result.json`에 저장됩니다.

선택적인 `requests` 배열은 현재 캡처의 `{url,method,transactionId}`이며 쓰기는 `{body,browserAborted:true}`도 필요합니다. 캡처한 쓰기는 브라우저의 Request 단계에서 취소되었음을 호출자가 네트워크 취소 이벤트로 확인해야 합니다. 플래그만으로 취소가 증명되지는 않습니다. 브라우저의 취소 여부가 불명확하면 전달하지 않습니다. 발행 본문과 media·reply 범위를 작업과 대조한 뒤 별도 HTTP 요청으로 실행합니다. 생명주기가 끝나면 브라우저 메모리의 캡처 데이터도 지워야 합니다.

브라우저 런타임의 DOM/XHR 관찰은 입력 준비 단계에만 사용했습니다. 실제 글쓰기 요청은 Request 단계 `net::ERR_ABORTED`, canceled=true를 확인했고 Node가 한 번 발행했습니다. 공개 원문 목록은 고정글 순서를 그대로 최신으로 취급하지 않고 작성 시각으로 정렬해 최근 5개를 골랐습니다.

## 토큰 및 캡처 도구 연동

`X_SESSION_PROVIDER_MODULE`에 신뢰하는 로컬 JS 모듈의 절대경로를 지정하면 CLI가 공급자를 로드합니다. 이 경로는 실행 코드이므로 외부 캡처 데이터가 경로를 정하게 하면 안 됩니다. 모듈은 아래 default export를 구현합니다.

```js
export default {
  async getSession({origin}) {
    // 승인된 기존 메모리 broker/OS 비밀 저장소에서 읽어 반환
    return {authToken, csrfToken, bearerToken, origin, expiresAt};
  },
  async getTransactionId({origin, method, path}) {
    // 선택 사항: 검증된 공급자로 이 요청에 맞는 새 ID 제공
    return transactionId;
  },
  async close() { /* 공급자가 소유한 비밀정보와 자원 해제 */ }
};
```

`expiresAt`은 선택 사항이며 공급자가 알고 있는 만료 시각만 전달합니다. 존재할 때 이미 만료된 세션을 차단합니다. 서버 세션의 자동 갱신을 구현했다는 뜻은 아닙니다. `getTransactionId`가 브라우저를 사용한다면 전체 실행은 `headless_assisted_http` 등으로 별도 기록해야 합니다. 응답 receipt의 pure_http는 이 클라이언트의 전송 구간만 뜻합니다.

`auth_token`은 사용자 세션, `ct0`/`x-csrf-token`은 CSRF 짝, Bearer는 클라이언트 인증 헤더, transaction ID는 요청별 입력입니다. 이들을 같은 API key로 취급하지 않습니다. 개발자 OAuth 토큰을 내부 GraphQL 세션 쿠키 대신 넣는 방식은 지원하지 않습니다.

현재 환경에서 `ncapture`라는 실행 도구나 MCP는 확인되지 않았습니다. 특정 NCapture 제품의 프로토콜을 추측해 어댑터를 만들지 않았습니다. 기존 네트워크 캡처 도구가 확인되면 계약 메타데이터만 저장하고 인증값은 위 공급자로 메모리 전달하는 방식으로 연결합니다. 원본 HAR에는 쿠키·인증 헤더·POST 본문이 들어갈 수 있으므로 저장소에 넣지 않습니다. 캡처 성공과 브라우저 없는 HTTP 재실행 성공은 별도 검증합니다.

수집 결과는 `{items,nextCursor,receipts,fullTimeline:false}`입니다. 페이지 전체 항목을 반환해 다음 cursor로 이동할 때 초과 항목이 유실되지 않습니다. 중복 게시물과 반복 cursor를 제거합니다. 인용 대상·광고를 저자의 원본 글로 잘못 수집하지 않으며 없는 조회수는 null입니다.

Google Drive 및 판단기는 기존 프로젝트에서 이 패키지의 결과를 받아 연결할 수 있으며 이 저장소에는 Drive 업로드나 자동 발행 스케줄이 포함되지 않습니다.

## Social reactions
X conversation/reply collection and Reddit OAuth read client: [contracts and live evidence boundaries](docs/social-reactions.md).
