# Coupang 공개 검색의 HTTP 갱신

다른 runtime의 성공은 별도 검증한다. [2026-10-17 Vercel 이관 사례](coupang-retail-vercel-2026-10-17.md)는
운영 배포·DB 적용과 달리 후속 검색 Document 403으로 수집이 보류된 결과이며,
아래의 Windows HTTP 성공을 Vercel 세션 재사용 성공으로 확대하지 않는다.

최초 승인된 Canary 세션을 한 번 인계한 뒤, 반복 검색은 `scripts/coupang-retail-session.mjs`로 실행한다. Node가 서명과 RSC 입력을 계산하며, 브라우저·CDP·headless·DOM 모사·프록시·TLS/UA 모사를 실행하지 않는다. 쿠키와 서명 내부의 기기 문맥은 Windows CurrentUser DPAPI의 `coupang-retail-public-v1`에만 저장한다.

```powershell
node scripts/coupang-retail-session.mjs status
node scripts/coupang-retail-session.mjs search --query=무선마우스 --out=work/search.json
node scripts/coupang-retail-session.mjs renew --query=무선마우스 --out=work/renew.json
```

`search`는 서명 발급 후 60초가 지났거나 만료가 가까우면 먼저 새 서명을 계산하고 GET을 한 번 보낸다. `renew`는 서명을 새로 만들고 동일한 안전한 GET으로 검증한다. 스케줄러나 백그라운드 브라우저를 설치하지 않는다. 현재 계약은 `channel=relate`, `sorter=salePriceAsc`의 검색 RSC이며 전체 카테고리·상세·후기 성공을 뜻하지 않는다. 출력 파일은 기존 파일을 덮어쓰지 않는다.

## 관측한 갱신 경로

1. 공개 `sec-g/1.2.9/sec.min.js`의 `refreshJS`는 `FP_DATA`를 받아 `signDataWithHeaders("global", true, "1.1.0", ...)`를 호출한다. 스크립트는 60초마다 호출하고 `x-cp-s`의 Expires를 300초 뒤로 설정한다.
2. `x-cp-s`는 쿠키 복사만으로 무기한 유지되는 값이 아니다. 시간·nonce·counter를 갱신하고 관측된 서명 계산을 Node로 구현했다. 기존 서명과의 완전 일치를 메모리에서 확인했다. 최초 인계된 기기 문맥 c4/c6은 보존하며 새 브라우저 지문을 만들지 않는다.
3. 공개 Next.js 번들의 `_rsc` 생성은 라우터 헤더를 연결한 문자열의 SHA-256 앞 12바이트를 base64url로 인코딩한다. 캡처된 값과 계산값의 일치를 확인했으며 이후에는 검색어와 고정 라우터 구조에서 입력 전체를 생성한다. [Next.js의 RSC 캐시 키 설명](https://nextjs.org/docs/app/guides/cdn-caching).
4. 검색 응답의 허용된 `Set-Cookie`는 도메인·경로·만료·삭제 규칙을 적용한 jar에 반영하고 DPAPI로 다시 저장한다. 동시 실행은 기존 세션 lock을 사용한다. 이 응답 회전은 Akamai의 모든 만료 상태 복구를 증명하지 않는다.

공개 스크립트 SHA-256: `89e49f470add7ac804a7fc1696324a0841bc3403c1d78c99ed9304588edaa1dc`. 원본 스크립트를 실행하는 코드는 production 경로에 포함되지 않는다. 오프라인 16개 합성 벡터는 원본의 순수 서명 함수와 독립 대조한 값이다. 원본 기기 문맥·쿠키·서명 값은 fixture나 증거 파일에 넣지 않았다.

## 검증 범위

쿠키 비교에서 전체 33개는 200, `x-cp-s`만 제외하면 403이었다. 방문자 3개 + `x-cp-s`만으로도 403이었다. 새 서명과 방문자 3개 + Akamai 8개, 총 12개 조합은 200과 상품 60개를 반환했다. 이 12개는 검증된 축소 조합이며 각 Akamai 쿠키의 개별 필수성을 입증한 최소집합은 아니다.

11:37 UTC 재검증에서는 정상 브라우저 RSC 200 세션에 `bm_mi`가 없었다. 기존 import가 12개 모두를 필수로 요구해 `COUPANG_RETAIL_IMPORT_INCOMPLETE`로 거부하는 결함을 수정했다. 현재는 `bm_mi`가 있으면 보존하고 없어도 나머지 11개와 기존 origin·서명·신선도 검증을 통과하면 가져온다. 이 11개 조합으로 독립 Node HTTP 검색 200·60개, 별도 프로세스 서명 갱신 후 200·54개를 확인했다. [후속 증거](../verification/coupang-recheck-2026-10-15/README.md). 6시간 로컬 제한과 전체 세션 갱신의 미검증 상태는 그대로다.

갱신 전후 응답, 자연 만료 후 새 프로세스 실행, 추가 프로세스의 재사용 증거는 `verification/coupang-discovery-2026-10-15/retail-auto-renewal-*.json`에 둔다. 실제 전송된 Cookie 헤더는 `undici:request:create`에서 메모리의 예상값과 비교한다. receipt에는 일치 여부·쿠키 이름·상태·공개 상품만 남긴다.

2026-10-15 실검증: `무선마우스` 서명이 04:15:14 UTC에 자연 만료된 후 자동 갱신하여 200·60개를 반환했다. 다음 독립 Node 프로세스에서 같은 보호 저장소로 200·60개를 읽었다. 브라우저 입력을 새로 받지 않고 `로지텍무선마우스`를 검색한 별도 프로세스는 200·54개를 반환했다. 이 후속 상품들은 현재 HTTP 응답을 파싱한 결과이며, 이전 60/60 DOM 대조 결과를 새 검색어에 적용하지 않는다.

추가 수명 의존성 진단은 같은 검색에서 `bm_mi`, `ak_bmsc`, `bm_sv`, `bm_sz`, `bm_so`, `bm_lso`를 차례로 하나씩 제외했다. 기준 요청과 6개 변경 모두 200·60개였다. 성공 응답의 Set-Cookie를 이어받았으므로 순수 누적 삭제 실험은 아니다. 특히 `bm_sz` 누락 요청은 `_abck`와 `bm_s` 회전 및 `bm_sz`의 약 4시간 Max-Age 재발급을 반환했다. 마지막 요청의 전송 조합은 7개였다. 유지되는 production 저장소는 앞서 검증한 12개 조합이며, 진단용 cookie jar로 덮어쓰지 않았다. 이 결과는 누락 재발급 증거이고 전체 세션의 자연 만료 실험은 아니다.

초기 브라우저 인계, 반복 요청의 서명 갱신, 서버 쿠키 회전, 기기 문맥 재발급은 구분한다. 현재 **기기 문맥 자체의 만료 후 재발급과 Akamai 전체 세션의 장기 만료 복구는 미검증**이다. 기기 문맥 보존에는 6시간의 로컬 상한을 두며 이는 서버 TTL이 아니다. 상한 또는 HTTP 거부에 도달하면 명시적 실패를 반환한다. 거부 후 재시도·새 방문자 생성·무한 갱신은 없다.

새 최초 인계는 `import` 명령의 stdin JSON으로만 받는다. `origin`, `capturedAt`, `responseStatus`, 현재 origin에서 관측한 `cookies`가 필요하며, 로그인·분석 쿠키는 저장하지 않는다. 인계 성공 자체는 HTTP 성공이 아니므로 이어서 `search`를 실행한다.

```powershell
node --import ./scripts/coupang-offline-guard.mjs --test tests/coupang-retail-session.test.mjs tests/coupang-rsc.test.mjs tests/coupang-browser-cookie-probe.test.mjs
npm run coupang:verify
```
