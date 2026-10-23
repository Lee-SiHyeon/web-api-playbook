# 저장소별 웹 클라이언트 통합

2026-10-23 GitHub에서 접근 가능한 Lee-SiHyeon 소유 저장소 44개를 열거했습니다.
관련 21개의 tracked tree를 확인하고, 이관 대상은 필요한 소스를 추가로 확인했습니다. 도메인 앱·알고리즘·렌더러·개발 도구는 별도 목적을 기록했습니다.
원본의 웹 HTTP/XHR/SDK client와 실행에 필요한 계약·의존성·회귀 테스트를 이 저장소에 모았습니다.
전체 앱·계정 데이터·스케줄러 이관과 개별 source의 미구현 기능 완성은 별도 범위입니다.

~~~sh
npm ci --ignore-scripts
npm run clients
npm run --silent gemini -- help
npm run --silent grok -- help
npm run --silent chatgpt -- help
npm run --silent flow -- help
npm run --silent client -- --service=automation -- partners --help
npm run --silent social:actions -- capabilities
npm run --silent readers -- describe
~~~

루트 CLI는 원본 stdin과 native guard를 유지합니다. 상대 입력/출력 파일은 호출한 폴더 기준입니다.
Adpick/Whisk 등 라이브러리 client는 describe와 각 README에서 API handler/export를 확인합니다.

| Client | 위치 | 실행 모드 | 포함 범위 |
|---|---|---|---|
| gemini | [service-packs/gemini](../service-packs/gemini/README.md) | pure_http_with_observed_session_inputs | owner, history, text, models, settings, sharing, attachments, media |
| grok | [service-packs/grok](../service-packs/grok/README.md) | operation_specific_http_or_websocket | owner, conversations, workspaces, model-selection, text, attachments, media |
| chatgpt | [service-packs/chatgpt](../service-packs/chatgpt/README.md) | pure_http_contract_gated | contracts, session, read, stream, send, media, reconciliation |
| google-flow | [service-packs/google-flow](../service-packs/google-flow/README.md) | phase_specific_http_with_optional_profile_or_gflow | project-media, generation, download, session, profile-sync |
| google-flow-bridge | [service-packs/google-flow-bridge](../service-packs/google-flow-bridge/README.md) | browser_automation | project-media, generation, download, reconciliation |
| gemini-bridge | [service-packs/gemini-bridge](../service-packs/gemini-bridge/README.md) | phase_specific | protocol, bootstrap, verification |
| grok-public-modes | [service-packs/grok-public-modes](../service-packs/grok-public-modes/README.md) | pure_http | public-models |
| adpick | [service-packs/adpick](../service-packs/adpick/README.md) | pure_http | login, search, campaigns, malls, links, sdk, banners, reports |
| threads-actions | [service-packs/threads-actions](../service-packs/threads-actions/README.md) | pure_http_with_caller_session | profile, views, publish, reply |
| naver-shopping | [service-packs/naver-shopping](../service-packs/naver-shopping/README.md) | pure_http | feed, integrated-search, product, reviews, travel |
| naver-travel | [service-packs/naver-shopping](../service-packs/naver-shopping/README.md) | pure_http | flights, calendar, price-graph, hotels, hotel-rates, travel-products |
| coupang-shopping | [service-packs/coupang-shopping](../service-packs/coupang-shopping/README.md) | pure_http | feed, deals, sections, find, categories, banner |
| naver-cafe | [service-packs/naver-cafe](../service-packs/naver-cafe/README.md) | pure_http_with_protected_session | read, session, management, attachments |
| social-actions | [service-packs/operations](../service-packs/operations/README.md) | operation_specific_http_with_declared_session_provider | capabilities, prepare, execute, reconcile, instagram, tiktok, youtube, naver-clip |
| affiliate-operations | [service-packs/operations](../service-packs/operations/README.md) | operation_specific | provider-contracts, shopping, vendor-reviews, places, creator-reads, media |
| automation | [service-packs/automation](../service-packs/automation/README.md) | pure_http_with_caller_session | categories, partners, reports, reviews, measurements, price-check, intake, public-health |
| whisk | [service-packs/whisk](../service-packs/whisk/README.md) | pinned_sdk_not_live_verified | projects, references, images, media |
| creator-tools | [service-packs/creator-tools](../service-packs/creator-tools/README.md) | helper_specific_http_or_browser_automation | gemini-tts, elevenlabs, myrealtrip, grok-quota, flow-account-ledger |
| lifehack-readers | [service-packs/lifehack-readers](../service-packs/lifehack-readers/README.md) | pure_http_with_operation_specific_credentials | danawa-target, danawa-search, danawa-offers, eleventh, naver-deals, rss, toss-protocol, adpick-projection, coupang-openapi |
| naver-blog | [service-packs/naver](../service-packs/naver/README.md) | phase_specific_http_with_optional_native_sdk_preview | session, owner, posts, statistics, media, publisher, trends |
| tistory | [service-packs/tistory](../service-packs/tistory/README.md) | pure_http_with_protected_session | session, statistics, draft, publish, update, owner-comments, media |
| blogger | [service-packs/blogger](../service-packs/blogger/README.md) | operation_specific_http | web-read, feed-read, oauth-read, journaled-oauth-write |
| social-x | [service-packs/social-x](../service-packs/social-x/README.md) | pure_http_with_caller_provider | profile, timeline, conversations, text, long-text, reactions, reddit |

## 고정 버전과 기존 작업

provenance/repository-inventory-2026-10-23.json에 44개 저장소의 판정과 확인 수준을 남겼습니다.
repository-consolidation, operations-consolidation, additional-client-consolidation,
automation-consolidation, social-x-consolidation, naver-media-consolidation의 같은 날짜 JSON에
원본 commit·source path·source SHA-256·이식 경로·이식 SHA-256을 기록합니다.

기존 Playbook PR #1의 Naver/Tistory, #2의 Blogger, #7의 creator 배포 작업도 로컬 통합 브랜치에 반영했습니다.
GitHub의 기존 PR 상태나 원본 저장소를 변경하지 않았습니다. 원본의 source README는 SOURCE_README.md로 보존했습니다.

## 검증과 한계

~~~sh
npm run doctor
npm test
npm run test:client-packs
npm run audit:consolidation
npm run check:ai
~~~

audit:consolidation은 실제 이식 바이트·파일 존재를 확인하고 모듈을 실행하지 않습니다.
check:ai는 bundled Gemini/Grok의 과거 receipt 일관성을 검사합니다. 미구현·미검증 기능은 incomplete로 남습니다.
로그인·텍스트 전송·영상 생성·업로드·발행은 이 이식에서 실행하지 않았습니다.
Whisk/creator helper와 일부 작은 reader는 원본 offline 테스트가 없어 import/정적 검증 범위를 따로 기록합니다.
Flow의 SDK/전용 프로필/UI 경로와 extension bridge는 각 단계의 브라우저 의존성이 남습니다.

Threads 웹·Graph 게시기는 같은 runKey의 예약을 공유합니다. 미확정 응답·생성 checkpoint·완료 뒤 재실행은 대사가 필요합니다.
첫 게시의 Graph HTTP 4xx와 숫자 오류 코드가 직접 기록된 경우만 예약을 해제하여 웹 fallback을 허용합니다.
일반 수동 대사나 검색 결과 없음으로 예약을 해제하지 않습니다. HTTP 202 뒤 configure 자동 재전송도 제거했습니다.

새 workspace 의존성으로 package-lock.json이 달라져, SHEIN/iHerb의 2026-10-15 실측 증거는 현재 런타임에 그대로 연결하지 않습니다. 원본 영수증은 보존하고 과거 lock fixture 검증과 현재 구현 변경 거부를 따로 검사합니다.
