# 원격 온톨로지 원천 확장 감사

2026-10-14에 GitHub의 default branch와 로컬 구현을 대조했다. 기존 작업 폴더의 미커밋 변경은 그대로 두고 아래 기준에서 별도 worktree를 만들었다.

2026-10-15 범위 보완: 아래 여행·공고 8개 원천은 전체 요청 범위가 아니다. 사용자가 명시한 알리를 포함해 온톨로지의 해외 쇼핑 원천 `aliexpress`, `temu`, `shein`, `iherb`를 [별도 확장 기록](overseas-retail-expansion-2026-10-15.md)과 [미완료 탐색 목록](overseas-retail-frontier.json)에 추가했다. HTML Document와 XML도 관측·구현 대상으로 포함한다.

| 저장소 | 원격 main 기준 |
|---|---|
| Lee-SiHyeon/web-api-playbook | `696b588100df6cf026b57cd71e85ad5360bd7e24` |
| Lee-SiHyeon/affiliate-content-operations | `314ff907afd0e03552cf13b162d7218ae125e78a` |
| Lee-SiHyeon/lifehackailab-web | `d270ffd1211c6cd78a3168be8f501204e0f49157` |
| Lee-SiHyeon/naver-shopping-travel-crawler | `807592f5306e759432d2654b2f7bf469e66413e1` |

`xhr-to-api-only` 로컬 폴더는 별도 원격 저장소가 아니라 `web-api-playbook`의 오래된 checkout이었다. 원천 온톨로지는 affiliate-content-operations의 `apps/naver-blog-api/research/content-store`, 운영 웹 수집기는 lifehackailab-web의 `src/lib/hub/ontology`에 있다.

## 실제 구현과 등록의 차이

| 원천 | 확인한 차이 | 이번 작업 |
|---|---|---|
| SH | 공고 목록 미확인·`html_only`; 소비자는 LH만 사용 | 공개 내비게이션 → 주택임대 목록 → 관측된 상세 form 요청의 HTTP reader |
| 국토교통부 | 공개 보도자료 목록 URL만 등록; 파서 없음 | Document GET 목록·상세·관측 페이지 링크 파서 |
| 정책브리핑 | 공개 부처 보도자료 URL만 등록; 파서 없음 | Document GET 목록·상세·관측 페이지 링크 파서 |
| 하나투어 | 패키지 bundle 경로는 알려졌지만 독립 목록 재현은 인증 거부 | 현재 퍼스트파티 입력과 익명 공개 대안 재검증 |
| 모두투어 | 관측된 POST가 필수 요청 헤더 없이 401 | 현재 SDK 입력과 익명 공개 대안 재검증 |
| NOL/야놀자 | 기존 상세 reader와 오래된 검색 후보만 등록 | 현재 소비자 검색 버전·base origin·본문을 재관측하고 직접 재현 |
| 네이버 해외호텔 | affiliate reader는 있으나 기능 목록·독립 네이버 클라이언트에는 미구현 | 기존 관측 GraphQL을 독립 네이버 클라이언트와 웹 수집기에 연결 |
| Agoda | 제한된 알려진 숙소용 HTTP reader는 있으나 웹 수집기에는 없음 | 알려진 숙소·날짜 범위를 명시한 웹 수집기 연결 |

노랑풍선·참좋은여행의 기존 제한된 패키지 목록 reader는 새 미구현 사이트로 세지 않는다. 상세·달력·지급 총액의 검증 범위는 목록과 분리한다. 기존 Revu·Wevity와 네이버 국내항공·국내호텔도 중복 구현하지 않는다.

## 증거 범위

- lifehackailab-web의 source-surface seed는 536행의 정적 인벤토리다. `candidate=376`, `collected=76`, `needs_auth=32`, `ignored=52`는 실행 결과나 현재 로그인 상태가 아니다. 전체 536행을 이번에 라이브 검증했다는 뜻으로 사용하지 않는다.
- 초기 감사에서는 브라우저 생성·탭 상태 읽기가 시간 초과했다. 그 시점에 실제 브라우저 요청을 캡처하지 못한 동작은 `captured=false`다. 아래 후속 Document 관측을 제외한 동작은 이 상태를 유지한다. 퍼스트파티 Document, inline source, bundle call-site와 독립 HTTP 응답은 각기 별도 근거다.
- 정기 읽기는 독립 HTTP다. 공개 익명 읽기의 `credential_propagated`는 `not_applicable_anonymous`이며 계정 소유자·권한 증거가 아니다.
- 공개 공고의 발표일을 신청 시작·마감이나 지원 자격으로 바꾸지 않는다. 정책 보도자료는 신청 일정과 별도 출력한다.
- 여행의 검색 표시가·옵션·숙박 날짜·인원·통화·세금/배송의 결측을 보존한다. 확인되지 않은 지급 총액·전체 재고·최저가를 주장하지 않는다.
- 인증이 필요한 원천과 과거 WAF 거부 원천은 검증된 세션/입력 계약을 확보하기 전까지 보류한다. 제휴 상품 API로 소비자 XHR 계약의 미완료를 대신하지 않는다.

각 신규 reader의 현재 응답·수집 수·오류·다섯 검증 상태는 실행 receipt로 확인한다. 단위 테스트는 요청·파서·실패 경계를 검증하며 라이브 인증이나 운영 배포를 증명하지 않는다.

2026-10-15 초기 Canary 종료·재실행 직후에는 탭 생성·읽기가 시간 초과해 `blocked_runtime`이었다. 이후 재시도에서 탭 읽기와 마우스 클릭이 복구되었고, 후속 페이지 재로드의 모든 HTTP 유형을 관측했다. 과거 실패 receipt는 그대로 보존한다.

후속 관측은 [브라우저 HTTP 기록](../service-packs/ontology/verification/modetour-browser-http-2026-10-15.json)과 [독립 Document 재현](../service-packs/ontology/verification/modetour-document-http-2026-10-15.json)에 있다. Document GET `/package/overseas`의 200 HTML 응답, Fetch·XHR 지원 요청을 포함해 관련 11쌍을 확인했다. 초기 HTML의 `__NEXT_DATA__`를 직접 HTTP로 파싱해 추천 10개와 화면 상품명·표시가 10/10 일치를 확인했다. 이 Document 계약의 캡처가 확인된 것이며, 서버에서 미리 채운 JSON의 캐시 키가 같은 이름의 브라우저 XHR을 증명하지는 않는다. 다른 사이트·동작의 `captured=false`는 바뀌지 않는다.

독립 pack의 `scripts/verify-live.mjs`는 정책브리핑 12행·SH 10행·NOL 첫 페이지 8행·모두투어 추천 10행과 선택 상세 1행을 읽었다. 국토부 307 리다이렉트는 자동 실행에서 제외했다. 하나투어의 현재 입력을 갖춘 공개 요청은 HTTP 500 / `E_003` / 상품 0행이므로 새 성공 클라이언트로 등록하지 않았다. 웹 수집기는 네이버 해외호텔 20행·Agoda 16행을 직접 읽었고 Agoda의 가격 미확인 2행을 부분 수집으로 보존했다. 이 결과는 로컬 직접 HTTP 검증이며 배포 증거가 아니다.
