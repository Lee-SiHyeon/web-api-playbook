# Coupang: 소스 후보를 계약으로 오인하지 않기

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
