# Coupang 일반몰의 Vercel 이관 실검증 — 2026-10-17

이 문서는 Playbook의 Windows 실검증을 Vercel 성공으로 확대하지 않기 위한
외부 소비자 사례다. [구조화 증거](../verification/lifehack-coupang-retail-vercel-2026-10-17.json)와
[기존 Windows HTTP 갱신 계약](coupang-retail-renewal-2026-10-15.md)을 구분한다.

## 완료한 경계

- Lifehack 소비자 SHA `fd09677c8c5335dde9ec92d95ca1dd3198df08d7`의 운영 배포와
  `lifehackailab.com` alias를 readback했다. Playbook 기준 SHA는
  `4cc2263948f549931a9ad706fe8a3561e1a035dd`다.
- 새 encrypted retail vault, service-role RPC, DB lease/fence와 atomic catalog /
  session / receipt 저장 migration을 실제 Supabase에 적용하고 별도 읽기로 검증했다.
  기존 Partners vault와 발급기는 변경하지 않았다.
- `/api/cron/hub-coupang-retail`은 Vercel에 15분 간격으로 등록됐다. native Run 호출은
  실제 production route, durable start row, DB lease와 Vercel Sandbox browser에 도달했다.
  PC 수집기나 PC 예약 작업을 추가하지 않았다.

## 실패한 경계 — 수집 성공 아님

첫 수집은 검색 Document 200 이후 가격순 정렬 응답을 얻지 못했다. 별도 read-only
Vercel Sandbox 진단에서는 검색 Document **200 → 403**, 정렬 control 0개가 관측됐다.
요청은 6개였고 원래의 allowlist가 차단한 host는 없었다. 브라우저의 첫 200은
usable UI, 로그인, cookie handoff, 독립 HTTP RSC 성공을 증명하지 않았다.
403의 정확한 정책 원인은 미확인이다. PC 관리자 권한이나 쿠키 개수 하나로 단정하지 않는다.

실제 retail catalog 저장은 **0개**, encrypted retail session은 **없음**이다.
관측한 거부 뒤 운영 상태를 `blocked`로 보류했다. 기존 수집 receipt는 덮어쓰지 않고
별도 operator-hold 근거를 남겼다. 자동으로 새 브라우저/방문자/프록시를 만드는 재시도는 없다.
독립 RSC 조회, 다음 invocation의 세션 재사용, 상품 저장, 파트너 링크 발급은 여전히 미검증이다.

## 이 사례에서 보강한 진단 규칙

1. 첫 `page.goto()`의 status만 보지 않는다. 이후 검색 Document의 401/403/418/451을
   추적하고 selector timeout보다 실제 거부를 우선한다. 뒤의 200이 앞의 거부를 지우면 안 된다.
2. 새 실패가 cooldown에 들어간 것은 성공한 Cron이 아니다. 오류가 없는 busy/backoff skip과
   구분하고, 새 실패는 HTTP 503 및 실패 receipt를 유지한다.
3. Cron 등록, manual trigger ACK, HTTP 200, source 성공, 실제 accepted row, 다음 실행의
   세션 재사용을 각각 검증한다. 첫 배포의 Cron 200/receipt는 수집 성공으로 사용하지 않는다.
4. Lifehack 자체의 anonymous `/api/health`는 별도 Vercel challenge 429였다.
   이것을 쿠팡의 403이나 쿠키 만료와 같은 장애로 합치지 않는다.
5. GitHub Actions는 결제/사용 한도 때문에 job steps가 시작되지 않았다. 로컬 검사와
   Vercel build 성공을 GitHub CI 성공으로 보고하지 않는다.

오류 처리 보강 SHA `7cef72ea4b42a78b33147c79920fd229a8bd3058`도 운영 READY와
domain alias를 readback했다. 로컬 전체 테스트 1,115개, typecheck, build 및 cloud schema
preflight가 통과했다. 보류된 자체 Cron을 한 번 호출하여 `HTTP 503
COUPANG_RETAIL_BOOTSTRAP_HTTP_403`을 확인했고, revision 3·원본 source receipt·상품 0개가
유지됐다. 이 확인은 source 재시도가 아니라 차단 상태의 조기 반환 검증이다.

이 결과는 기존 Windows runner의 관측한 성공을 취소하지도, 전체-context 재발급을
검증하지도 않는다. 원래 runner·cookie 회전·DPAPI provider·checklist live evidence는 보존했다.

## 후속 정정: HTML 미파싱과 미측정 0 — 07:07 / 07:52 UTC

위 실패는 당시 실행의 기록이지 이 PC 전체의 세션 획득 불가능 증거가 아니다.
같은 Canary에서 일반 화면의 홈 → 검색창 입력 → 낮은가격순 listitem 클릭은 성공했고,
관측 RSC는 HTTP 200 / 상품 60개였다. 요청 가로채기 없이 수행했다. 실제 요청의
`channel=user`, 빈 `component`, `traceId`는 기존 직접 URL 생성과 달랐다.
라우터 상태 헤더와 `_rsc`는 기존 계산과 같았다. 차이 하나를 단독 원인으로 정하지 않는다.

첫 전체 쿠키 실험은 검색 URL에 적용되는 쿠키 16개를 이름 필터 없이 Vercel icn1에
암호화 전달했다. 캡처 11초 뒤 실제 Cookie 헤더 일치를 확인했지만 응답은
HTTP 200 / text/html / 2,485 bytes였다. 당시 worker는 MIME 검사에서 종료했으므로
`products:0`은 초기값이지 HTML 파싱 결과가 아니다. 원문을 버려 당시 상품 유무는 미확인이다.
이를 새 응답이나 응답 크기만으로 차단/빈 목록으로 소급 분류해서는 안 된다.

07:52 UTC 개선된 일회성 검사에서는 기존 보호 저장소의 **45분 된 세션**을 사용했다.
새 브라우저 캡처가 아니며 세션 신선도 차이가 있다. GET 1회는 HTTP 403 / text/html /
387 bytes였고 HTML title의 Access Denied, 상품 링크 0개, embedded JSON/Flight 없음이
실제 확인됐다. `productCount:null`, `parseStatus:not_attempted`로 기록했다. 전체 HTML은
VM에서 암호화하고 호스트 DPAPI로 보호 저장해 추가 네트워크 없이 재분석할 수 있다.
원문/쿠키/추적 URL은 repo에 넣지 않았다. Sandbox는 종료했고 거부 뒤 재시도하지 않았다.

### 코드·검증 개선 (새 운영 성공 증거 아님)

- `lib/retail/coupang-response.mjs`: 실제 본문을 기준으로 HTML/JSON/RSC를 검사한다.
  HTML은 parse5로 구조를 읽고, literal embedded Flight/JSON을 기존 정확한 SKU·통화·가격
  스키마로 검증한다. JavaScript를 실행하지 않는다. 관측된 `#product-list > li` DOM 카드도
  정확한 상품·옵션 ID와 명시적인 원화 표시 가격을 검증해 읽는다. 취소선 원가는 제외하고,
  중복 금액·단가·월납·음수는 추정하지 않는다. 기존 HTML fixture의 3개 표시 가격
  15,900 / 23,900 / 10,400원을 독립 추출했다. 쿠폰 문구·배송 미확인·HTML 가격 근거를
  유지한다. 다른 DOM 모양이나 일반 링크/JSON-LD는 여전히 후보이며 빈 상품 목록이 아니다.
- 파싱 미시도/미지원/실패/검증 성공을 분리하고 count는 미측정일 때 null이다.
  CLI, HTTP consumer, Lifehack의 API/DB receipt에 이 구분을 유지한다. DB의 기존 fetched는
  처리한 검증 상품 수이며 원천 페이지의 상품 유무를 나타내지 않는다.
- cookie-name allowlist를 없애고 해당 검색 URL의 domain/path/expiry를 적용한다.
  쿠키 identity는 이름만이 아니라 이름·domain·path다. 이 공개 가격 adapter에서 지원하지
  않는 account-cookie context는 명시적으로 거부하며 조용히 제거해서 성공시키지 않는다.
- 실제 관측 input이 있으면 동일 검색어에 보존해 사용한다. 다른 검색어는 관측 알고리즘에서
  생성한 input임을 별도 표시한다. 신규 기본 channel은 user이며 이것만으로 성공을 주장하지 않는다.
- Lifehack bootstrap은 홈/접근성 이름 기반 검색·정렬, resource interception 없음,
  암호화된 응답의 실제 상품 검증 후 세션 준비 완료 판정으로 수정했다. 이 로컬 검사 시점에는
  새 cloud bootstrap 실증/배포/보류 해제가 없었다. 이후 운영 실행은 다음 절과 구분한다.
- 과거 성공 receipt와 원문 해시는 보존한다. 변경된 구현의 live replay freshness는 과거 증거와
  다르며, 합성 회귀 테스트가 현재 Vercel 성공을 대신하지 않는다.

## 후속 운영 배포·실행 — 09:06–09:13 UTC

Lifehack `b4b9b036a01249356106404efacd44bd21e9063f`를 private GitHub main에
반영하고 원격 SHA를 읽었다. 변경된 최종 tree의 전체 테스트 1,139개가 통과했고
typecheck/build도 통과했다. 최초 Vercel build는 `HUB_SCHEMA_CHECK_UNAVAILABLE`로
실패했다. 로컬 build 성공을 운영 DB 접근 성공으로 취급하면 이 장애를 놓친다.

프로젝트 목록의 상태는 `ACTIVE_HEALTHY`였지만 서비스별 조회에서 DB/REST/Auth/Storage
모두 `UNHEALTHY`였다. SQL은 연결 timeout/544, Metrics는 504였다. 해당 프로젝트만
데이터·설정을 유지하는 restart를 한 번 실행한 후 네 서비스가 모두 healthy로 복구된 것을
읽었다. 키를 재발급하거나 legacy key를 다시 켜지 않았고 schema preflight를 건너뛰지 않았다.
이후 같은 커밋을 재배포해 운영 domain/production target의 READY 및 SHA를 확인했다.

잘못된 이전 UI 흐름을 교체한 배포에 한해서 기존 revision 3 보류를 CAS로 한 번 재검토했다.
이전 receipt/error를 남긴 revision 4에서 **09:08:40 UTC 정기 Cron 자체가 실행**됐다.
Vercel Function → Vercel Sandbox의 홈 → 검색 흐름은 `public_search_document`에서
HTTP 403으로 끝났다. 09:10:01 UTC 별도 DB readback 결과는 revision 5 / blocked /
hasSession false / accepted 0이다. `parseStatus:not_attempted`, `measuredProducts:null`이며,
원천 상품 0개를 파싱했다는 뜻이 아니다. source 거부 뒤 새 프로필/프록시로 반복하지 않았다.
**배포·정기 실행은 검증됐지만 쿠팡 일반몰 수집은 미완료**이고 checklist는 계속
`needs_reverification`이다. 기존 07:07 UTC의 200 HTML 원문도 여전히 미복원이다.

반면 별도 기존 Vercel collector의 실행 receipt와 catalog를 대조하면, 복구 후 네이버 쇼핑
150개, 쿠팡 Partners discovery 127개, Adpick SDK 30개, MyRealTrip partner 20개가
저장·갱신됐다. 일반몰 search의 대체 성공으로 합치지 않는다. 각 fresh row 중 제휴 URL
보유 수는 각각 53/120/30/20개였으며 **기존 URL 보존과 이번 신규 발급 수는 다르다**.
이 실행들의 수집·갱신은 Vercel에서 수행됐고 PC는 배포·운영 복구·검증에만 사용했다.

09:15 UTC 후속 자동 실행도 확인했다. Coupang discovery는 목록 합계 172건을 읽고
중복을 합친 127건을 저장·갱신했다. 수동 dispatch 한 번만 성공한 것이 아니다.
같은 시각 Naver Connect 링크 worker는 8건 처리/1건 연결 저장을 기록했다.
이 숫자를 일반몰 검색 성공이나 각 행의 새로운 제휴 URL 발급 증거로 확대하지 않는다.
