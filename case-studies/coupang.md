# Coupang: 소스 후보를 계약으로 오인하지 않기

## 2026-10-18 11:32 KST: Vercel 운영 저장 95개 확인, 두 번째 페이지 403은 미해결

수정 commit `3334e472e524a939280a6e5402db0acf6e4901b6`는 전체 회귀 1,324/1,324, 타입 검사, production build를 통과했고 private GitHub main readback과 Vercel production READY를 확인했다. 검증 도중 설정한 Goldbox 전용 임시 maintenance hold는 이전 실패 receipt hash를 바꾸지 않고 해제했다. 검증용 별도 Vercel VM은 종료했고 원천 Chrome VM은 보존했다.

실제 Vercel Cron run `63216114-15e4-49d6-84e6-2a0b2eb483a3`은 Google 검색 → 공식 결과 → 쿠팡 홈 → 실제 골드박스 메뉴까지 진행했다. 첫 HTML **100행 중 정확한 상품 URL이 있는 95개를 실제 DB에 저장**했다. 해당 run의 시작~종료 시간에 기록된 상품을 별도로 조회해 95개의 정확한 SKU·가격·이미지와 collector log의 upserted 95를 대조했다. 추적 전용 5행은 제외했고, 제휴 링크 발급 0개를 발급 성공으로 표시하지 않는다. 기존 94개 또는 별도 probe의 205행을 이번 저장 수에 더하지 않는다.

후속 native XHR은 여전히 **HTTP 403**이었다. 수동 HTTP 재현이 아니라 사이트 자신의 스크롤 observer가 보낸 요청이며, 수동 선택한 쿠키 목록을 주입하지 않았다. 별도 passive CDP 관측에서 widget `productOffset=100`, 쿠키 이름 16종, 브라우저 차단 쿠키 0개, HTTP/2, disk/service-worker cache 미사용, HTML 응답 403을 확인했다. Goldbox 문서 생성 후 약 12초에 요청됐으므로 초기화 대기를 추가했다는 이유만으로 해결됐다고 볼 수 없다. 브라우저의 cookie 전송 여부는 서버가 그 방문자를 허용한다는 증거도 아니다. [Akamai의 공식 설명](https://www.akamai.com/site/en/documents/white-paper/compliance-through-privacy-by-design-white-paper.pdf)은 네트워크·브라우저·행동 신호를 함께 사용한다고 설명하지만, 이번 요청의 구체적인 거부 정책은 확인되지 않았다.

실제 사이트 검증은 **저장된 부분 관측의 표시 검증**으로 구분한다. PC 1,280px에서 4개 목록 페이지를 순회해 이번 저장 95개를 모두 확인했고, 모바일 390px에서 60개와 상세 화면을 확인했다. 가격·상세 이미지 로딩, 스크립트 오류 0, 가로 넘침 0, 공개 페이지에서 collector 호출 0을 검증했다. 이것을 원천 전체 수집 성공으로 승격하지 않는다. `persistenceVerified=true`, `completeCollectionVerified=false`, `paginationExhausted=false`를 별도로 기록한다.

근거: [운영 Cron·독립 DB·PC/모바일·실제 쿠키 전송 요약](../sanitizedverification/coupang-production-browser-2026-10-18.json), [구글 검색부터 첫 페이지와 후속 403까지의 2분 19.6초 녹화](https://drive.google.com/file/d/10CaWUdYW_iW7ktR7INGP0eScyAAoVMOv/view?usp=drivesdk). 전체 EOF 녹화로 표시하지 않는다.

### 11:47 KST 추가 대조: 홈 초기화 5분도 후속 403을 해결하지 못함

앞서 두 번의 EOF 성공이 오래 열린 홈을 재사용했다는 차이를 검사했다. 운영 실패 뒤 15분 이상 간격을 두고, **동일 VM·Chrome 프로세스·프로필·탭**에서 Google 검색 → 홈을 열어 301,546ms 유지했다. 이 동안 쿠키 15개의 자연 갱신도 관측했다(값은 기록하지 않음). 그런 뒤 배포된 것과 같은 reader가 `reusedHome=true`, 메뉴 탐색 1회로 들어갔지만 여전히 첫 HTML 100행, 두 번째 native XHR 403이었다. 기다리는 시간만 늘리면 해결된다는 가설도 이 대조에서는 지지되지 않았다. IP, 쿠키값, UA, 브라우저 보안 설정을 교체하거나 숨기지 않았다.

이 대조의 DB 쓰기는 0이며 운영 실패 hold를 해제하지 않았다. [별도 대조 receipt](../sanitizedverification/coupang-warmed-home-comparison-2026-10-18.json)에 실패와 브라우저 보존을 기록했다. 결론은 **전체 브라우저 실행·부분 상품 저장은 검증, 전체 페이지 수집 및 지속 성공은 미검증**이다. 쿠키 누락/HTML 파싱으로 현재의 실제 native 403을 설명하거나, 반대로 Vercel에서 브라우저 자체를 실행할 수 없다고 결론내리지 않는다. 현재 정기 Cron은 존재하지만 Goldbox 원천 수집은 denial backoff 상태다. 다음 허용된 예약 시도는 두 hold를 모두 지난 2026-10-19 12:22 KST이며, 그때의 성공은 아직 관측하지 않았다.

## 2026-10-18 10:02~10:22 KST: 운영 재검증에서 탐색 오판과 실제 후속 403을 분리

전체 브라우저 구현 `922391b286b3b4bb34fc5c38c8fca3b954a64f66`를 private main과 Vercel production READY까지 확인했다. 기존 특정 Goldbox 보류만 이전 receipt hash를 보존해 해제했다. 하지만 Google부터 시작한 첫 운영 run `49fbf4ae-92fa-4a81-9a30-9ff6d0a4ae78`은 `COUPANG_GOLDBOX_HOME_SCOPE_CHANGED`, fetched/upserted 0으로 종료됐다. 이 실패 receipt의 `persisted=true`는 상품 저장 성공이 아니다. 독립 DB 조회의 해당 run-window 상품도 0개였다.

원인은 실제 도착 전에 중간 navigation lifecycle을 소비하는 코드 결함이었다. Google의 중간 HTTP 200과 늦게 도착한 이전 홈의 lifecycle 이벤트는 새 페이지의 응답이 아니다. 제어 연결을 다시 열어 본 같은 Chrome/탭은 이미 정상 쿠팡 홈에 도착해 있었다. 수정 reader는 탐색 전에 설치한 observer에서 **도착 URL + main frame의 실제 응답**을 고르고, 같은 클릭의 최종 문서 준비를 기다린다. intermediate 200, 최종 403, 실제 response 없는 DOM, 늦은 이전 lifecycle을 각각 회귀검증한다.

이 수정 뒤 Google → 홈 → 실제 골드박스 메뉴는 정상 진행됐지만 10:09 KST 별도 probe의 후속 상품 XHR은 **실제 HTTP 403**이었다. 첫 HTML 98행, 정확한 DOM 상품 93개, 두 번째 페이지 미수집이다. 이후 읽기 전용 검사에서도 해당 XHR의 `responseStatus=403`, 프로토콜 `h2`, DOM 93개였으며 자동 회복된 전체 목록은 없었다. 앞선 두 번의 205행 EOF 성공을 이 실행의 성공으로 재사용하지 않는다.

새 문서에는 analytics의 무한 network-idle 대신 문서 age 12초까지 초기화 여유를 두되, 이미 오래 열린 문서에 같은 지연을 반복하지 않도록 보강했다. 초기화 대기가 403을 해결했다고 단정하지 않는다. 브라우저 프로세스·프로필·탭은 그대로 보존하고, 짧은 간격의 재시도·cookie reset·IP 교체는 하지 않는다. 화면의 한국어 tofu는 별도 글꼴 문제여서 전용 VM에 Noto CJK를 설치했다. `fc-match`는 설치를 확인했지만 실행 중인 Chrome의 별도 테스트 화면에는 tofu가 남았다. 설치 성공을 즉시 렌더링 성공이나 원천 접근 허용으로 보고하지 않는다.

10:22:35 KST의 실제 정기 Cron은 기존 완료된 10시 슬롯을 재생해 같은 실패를 반환했고 소스를 중복 수집하지 않았다. 이는 정기 호출과 dedup 동작의 증거이며 **새 상품 수집 성공은 아니다.** 변경된 reader의 최종 운영·DB·화면 검증은 후속 receipt로 별도 확정해야 한다.

## 2026-10-18 09:25~09:30 KST: Vercel 전체 브라우저를 유지해 끝 페이지까지 읽음

이전의 일회용 VM/프로필 대신 named persistent Vercel Sandbox `icn1`에서 정식 Chrome 155.0.8059.84의 전체 프로필과 실행 중 프로세스·탭을 보존했다. 개별 작업은 CDP 제어 연결만 끊고 다음 작업이 같은 Chrome과 탭에 다시 연결했다. 로컬 쿠키/프로필 반입, PC 브라우저 중계, 공식 Open API는 사용하지 않았다.

- 구글 검색 → 공식 쿠팡 결과 → 실제 골드박스 메뉴 클릭에서 홈과 골드박스 main document가 HTTP 200이었다. 부가 telemetry의 403과 목록 응답을 분리했다.
- 첫 성공은 이미 열린 동일 골드박스 탭에서 실제 sentinel을 두 번 스크롤해 **98+100+7=205행, 3페이지, EOF**를 확인한 흐름이다. 첫 페이지 재개 입력은 live DOM이고 후속 두 페이지는 사이트가 실제 발생시킨 XHR 응답이었다. DOM hash를 새 HTTP response hash로 혼동하지 않는다.
- 수정된 운영 entrypoint의 다음 독립 실행도 **99+99+7=205행, 모든 목록 페이지 HTTP 200, EOF**였다. 이 실행은 이미 열린 홈을 재사용했다(`reusedHome=true`, `sourceNavigations=1`). 따라서 새 Google 검색부터의 성공 증거로 확장하지 않는다. Goldbox main document는 이번 실행의 실제 HTTP response body와 frame/URL로 검증했다. 브라우저와 탭 identity는 작업 전후 같았다.
- 정확한 상품 URL이 없는 추적 전용 9행은 상품 URL을 추측해 채우지 않는다. 총 목록행, 정확한 SKU 상품 196개, DB 저장행은 서로 다른 수다. 이 시점 probe의 DB 쓰기는 0회다.

이번 구현 중 발견한 별도 결함도 기록한다. 홈의 analytics가 계속 움직여 `networkidle2`가 끝나지 않았고, 골드박스 상품 anchor는 `display: contents`라 자체 박스가 0×0이었다. 이는 실제 상품이 없다는 뜻이 아니다. DOM 준비/안정된 메뉴 locator와 **리스트 컨테이너** 가시성으로 수정했다. 이 버그가 과거의 실제 main-document 403 응답까지 설명하는 것은 아니다.

브라우저를 매번 버리지 않는 구조에서 반복 성공은 확인했지만, Chrome 버전·방문 시간·프로필 지속성이 함께 바뀌었으므로 특정 한 변수를 유일한 원인으로 확정하지 않는다. 운영 배포/정기 실행/DB 저장은 별도 readback으로 검증한다. VM 종료 후 disk snapshot은 전체 프로필을 보존하지만 JS 메모리를 보존하지 않는다. live-process 재접속과 disk-profile 재개를 분리해야 한다.

근거: [정제된 전체 순회·재접속 receipt](../sanitizedverification/coupang-persistent-browser-2026-10-18.json), [2~3페이지 실제 스크롤 녹화](https://drive.google.com/file/d/1DOm9-k5zv8BdHwg8cQLJzaXRayJVKN2b/view?usp=drivesdk). 이 짧은 녹화는 이어진 페이지 스크롤만 담으며 전체 Google 진입 과정을 촬영했다고 표시하지 않는다. [Puppeteer locator의 안정된 요소 대기](https://pptr.dev/guides/page-interactions)와 [Vercel disk snapshot 경계](https://vercel.com/docs/sandbox/concepts/snapshots)를 참고한다.

## 최신 브라우저 관측: 2026-10-18 00:19~00:27 KST

HTTP reader 비교 대신 **Vercel 실제 Chrome에서 페이지를 여는 단계부터** 기록하고 로컬 브라우저와 대조했다. [정제 영수증](../sanitizedverification/coupang-browser-parity-2026-10-18.json)에 문서/iframe/목록 요청, 쿠키 이름, DOM 수, 화면 파일 hash를 보존했다. 쿠키 값·계정 세션·원본 HTML은 포함하지 않는다.

| 실제 브라우저 흐름 | 관측 |
| --- | --- |
| Vercel `icn1`, 골드박스 바로 진입 | 최상위 문서 403, 화면 `Access Denied`, 파서 미실행 |
| 로컬, 같은 Chrome 151·화면·flow/parser | HTML 100행 → 실제 스크롤 → 사이트 XHR 100행 → EOF; 정확한 상품 URL 193개, 추적 대상 7개 제외 |
| Vercel, 쿠팡 홈부터 진입 | 홈·bootstrap iframe 200 → 초기화 12초 → 보이는 골드박스 메뉴 실제 클릭 1회 → 골드박스 문서 403 |

세 번째 흐름의 골드박스 요청에는 브라우저가 자연 발급받은 PCID 등 **14종 쿠키가 실제로 전송**됐으며 차단된 쿠키 목록은 비어 있었다. 전체 쿠키 누락, HTTP/HTTPS 혼동, 두 번째 페이지 파싱 오류를 이번 문서 거절의 원인으로 설명하지 않는다. 다만 계정 세션 효과나 네트워크/IP·OS·언어·시간대 중 어느 차이가 원천 판정을 바꿨는지는 확정하지 않았다. 직접 진입 두 실행은 Windows 최초 실행 화면 처리만 달랐고, 그 외 번들 바이트 일치를 확인했다.

로컬 DOM의 정확한 상품 대상은 스크롤 전 94개에서 후 193개로 늘었다. 페이지 2 버튼이나 수동 fetch를 사용한 것이 아니다. 브라우저 스크린샷과 네트워크 HTTP 상태를 함께 확인했으며, 오류 화면 설명의 `http` 문자열과 달리 실제 요청은 HTTPS/h2였다. Vercel 홈 화면의 일부 한글 글꼴 미표시는 별도 UI 환경 차이이며 403의 원인으로 확정하지 않았다.

00:26 KST 독립 DB 확인 결과 운영 데이터는 앞선 부분 수집의 94개였다(정확한 SKU/가격/이미지 각 94개, affiliate URL 보유 82개). 이 관측은 링크 82개를 새로 발급했다는 뜻이 아니다. 이번 probe는 상품 저장·Cron 수동 실행·기존 보류 해제를 하지 않았고, 사용한 브라우저·임시 프로필·Sandbox는 종료/정리했다. **Vercel 골드박스 전체 수집은 아직 해결되지 않았다.** 아래 10/17의 첫 HTML 100행 성공은 당시 별도 실행 결과로 보존하며 현재 문서 거절과 혼합하지 않는다.

## 배경: 관측 API와 정적 후보 구분

2026-09-19 기록은 실제 브라우저 관측 API 9개, 분석한 공개 JavaScript bundle 6개, 원시 문자열 후보 149개, 정규화 계약/후보 154개를 구분합니다. 154개가 전부 독립 HTTP로 검증된 operation이라는 의미는 아닙니다.

근거: [당시 분석 문서](../service-packs/affiliate/apps/affiliate-api-hub/docs/coupang-partners-api-discovery-2026-09-19.md), [관측 API](../service-packs/affiliate/apps/affiliate-api-hub/references/coupang-partners-observed-api.json), [정제 catalog](../service-packs/affiliate/apps/affiliate-api-hub/references/coupang-partners-curated-api.json). 파일 원본 hash는 `provenance/additional-sources.json`에 있습니다.

## 실패하기 쉬운 추론

bundle에서 endpoint 근처 문자열을 넓게 긁으면 `className`, `children`, `dangerouslySetInnerHTML` 같은 UI 속성이 request body 필드 후보에 섞일 수 있습니다. 정적 분석으로 가까이 있었다는 이유만으로 JSON body 계약에 넣으면 잘못된 요청을 만듭니다.

관측된 요청 method/path/encoding/body key와 실제 응답 schema를 우선합니다. 소스 후보는 별도 `candidate` 상태에 두고 라이브 contract를 확인한 뒤 adapter operation으로 승격합니다. URL 생성·리포트 다운로드·상품 검색은 목적과 부작용이 달라 별도 판정해야 합니다.

## 보존한 도구

- `sanitize-coupang-netlog.mjs`: 네트워크 기록에서 민감 원문을 제거하고 메타데이터를 정리.
- `analyze-coupang-public-scripts.mjs`, `build-coupang-request-shapes.mjs`: source 기반 후보와 모양 추출.
- `build-coupang-contract-catalog.mjs`: 여러 근거를 합친 catalog.
- `coupang-browser-probe-extension`, Windows capture helper: 당시 별도 발견 도구. 공통 HTTP 런타임에 필수로 설치되는 것은 아님.

이 파일들은 affiliate pack의 `apps/affiliate-api-hub` 아래에 있습니다. 분석 도구가 있다는 사실로 현재 로그인·링크 생성·전체 API 범위를 검증했다고 보고하지 않습니다. 공식 개발자 인증과 웹 파트너 세션의 권한·요청 계약도 별도로 다룹니다.

**다른 서비스에 적용할 교훈:** metadata 정규화와 의미 검증을 분리하고, 후보 수를 완성한 클라이언트 수로 사용하지 않습니다. 필요한 요청의 원본 계약을 찾을 때 source 분석을 활용하되 최종 payload를 추측하는 근거로 쓰지 않습니다.

## 2026-10-04: 가격·배송비와 프로세스 재시작

최근 [반복 진단 도구](../references/coupang-debugging.md)는 공개 오퍼·와우 표시가·회원 적용가·배송비·골드박스·반짝세일과 파트너스 링크를 별도 경계로 검증한다. 상품·옵션·판매 옵션 세 ID를 고정하고, 조건부 무료배송과 미확인 배송비를 0원으로 바꾸지 않는다. 공개 표시 가격은 해당 계정에 적용된 회원 가격의 증거가 아니다.

새 프로세스의 `COUPANG_OWNER_BINDING_INVALID`는 대시보드 HTTP 200 이후에도 발생했다. 만료 쿠키가 wire 계산 중 원래 jar에서 삭제되는 문제와 정상 CT 쿠키 회전을 고정 digest로 거부하는 문제가 각각 있었다. 기존 HMAC·AFATK·계정 anchor를 먼저 확인하고, 성공한 동일 대시보드 응답에서 적용된 CT 값 회전에 대해서만 증거를 갱신한다. 저장할 최종 세션도 검증하고 보호 저장소를 재사용한다. 인증을 느슨하게 하거나 현재 소유자 조회를 생략하는 방식으로 해결하지 않는다.

네 번째 공개 오퍼 요청과 15~600초 대기를 비교한 과거 측정은 거절을 관찰한 제한된 시험이다. 서버의 보편적인 카테고리 한도나 성공 쿨다운 시간을 확정하지 않는다. 반복 진단은 같은 문맥의 최대 네 요청에서 첫 실패로 중단한다. 오프라인 회귀검증, 현재 owner HTTP replay, 링크 생성 응답의 목적지·귀속 검증, 독립 readback은 서로 다른 증거다.

## 2026-10-17 골드박스 20개를 전체 목록으로 오인한 사례

Partners `discovery/goldbox?limit=100`은 당시 20개를 반환했다. 추측한 `offset/page/pageNumber`는 같은 20개를 반복했고 추측한 POST는 거절됐다. 요청의 limit이나 HTTP 200을 전체 수집의 근거로 사용하면 안 된다.

같은 날 이 Playbook의 공개 골드박스 reader는 실제 응답의 `dataUrl`을 따라 98개와 102개, 두 페이지의 서로 다른 SKU 200개를 읽었다. 직접 상품 URL로 검증된 것은 193개(명시적 품절 3개 포함), 나머지 7개는 추적 대상만 있어 정확한 상품 연결 대상에서 제외했다. 이는 그 시점의 로컬 관측값이며 매일 고정된 개수도, Vercel 저장 결과도 아니다.

Lifehack에는 reader를 별도 Vercel 수집기로 연결했다. 다음 URL의 출처·형식을 확인하고 반복·무진행·페이지 상한·부분 실패를 기록한다. 전체 응답행, 고유 SKU, 정확한 상품 URL이 있는 행, 일반 가격이 있는 행, 실제 DB 저장행을 따로 센다. 페이지 소진과 가격/연결 범위 완전성도 분리한다. 계정 쿠키 대신 해당 공개 흐름에서 새로 받은 익명 방문자 문맥만 사용한다.

기존 상품 ID와 신규 SKU ID를 단순 합산하면 중복도 생긴다. 상품 ID는 다른 판매 옵션으로 바뀔 수 있으므로 영구 alias로 묶지 않고, 읽기 전용 피드에서 정확한 세 ID 기준으로 최신 관측을 cursor/limit 전에 선택한다. 원본 기록과 기존 공유 URL은 유지한다. 누락이 품절의 증거가 아니므로 샘플을 완전한 snapshot으로 승격하지 않는다.

배포 확인은 production SHA → Cron 등록 → 실제 Vercel 실행 → durable receipt → DB readback 순서다. trigger ACK나 로컬 200 응답만으로 클라우드 수집 성공을 보고하지 않는다. [카드사 목록의 유사 사례](card-mall-collection.md)도 같은 기준을 적용한다.

### 2026-10-17 20:00 KST 운영 결과 — 순회 구현과 원천 접근 실패를 분리

Lifehack production `566b02bd102245d8a5b7511ce8851dd3294433c9`의 새 수집기를 Vercel에서 실행했다. source claim은 73ms에 완료됐지만 첫 공개 방문자 bootstrap이 HTTP 403을 반환했다. 결과는 `COUPANG_VISITOR_HTTP_REJECTED`, source 요청 1회, pageCount 0, fetched/upserted 0, `blocked`다. 목록 HTML/JSON을 받기 전의 접근 실패이므로 HTML 파싱 누락이나 첫 페이지의 20개 제한으로 설명하면 안 된다.

실패 receipt는 DB에 저장됐지만 골드박스 상품은 저장되지 않았다. 이 경우 receipt의 `persisted=true`는 빈 관측과 실패 기록의 저장을 뜻하므로 `status/error/fetched/upserted`와 함께 해석한다. 24시간 해당 writer 보류를 기록했고 다른 쿠팡 Partners 목록과 카드사 수집은 유지했다. 로컬의 200개 관측을 Vercel 수집 실적으로 승격하지 않는다. 페이지 순회 구현·회귀검증·배포는 완료됐으나 **Vercel 공개 골드박스 전체 수집은 미완료**다.

### 2026-10-17 21:34 KST — Vercel CDP WebSocket 연결과 상품 수집을 분리

Vercel 서울 `icn1` Sandbox의 Chrome 151에 `browserWSEndpoint`로 직접 연결해 공개 골드박스 페이지를 두 번 관측했다. 브라우저와 WebSocket 클라이언트 모두 해당 Sandbox에서 실행했다. 로컬 PC는 실행 시작과 결과 읽기만 했으며 PC 브라우저 중계, 계정 쿠키 반입, 상품 DB 업로드는 하지 않았다. 두 Sandbox는 관측 후 종료했다.

| 관측 | WebSocket | 골드박스 최상위 문서 | 후속 응답 | 상품 목록 검증 |
| --- | --- | --- | --- | --- |
| 21:30~21:31 KST | 연결 성공 | HTTP 200 | 관측 범위에서 거절 없음 | 알려진 위젯 응답 0회; 수집 건수 미확인 |
| 21:33~21:34 KST | 연결 성공 | HTTP 200 | `/m/r` fetch HTTP 403 | 알려진 위젯 응답 0회; 수집 건수 미확인 |

두 번째 진단은 첫 자사 document/XHR/fetch 거절 시 페이지를 닫는 보수적인 진단기로 실행했다. 따라서 예약했던 DOM·스크린샷·후속 페이지 확인 전에 종료됐다. **`/m/r`이 상품 API인지, 그 거절이 목록 부재의 원인인지는 확인하지 못했다.** 상품이 0개인 화면을 확인한 것도 아니다. 상품 수는 `null`로 남겼으며 이 진단에서는 catalog write를 실행하지 않았다.

기존 Puppeteer의 `browserURL` 연결도 먼저 `/json/version`에서 WebSocket 주소를 얻어 CDP WebSocket에 접속한다. `browserWSEndpoint`는 이 주소를 직접 전달하는 경로이지 쿠팡의 HTTP API를 WebSocket API로 바꾸는 기능이 아니다. [Puppeteer 연결 옵션](https://pptr.dev/api/puppeteer.connectoptions), [브라우저 WebSocket endpoint](https://pptr.dev/api/puppeteer.browser.wsendpoint).

앞선 운영 bootstrap 403과 이번 문서 200은 endpoint·실행 문맥·관측 시각이 다르므로 상태 차이를 WebSocket 전환의 효과로 단정하지 않는다. 연결 성공, 문서 응답, 실제 목록 렌더링, 후속 페이지 소진, 저장 완료를 각각 증명해야 한다. 운영 수집기·Cron·기존 source 보류는 변경하지 않았으며 **WebSocket 연결은 확인했지만 403 해결과 Vercel 상품 수집 완료는 확인하지 못했다.**

실행 근거는 작업 audit의 `coupang-goldbox-ws-result.json`과 `coupang-goldbox-ws-inspection.json`이다. 이 문서는 그 관측 범위와 한계를 기록하며 새로운 운영 수집 성공 기록을 대체하지 않는다.

### 2026-10-17 21:55 KST — 상태 코드 오독과 실패 범위 오판을 구분

직전 진단기의 `401/403/418/429/451 → page.close()`는 요청 역할을 구분하지 않았다. `/m/r` 거절을 보고 전체 진단을 종료한 것은 **실패 범위를 너무 넓게 잡은 판정 오류**다. HTTP 상태 코드는 개별 요청의 결과이며, 그 요청이 상품 목록 또는 필수 초기화에 어떻게 연결되는지 입증하지 않고 전체 수집 상태로 승격하면 안 된다. [HTTP 403 정의](https://www.rfc-editor.org/rfc/rfc9110.html#name-403-forbidden).

이를 고친 별도 진단기로 Vercel `icn1` Chrome에 한 번만 탐색하고 정상 렌더링을 12초 관측했다. 미분류 부가 요청 오류는 기록하되 즉시 페이지를 닫지 않았고, 쿠키 반입·수동 API 재시도·운영 변경은 하지 않았다.

- 최상위 문서는 Puppeteer와 CDP 응답/실제 헤더 상태 모두 **200**이었다. `text/html; charset=utf-8`, gzip 전송이며 디코딩된 HTML은 704,172 bytes다. 제목과 한글 DOM 텍스트를 읽었으므로 적어도 이 문서의 상태 코드나 gzip/UTF-8 해석이 403으로 잘못 바뀐 것은 아니다.
- `/m/r`은 **POST, Fetch, 403, text/html**이었다. CDP initiator 스택에는 `assets.coupangcdn.com/customjs/sec-g/1.2.11/sec.min.js`와 fetch wrapper가 기록됐다. 알려진 골드박스 위젯과 다른 요청이다. 이 요청의 응답 본문은 확보되지 않았고 정확한 역할·목록 초기화와의 인과관계는 여전히 미확인이다.
- DOM과 스크린샷에는 헤더·내비게이션·푸터만 보였다. 관측 시점의 `/vp/products/` 상품 링크는 0개, 알려진 위젯 응답은 0회였다. 이는 해당 렌더링의 관측값이지 전체 상품 수가 0이라는 뜻이 아니다. HTML의 모든 내장 JavaScript/RSC 데이터를 해석한 결과도 아니다.
- 상품 화면의 `app/mlp/web/layout-*.js`를 포함한 스크립트 5개와 이미지 2개에서 `net::ERR_INSUFFICIENT_RESOURCES`가 관측됐다. HTTP 403과 별도의 브라우저 로딩 실패다. 구체적인 OS/브라우저 자원 원인과 빈 상품 영역의 인과관계는 확인하지 못했으므로 메모리 부족이나 쿠팡 차단 하나로 단정하지 않는다.

따라서 현재 판정은 **문서 수신 성공 / 일부 리소스 로딩 실패 / 상품 목록 초기화·수집 미검증**이다. 이 정정은 앞선 운영 bootstrap endpoint의 실제 HTTP 403 기록을 없애지 않는다. 운영 코드는 대상 bootstrap의 `response.status`를 읽고 있었으며, 전체 브라우저 요청을 일괄 실패 처리한 진단기와 다른 경로다.

요청 역할 분리와 200 오류 본문·미확인/빈 목록 구분에 대한 오프라인 테스트 8개를 통과했다. 실행 근거는 `coupang-http-semantics-result.json`, 화면은 `coupang-http-semantics-page.png`다. Sandbox는 종료했으며 상품 저장과 운영 Cron 변경은 없다.

### 2026-10-17 22:17 KST — 브라우저 렌더링과 HTML 내장 상품 데이터 확인

Vercel `icn1`에서 2 vCPU/4 GB와 작은 `/dev/shm`을 대신하는 파일 기반 공유 메모리 설정으로 한 번 관측했다. Chrome의 보안 sandbox는 유지했고, 계정 쿠키를 가져오지 않은 새 공개 방문 문맥을 사용했다. 브라우저와 CDP 클라이언트는 같은 Vercel VM 안에서 실행됐다. 이 실행에서는 이전의 리소스 로딩 오류가 관측되지 않았고 실제 골드박스 상품 화면이 표시됐다. CPU/메모리 크기와 공유 메모리 설정을 함께 바꿨으므로 원인을 RAM 하나로 확정하지 않는다.

문서는 HTTP 200, 디코딩된 HTML 710,396 bytes였다. DOM에는 상품 링크 282개와 서로 다른 정확한 SKU 링크 94개가 있었고, HTML Flight 안의 정확한 상품 위젯(`43145`, 페이지 `3712`)에는 **100행과 실제 다음 `dataUrl`**이 있었다. 별도의 알려진 위젯 XHR 응답이 없더라도 첫 페이지 상품은 HTML에 포함될 수 있다. `/m/r`의 403도 같은 실행에서 관측됐으므로 그 상태만으로 상품 조회 실패를 판정하는 것은 명백히 잘못이다.

HTML은 보호 저장한 뒤 오프라인 분석했다. Flight `T<16진수 바이트 길이>,본문` 레코드 뒤에 개행 없이 다음 상품 모델이 붙는 경우가 있었다. 단순 줄 분리나 script 순서 뒤집기로 우연히 추출한 값을 정식 파서로 사용하지 않는다. 문서 순서를 보존하고 UTF-8 **바이트 길이**를 따라 텍스트 프레임을 건너뛴 뒤, JSON literal만 읽어 정확한 위젯을 선택한다. `eval`이나 임의 스크립트 실행은 필요 없다.

오프라인 정규화 결과는 SKU 100개, 정확한 소비자 URL 94개, 추적 전용 URL 6개였다. 일반 가격은 100개, WOW 표시 가격은 87개(할인가 85개·가입 쿠폰가 2개)였다. 추적 링크를 임의 상품 URL로 만들어 저장하지 않고 조건부 가격을 일반 적용가로 바꾸지 않는다. 관측된 HTTP CDN 이미지는 허용된 두 쿠팡 이미지 호스트만 HTTPS로 정규화하되 실제 이미지 로드 성공과는 별도 증거로 취급한다.

이 절의 실험은 **첫 페이지 렌더링·파싱 성공**이며 페이지 소진이나 운영 DB 저장의 증거는 아니다. 실행 후 VM을 종료했다. 근거는 `coupang-resource-html-result.json`, `coupang-resource-html-page.png`와 HTML SHA-256 `0046176b709f9bca23cae96e6af0f6d12ec305009471b87be508cdf5b692bd0e`다. 원시 HTML·방문자 값·opaque continuation은 Git에 보관하지 않는다.

### 2026-10-17 22:56 KST — 실제 UI의 다음 페이지 요청도 별도로 검증

운영 후보 reader를 같은 Vercel VM 환경에서 검증했다. 첫 수동 continuation 관측은 HTML 100행/정확한 상품 94개 다음의 요청이 HTTP 403이었다. 이를 누락 헤더나 토큰 문제라고 단정하지 않고 실제 문서가 참조한 공개 앱 번들을 분석했다. `window.__root_state__.headers`의 세 헤더 값은 기존 요청과 일치했다. 앱은 상품 리스트 뒤의 IntersectionObserver sentinel에서 받은 `dataUrl`을 Axios XHR로 호출했다. 수동 fetch와 실제 앱 호출의 차이는 확인했지만, 특정 헤더 하나를 거절 원인으로 입증한 것은 아니다.

이어 수동 fetch·헤더 재구성 없이 실제 SKU에 연결된 리스트의 sentinel로 스크롤하고, 탐색 전부터 앱의 응답을 수동 개입 없이 관찰했다. Vercel `icn1` Chrome의 문서는 HTTP 200, HTML 상품은 99행, 정확한 소비자 URL과 일반 가격·이미지가 있는 것은 93개였다. 추적 전용 목적지 6개는 제외했다. 실제 앱의 **두 번째 상품 페이지 XHR도 HTTP 403**이었고 한 번 관측한 뒤 재시도하지 않았다. 이 403은 앞선 미분류 `/m/r` 오류와 달리 정확한 continuation 요청에 연결된 실패다.

따라서 byte-framing 파싱 수정과 첫 페이지 회복은 검증됐으나, **네이티브 UI로 바꾸는 것만으로 전체 페이지 순회가 해결되지는 않았다.** HTML 200, WebSocket 연결 성공, 첫 페이지 상품 93개를 전체 수집 성공으로 합치지 않는다. 일반 페이지 수/요청 수와 브라우저 부가 요청 수를 따로 기록하며, 정확한 다음 URL만 매칭하고 페이지 5개·네이티브 스크롤 4회·총 브라우저 요청 1,000회로 제한한다.

이 후보는 실패 전 검증된 행을 보존한다. 운영 적용 시에도 유효 행의 원자적 저장과 원천 차단 상태를 함께 남기고, 누락 상품을 품절로 처리하거나 실패 코드를 지워 정상 상태로 만들지 않는다. 실제 운영 저장·화면 확인은 별도의 증거가 필요하다. 근거는 `coupang-goldbox-browser-manual-fetch-result.json`, `coupang-goldbox-browser-native-ui-result.json`, `goldbox-browser-preflight-subset-proof.json`이다. 마지막 파일의 `partialReaderVerified=true`와 `fullCollectionVerified=false`는 서로 다른 판정이며 운영 성공 증거가 아니다. 계정 쿠키 반입·로컬 상품 업로드는 없고 생성한 VM을 종료했다.

### 2026-10-17 23:30 KST — Vercel → DB → 운영 화면의 부분 회복 확인

Lifehack production `c6c9e48b8d9ed9b390a24d5cbd82cdb7a2b0eaac` / deployment `dpl_5333yC8dBCMZP5GiBt7iRRfK6ucw`를 READY와 원격 main SHA로 확인했다. 기존 직접 bootstrap 실패의 특정 보류만 이력·결과 hash를 보존해 해제하고, 바뀐 reader를 운영 Cron에서 한 번 실행했다. 새 실패의 보류는 다시 해제하지 않았다.

- 23:23:50~23:25:11 KST 실제 source run `43990a7e-491f-4ad7-a398-61a49d7faa11`: Vercel `icn1`, Chrome 151, CDP WebSocket 연결, 문서 HTTP 200, 브라우저 리소스 실패 0회, VM 종료 확인. PC는 배포·검증만 수행했고 상품을 업로드하지 않았다.
- 첫 페이지 **100행 중 정확한 SKU 상품 94개를 저장**했다. 독립 DB readback은 해당 신규 writer 기준 0 → 94개, 가격 94개·이미지 URL 94개·정확한 상품/옵션/판매자상품 대상 94개였다. 추적 전용 목적지 6개는 제외했다. 일반가와 조건부 표시 가격을 분리했으며 새 제휴 링크 발급은 0개다.
- 실제 앱의 다음 페이지는 다시 403이었다. source 상태 `blocked`, `COUPANG_GOLDBOX_WIDGET_HTTP_REJECTED`, `paginationExhausted=false`, `snapshotComplete=false`를 그대로 저장했다. source의 `persisted=true`는 이번에는 유효 상품 94개와 실패 receipt가 함께 저장됐다는 뜻이다. 바깥 Cron도 완료된 `HTTP 503 COUPANG_GOLDBOX_WIDGET_HTTP_REJECTED` 기록을 남겼으며 정상 성공으로 바꾸지 않았다.
- 운영 UI는 데스크톱 1280px에서 저장된 피드 cursor 4페이지를 따라 **94개 전부**, 모바일 390px에서 2페이지의 60개를 대조했다. 양쪽 상품 상세는 200, 확인한 상세 이미지들은 HTTPS 로드 성공, 스크립트 오류·가로 overflow 0이었다. 브라우저에서 collector Cron을 호출한 횟수도 0이다. 수집과 공개 읽기 경로는 분리돼 있다.
- UI 검증기의 첫 시도는 query-only `?before=...` 링크를 현재 `/shopping` 대신 사이트 루트에 결합해 홈으로 이동했다. 검사 도구의 URL 기준을 현재 페이지로 고치고 3개 오프라인 URL 사례와 전체 UI 흐름을 다시 확인했다. 이는 운영 사이트의 더 보기 링크나 원천 상품 페이지가 실패한 증거가 아니다.

정기 Cron은 매시 22분으로 등록돼 있다. 다만 새 원천 보류는 **2026-10-18 23:25:11 KST**까지이고, 그 뒤의 첫 정기 시도 슬롯은 **2026-10-19 00:22 KST**다. 등록된 시간표를 매시 실제 수집 성공으로 보고하지 않는다. 공개 첫 페이지 부분 회복은 입증됐지만 **두 번째 페이지 거절이 남아 있어 전체 골드박스 수집은 여전히 미완료**다.

앱 `npm ci`, typecheck, build와 전체 테스트 **1,301/1,301**을 통과하고 로컬 데스크톱·모바일의 표시된 demo 흐름도 확인한 뒤 배포했다. 로컬 demo를 운영 증거로 사용하지 않았다. 최종 운영 근거는 `goldbox-browser-partial-production-proof.json` (`partialPipelineVerified=true`, `fullCollectionVerified=false`), `retail-db-management-goldbox-browser-proof.json`, `goldbox-ui-production.json`, `card-goldbox-release-status.json`이다. 전체 수집 성공을 요구하는 별도 proof 기준은 낮추지 않았다.

### 2026-10-17 23:45 KST — 동일 HTTP reader를 로컬과 Vercel에서 대조

앞의 로컬 HTTP 성공과 Vercel 브라우저 실패만으로는 요청 방식과 실행 환경이 동시에 달라 원인을 좁히기 어려웠다. 이번에는 Playbook의 HTTP reader와 익명 방문자 모듈을 **하나의 번들로 만들어 동일 바이트를 양쪽에서 각각 한 번 실행**했다. SHA-256은 `26bca646cce4c5198bdb1d7e106e88c2fe7ca75c887de037834dc51dbc95149e`다. owner credential·기존 계정 쿠키·local 상품 데이터는 VM에 공급하지 않았다.

| 항목 | 로컬 Windows | Vercel Sandbox `icn1` |
| --- | --- | --- |
| 실행 시각 (KST) | 23:44:51 | 23:45:49 |
| Node | 24.22.0 | 24.21.0 |
| Undici / OpenSSL | 7.29.1 / 3.5.8 | 7.29.1 / 3.5.8 |
| 첫 익명 bootstrap | GET, Cookie 없음, HTTP 200 | 같은 application-level 요청, HTTP 403 |
| 상품 JSON | 99행 + 101행, 모두 HTTP 200 | 미시도 — bootstrap에서 중단 |
| 전체 행 / 정확한 소비자 대상 | 200 / 193, 추적 전용 7개 제외 | 관측 0행, 실제 원천 목록 크기는 미확인 |
| 페이지 소진 | 확인 | 확인 못 함 |
| 재시도 / 상품 DB 쓰기 | 0 / 0 | 0 / 0 |

로컬은 자연 발급한 `PCID`, `x-coupang-accept-language`, `x-coupang-target-market` 세 익명 쿠키만 상품 요청에 사용했다. 로그인이나 브라우저 전체 계정 쿠키가 로컬 성공의 필수 조건이었다는 근거는 없다. 클라우드 실패는 쿠키를 발급받는 첫 요청에서 발생했으므로 이를 상품 파싱 실패로 설명할 수도 없다. 실패한 bootstrap 뒤에 다른 endpoint를 추측 호출하거나 방문자·IP를 교체하지 않았다. VM은 종료했다.

같은 코드와 같은 초기 요청 형태에서 **환경에 따른 실제 HTTP 응답 차이**가 확인됐다. 다만 네트워크/서버 판정, OS, Node patch, TLS/HTTP의 차이는 여전히 남으므로 출구 IP 하나를 확정 원인으로 보고하지 않는다. 현재 app pure-HTTP와 Playbook reader의 요청·순회·JSON 계약은 같고, 앱의 주요 추가 차이는 허용된 CDN 이미지의 HTTPS 정규화다. 이 변환은 bootstrap 전에 발생하는 403의 설명이 아니다.

23:51 KST 운영 credential metadata에서는 Partners `web_session=ready`, `open_api=unconfigured/has_credential=false`였다. 두 인증을 같은 것으로 취급하지 않는다. 공식 API로 바꾸기만 하면 공개 전체 200행을 얻는다는 사실도 확인되지 않았다. 다음 검증의 전제는 원천 측에서 허용된 Vercel 접근 경로나 유효한 공식 API 인증과 목록 범위다. 고정 IP 구매·프록시·PC 중계를 해결로 간주하거나 구성하지 않았다.

이번 비교로 실패하는 HTTP 경로를 운영에 배포하지 않았고, production은 앞 절의 **94개 부분 저장 + 다음 페이지 403** 상태를 유지했다. 보류 해제·추가 Cron 실행·계정 쿠키 이전·로컬 상품 업로드는 없었다. **전체 수집 미해결**이며, 측정 결과와 원인 한계를 [sanitized comparison receipt](../sanitizedverification/coupang-runtime-parity-2026-10-17.json)에 보존했다. 이 영수증의 정합성 검사는 hash 불일치·요청 차이·누락 상태·가짜 cloud 행·VM 미종료·로컬 업로드·가짜 운영 성공 등을 거부하는 오프라인 10개 사례를 통과했다. 이는 새 운영 구현의 테스트나 수집 성공 증거가 아니다.
