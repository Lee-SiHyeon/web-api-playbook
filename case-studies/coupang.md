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
