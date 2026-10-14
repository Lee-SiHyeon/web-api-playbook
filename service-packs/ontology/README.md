# 온톨로지 공개 HTTP 원천

원격 온톨로지와 실제 클라이언트를 대조해 빠진 원천을 확장한 고정 사본이다. 정기 읽기는 브라우저 엔진 없이 Node.js HTTP로 실행한다. 소비자 GraphQL/JSON, 서버 렌더 HTML과 관측된 공개 상세 폼 요청을 구분한다. 공식 제휴 API로 소비자 웹 계약을 대체하지 않는다.

## 설치와 실행

이 폴더에서 Node.js 24로 실행한다.

```powershell
npm ci --ignore-scripts
npm test
npm run verify:live -- --out=./work/live-verification.json
npm run notices -- --out=./work/notices.json
npm run notices -- --source=sh-notices --limit=10 --detail-limit=2 --out=./work/sh.json
npm run travel -- yanolja-search 강릉
npm run travel -- modetour-packages 다낭
npm run modetour:document -- --out=./work/modetour-document.json
npm run modetour:document -- --browser-evidence=verification/modetour-browser-http-2026-10-15.json --out=./work/modetour-comparison.json
```

기본 공고 수집은 정책브리핑과 SH를 한 페이지·상세 한 건씩 읽으며 세 원천의 receipt를 모두 남긴다. 국토부는 현재 동일 URL 307 리다이렉트로 실패해 자동 수집에서 제외한다. `--molit`은 명시적인 수동 진단이며 실패를 성공 빈 목록으로 바꾸지 않는다. 일정과 정책 기사는 분리하며 공고 등록일을 접수일·마감으로 대신 쓰지 않는다.

## 구현과 확인 범위

| 원천 | HTTP 동작 | 경계 |
|---|---|---|
| SH | 공개 진입·주택임대 목록 GET, 관측된 상세 form POST | 제한된 목록·상세; POST 상세는 목록 URL과 공고 ID로 인용; 표시된 주거 일정만 정규화 |
| 정책브리핑 | 목록·관측 상세 링크 Document GET | 제한된 보도자료 페이지이며 신청 자격·기간을 추정하지 않음 |
| 국토부 | 목록 Document GET 파서 | 현재 307/self-redirect로 live replay 실패; 자동 호출 제외 |
| NOL/야놀자 | 공개 숙소 키워드 검색 Document GET | 실제 첫 페이지 8개 카드; v2 XHR은 404 미해결, 날짜·인원·페이지 요청 옵션 미지원 |
| 모두투어 | 현재 익명 컨텍스트 발급, 추천 상품·ID별 상세 JSON GET | 추천 피드·선택한 상세만; 컨텍스트/요청 헤더 값은 메모리에만 유지; 통화·가격 기준·날짜별 재고는 미확인 |
| 모두투어 최초 Document | `/package/overseas` HTML GET의 `__NEXT_DATA__` 추천 데이터 파싱 | 쿠키·SDK 헤더 없이 추천 10개; 화면의 상품명·표시가 10/10 일치; 다른 섹션과 날짜별 재고는 제외 |

`src/travel-price/collect-live.mjs`의 네이버 해외호텔과 Agoda 명령은 같은 저장소에서 이미 유지하던 관측 HTTP reader도 제공한다. 네이버는 공개 검색 JSON을 stdin으로 받는다. Agoda 요금은 알려진 숙소 ID·숙박 날짜·인원 입력이 필요하며 전체 숙소 검색 기능은 아니다. 입력 계약은 [원본 travel reader 문서](https://github.com/Lee-SiHyeon/affiliate-content-operations/blob/main/apps/naver-blog-api/research/content-store/travel-price/README.http-clients.md)를 참고한다. 이 pack의 CLI 목록에서 없는 기존 여행 명령은 포함하지 않는다.

## 증거

출처와 파일 SHA-256은 `provenance.json`, 현재 직접 재현 receipt는 `verification/`에 둔다. 원시 인증 쿠키·API 컨텍스트·생성된 요청 헤더와 프로필은 복사하지 않는다. 공개 fixtures는 구조·필드 검증용이며 오늘의 가격·재고 증거로 쓰지 않는다.

`scripts/verify-live.mjs`를 통한 2026-10-15 직접 읽기에서 정책브리핑 12건, SH 10건, NOL 8건, 모두투어 추천 10건과 다낭 상세 1건을 확인했다. 제한된 목록이므로 `snapshotComplete=false`다. 상세 처리와 파서 구조는 원천별 receipt와 37개 테스트로 구분해 확인한다. 국토부는 기본 실행에서 건너뛴 차단 원천이다.

이번 실행의 실제 브라우저 캡처가 없는 동작은 `captured=false`다. `client_exists`, 브라우저 의존성 기준의 `remnant_free`, 익명 요청의 `credential_propagated=not_applicable_anonymous`, 직접 응답을 확인한 `live_replay`는 각각 별도로 기록한다. Windows Canary 재실행과 확장 선택 확인은 실제 XHR 캡처·계정 인증을 증명하지 않는다.

후속 Canary 재관측에서 페이지 로딩의 Network 이벤트 629개를 버퍼 손실 없이 수집했다. Document·Fetch·XHR 외 이미지·스크립트·스타일 등의 유형도 포함했고, 관련 퍼스트파티 Document·Fetch·XHR 요청/응답 11쌍을 `verification/modetour-browser-http-2026-10-15.json`에 인증값 없이 기록했다. `Network.getResponseBody`는 브라우저 도구의 pending document 응답으로 사용할 수 없었으므로 브라우저 본문 해시나 원문 일치는 주장하지 않는다.

독립 `modetour:document`는 관측된 HTML GET 한 번으로 `__NEXT_DATA__` 안의 추천 10개를 파싱한다. `verification/modetour-document-http-2026-10-15.json`은 이 Document 계약의 `captured=true`, 실제 HTTP 재현과 화면 상품명·표시가 10/10 대조를 기록한다. 기존 JSON 추천·상세 엔드포인트는 별도 계약이므로 그 캡처 상태를 올리지 않는다. 목록 표시가와 상세 기준가가 다른 경우도 그대로 보존하며, 표시되지 않은 통화·가격 기준을 추정하지 않는다.

Document 파서·명령·테스트·축약 공개 fixture는 이 pack에서 추가한 구현이다. 기존 `provenance.json`의 41개 donor 파일 해시와 구분한다. 원시 HTML에는 다른 상태가 섞일 수 있으므로 본문은 메모리에서만 처리하고 허용한 상품 필드만 출력한다. 루트에서 `node scripts/checklist.mjs --service=ontology-modetour --run-tests --strict`로 해당 범위의 구현과 날짜가 명시된 근거를 확인할 수 있다.

루트의 [원격 감사](../../references/ontology-xhr-extension-audit-2026-10-14.md)는 536행 정적 인벤토리와 이번에 작업한 원천을 구분한다. 제한된 표본·가격 의미의 결측을 보존하며 지급 총액·전체 재고·최저가를 주장하지 않는다.
