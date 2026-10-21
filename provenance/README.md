# 코드와 경험의 출처

| 파일 | 의미 |
|---|---|
| [service-packs.json](service-packs.json) | Naver/Tistory/X 저장소 URL·commit·추출 파일별 원본 SHA-256 |
| [skill-origin.json](skill-origin.json) | 원래 개인 스킬의 hash와 초기 출처 표기 |
| [additional-sources.json](additional-sources.json) | Affiliate, OliveYoung, Threads, 기존 스킬 reference의 파일별 원본 hash와 소스 상태 |
| [non-naver-sources.json](non-naver-sources.json) | 비 Naver 사례별 근거 코드/문서/영수증, 관측 경계 |
| [web-auth-2026-09-24.json](web-auth-2026-09-24.json) | 웹 인증 실행기와 기존 X 수집기 이식 출처·변경 범위 |
| [playbook-strengthening-2026-10-11.json](playbook-strengthening-2026-10-11.json) | 기존 MyRealTrip snapshot의 검증 보강·Toss import 경계 수정과 운영 절차 출처 |
| [myrealtrip-official-search-2026-10-11.json](myrealtrip-official-search-2026-10-11.json) | 현재 공식 TNA 검색 계약·실제 인증 조회·시작가 KRW와 읽기/발급 경계 |
| [creator-public-data-2026-10-11.json](creator-public-data-2026-10-11.json) | 공개 RSS/JSON/GraphQL의 실제 출처·native/web client 경계·다섯 상태·dated replay와 최신 guard hash 구분 |
| [verification](../verification/README.md) | 새 패키지의 설치·정적 확인 범위 |

`sourceSha256`는 **원본에서 읽은 바이트**의 hash입니다. 해당 파일이 이식 과정에서 수정됐다면 패키지 현재 hash와 다를 수 있으며 아래 변경 목록을 함께 봅니다. Git의 package commit 자체가 배포된 내용을 고정합니다.

`.gitattributes`가 텍스트 줄바꿈을 정규화하므로 Git blob hash/checkout 바이트가 원본 CRLF 스냅샷 hash와 다를 수 있습니다. Coupang capture PowerShell 파일의 불필요한 마지막 빈 줄도 제거했습니다. 실행 내용 변경과 줄바꿈 변경을 구분합니다.

## 이식 변경

- 공통 core/CLI/README/SKILL/템플릿: 기존 경험에서 추출한 새 독립 구현. service snapshot의 line-by-line 동일 사본이 아닙니다.
- 기존 스킬 reference 4개: 세부 방법 보존. runtime-credential-propagation에 보호 저장·이식 안내를 추가했습니다. 현재 SKILL/README가 OS·보호 저장·테스트 실행 범위의 진입점입니다.
- Affiliate: 원래 `apps/affiliate-api-hub`와 `packages/contracts` 상대 경로 유지; pack 전용 root package/lock/README 추가.
- Naver/Tistory pack README: 통합 저장소의 폴더 기준으로 설치 명령을 변경. 원래 hub README는 historical banner를 추가.
- Naver `research/trend-radar/build-vertical-brief.mjs`와 `tests/travel-vertical-profile.test.mjs` (2026-10-21): 여행 adapter registry의 원래 인접 app 경로를 우선 유지하고, 파일이 없을 때 패키징된 `service-packs/affiliate/apps/affiliate-api-hub/references/travel-adapters.json`으로 fallback. 두 배치와 잘못된 JSON의 오류 보존을 합성 fixture로 검사하며 원본 source hash는 변경하지 않음.
- Tistory `recipes/build-post-with-media.mjs`: 실제 이식 작업의 순수 변환 함수를 추가하고 절대 import를 pack 상대 경로로 변경. 네트워크 발행이나 작업 manifest는 포함하지 않음.
- OliveYoung: 원본의 미커밋 adapter/script/docs/contract/helper 및 기존 test 코드 보존; 전체 저장소에 커밋됐었다고 표시하지 않음.
- Threads: XHR 모듈의 vault import를 독립 helper로 교체, cached receipt 라벨을 provider 중립으로 변경. 새 helper는 root의 protected store를 쓰며 Windows는 DPAPI, 다른 OS는 명시적 process memory. 서버 로그인 자동화로 확장하지 않음.
- 원본의 `node_modules`, raw capture, runtime 결과, 브라우저 프로필, credential 파일은 복사하지 않음. 기존 service pack test 소스는 보존했으며 이 패키징에서 실행하지 않음.

## 기록하는 방식

대화 원문이나 시스템 메모리 전체를 배포하지 않습니다. 서비스에 필요한 관측 결과를 사례 문서로 재작성하고 코드/계약 위치를 연결합니다. 개인 machine 절대 경로를 새로운 실행 의존성으로 만들지 않으며, 기존 역사 문서의 경로는 당시 맥락으로만 취급합니다.

신뢰할 수 있는 source hash는 원본과의 동일성 근거이며 서비스 동작의 증거는 아닙니다. `captured`/`client_exists`/`credential_propagated`/`remnant_free`/`live_replay`는 각 사례의 근거로 따로 판정합니다. private 저장소라 해도 실제 인증값은 커밋하지 않습니다.
