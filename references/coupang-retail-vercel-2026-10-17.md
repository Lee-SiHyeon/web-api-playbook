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
