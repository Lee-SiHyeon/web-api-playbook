# 쿠팡 검색 403 보고 정정과 HTTP 재검증

**유지되는 RSC 검색 실행기는 직접 HTTP 200·상품 60개를 반환했다. 별도 Node 프로세스에서 서명 갱신 후 다른 검색도 200·54개였고, 자연 만료 뒤 일반 검색의 자동 갱신도 200·60개였다.** 세 요청 모두 실제 전송 쿠키 일치와 상품 schema를 확인했고, HTTP 실행 중 브라우저를 사용하지 않았다.

최초 전수조사는 `coupang-public.mjs retail-search --anonymous`의 쿠키 없는 Document 진단을 선택했다. 이 경로의 403은 맞지만, 이미 구현된 `coupang-retail-session.mjs`의 RSC 검색 상태를 대표하지 않는다. `/np/search`라는 경로만 같고 애플리케이션 헤더·응답 MIME·세션 적용이 다르다. [최초 표본](../playbook-audit-2026-10-15/live-samples.json)은 보존하고 진단 범위를 명시했다.

재검증 시작 시 실제 실행기의 보호 상태는 `COUPANG_RETAIL_CONTEXT_REBOOTSTRAP_REQUIRED`였다. 6시간 로컬 제한으로 HTTP 요청 전 중단한 것이며 서버의 403이 아니다. 기존 Chrome 탭에서 정렬 레이블을 클릭한 새 RSC 응답은 200이었다. 여기서 쿠팡 origin 쿠키를 인계하려 했으나 `bm_mi`가 사라진 정상 세션을 import가 거부했다. 이 일시적인 쿠키만 선택 항목으로 수정했다. 나머지 11개 필수 쿠키, 중복·origin·path·서명·5분 캡처 신선도와 6시간 사용 제한은 유지한다.

| 실행 | UTC 시각 | 결과 |
|---|---|---|
| 기존 탭의 낮은가격순 클릭 | 11:37:29 관측 | 200 `text/x-component`, 쿠팡 전용 쿠키 11개를 메모리 stdin으로 DPAPI 저장 |
| 독립 Node `search --query=무선마우스` | 11:37:37 | 200, 주 검색 상품 60개, 쿠키 전송 일치 |
| 별도 Node `renew --query=로지텍무선마우스` | 11:37:59 | 서명 갱신 후 200, 주 검색 상품 54개, 쿠키 전송 일치 |
| 자연 만료 후 새 Node `search --query=무선마우스` | [영수증 시각](expired-auto-renewal.json) | `oldExpiredAtStart: true`, 자동 갱신 후 200·60개, 쿠키 전송 일치 |

명시적인 만료 전 갱신과 자연 만료 뒤 일반 `search`의 자동 갱신을 각각 확인했다. 앞선 검증은 [갱신 기록](../../references/coupang-retail-renewal-2026-10-15.md)에 있다. 새 브라우저 없이 반복 검색·서명 갱신은 확인했지만 **최초/재부트스트랩에는 브라우저가 필요하며 전체 기기 문맥과 Akamai 세션의 장기 만료 복구는 미검증**이다. 계정 인증, 와우 적용 가격, 전체 페이지·상품 상세를 이 검색 결과로 검증했다고 주장하지 않는다. 쓰기·주문·자동 재시도는 0건이다.

실행 경로는 다음과 같다.

```powershell
npm run coupang:retail:session -- status
npm run coupang:retail:session -- search --query=무선마우스
npm run coupang:retail:session -- renew --query=로지텍무선마우스
node scripts/checklist.mjs --service=coupang-retail --json
```

`coupang-retail/catalog.search` 매니페스트를 등록해 전수조사가 유지되는 실행기와 증거를 찾도록 했다. 좁은 RSC 판정기는 HTTP 200·MIME·실제 쿠키 전송·상품·실행 및 projection 해시를 검사한다. Document 403, 로컬 preflight, 브라우저 전송, 쿠키 전파 실패를 성공으로 인정하지 않는 회귀도 추가했다. 저장 영수증의 `recorded_live`는 해당 시점의 기록이며 이후 세션의 현재 준비 상태를 대신하지 않는다.

증거: [전체 요약](summary.json), [검색 실행](search.json), [서명 갱신 실행](signature-renewal.json), [자연 만료 후 자동 갱신](expired-auto-renewal.json), [검사기 증명과 소스 해시](search-proof.json), [독립 파일 대조와 검증](validation.json). 쿠키·토큰 값과 원본 인증 헤더는 포함하지 않았다. 관련 오프라인 회귀 26건과 이 서비스의 strict 기록 검사를 통과했다.
