# 2026-10-15 플레이북 전수조사

**쿠팡 검색 판정 정정 (11:37 UTC 이후):** 아래 최초 표본은 쿠키 없는 Document 진단을 선택해, 이미 유지되던 DPAPI RSC 검색 실행기를 빠뜨렸다. 정상 세션에서 사라진 `bm_mi`를 필수로 요구하던 가져오기 조건을 수정한 뒤, 독립 Node HTTP 검색 **200·60개**, 별도 프로세스 서명 갱신 후 검색 **200·54개**, 자연 만료 후 일반 검색의 자동 갱신 **200·60개**를 확인했다. [재검증과 수정 내역](../coupang-recheck-2026-10-15/README.md), [기계 판독 증거](../coupang-recheck-2026-10-15/summary.json). 최초 40개/378개 집계는 당시 snapshot이며, 이후 `coupang-retail/catalog.search`를 등록했다.

**40개 등록 서비스·378개 기능·7개 서비스 팩의 조사를 완료했다.** 모든 기능이 현재 동작한다는 뜻은 아니다. 필수 미충족 항목은 **190개**이고, 과거 HTTP 실증 기록 61개와 이번 새 HTTP 표본을 구분했다.

- [전체 기능 표](audit.md): 378개 기능, 서비스별 집계, 미등록 실행기 후보, 누락 참조.
- [기계 판독 결과](audit.json): 기존 capability 검사기 결과와 테스트·재고 상세.
- [최초 HTTP 표본](live-samples.json): 읽기 11건 중 **10건 성공·쿠키 없는 Document 진단 1건 403**. 쿠팡의 유지되는 RSC 검색 경로를 대표하지 않는다. 후속 RSC 읽기 3건은 모두 200이다.
- [공개 원천 추가 검사](ontology-live-summary.json): 정책·SH·모두투어의 제한된 읽기 성공, NOL/야놀자 schema 실패와 국토부 건너뜀.
- [브라우저 시도](browser-fixture.json): Rust 바이너리 설치·버전 확인 완료, 합성 캡처는 `blocked_runtime`.
- [검증 기록](validation.json), [HTTP 실행 소스 해시](live-code-hashes.json).

## 적용한 변경

`npm run audit:playbook`으로 기존 기능 체크리스트와 저장소 재고를 한 번에 조사한다. 서로 다른 상태를 합치지 않고 소스·테스트·기록 증거·현장 HTTP 결과를 분리한다. `npm run evidence:browser`는 HAR와 REA 시나리오를 정제된 요청/응답·행동 증거로 가져온다. 요청 본문 구조, 응답 본문 무결성, 누락 집계, redirect·완료 여부를 점검한다. Rust agent-browser 0.39.1을 위한 격리 합성 fixture runner도 추가했다. [실행 방법과 한계](../../references/playbook-audit.md)

전수 검사에서 발견한 애드픽 CLI 테스트의 Windows 경로 오류를 `fileURLToPath`로 수정했다. 기존 서비스 클라이언트·인증·영수증을 새 라이브 성공으로 변경하지 않았다. REA는 형식 adapter와 합성 회귀를 적용했으며 실제 REA 프로세스와의 통합 실행은 아직 검증하지 않았다.

## 등록 기능의 판정

| 상태 | 기능 수 | 의미 |
|---|---:|---|
| recorded_live | 61 | 저장 영수증의 기존 실증; 이번 원격 확인과 별도 |
| verified_local | 17 | 로컬 요구 조건과 테스트 통과 |
| needs_reverification | 21 | 기존 기록을 현재 소스에서 재검증해야 함 |
| pending_live | 16 | 현재 HTTP 실증 필요 |
| blocked | 71 | 인증·계약·환경 등 기록된 blocker |
| unimplemented | 83 | 선언된 기능의 구현 미충족 |
| source_candidate | 30 | 출처·정적 후보 단계 |
| code_inventory | 3 | 구현 재고 확인 범위 |
| scope_unknown | 10 | 적용 범위 결정 필요 |
| not_applicable | 66 | 현재 서비스 범위에 해당 없음 |

선언 테스트 파일 53개 중 **48개 통과**, 아직 구현되지 않은 테스트 파일 **5개 부재**. 전체 root 회귀는 **682건 중 681건 통과·1건 건너뜀·실패 0건**이다. 건너뛴 1건은 실제 Windows credential store를 조회하는 legacy Toss 테스트다. 처음의 Python 별칭 오류 8건은 번들 Python 경로를 명시한 뒤 재검증했다. 테스트 프로세스는 sandbox가 아니며 네트워크 사용 여부를 자동 계측한 결과는 아니다.

## 재고에서 드러난 누락

- 소스 자산 624개, Node 실행기 후보 134개 중 매니페스트 CLI에 직접 연결되지 않은 후보 121개. 공통 도구·진단·발행 도구도 포함하므로 미구현 기능 121개라는 의미는 아니다.
- 브라우저 확장 manifest의 JavaScript 실행 참조와 PowerShell의 로컬 JavaScript 참조 **3개**, browser/UI 문자열 검토 후보 **20개**도 별도 목록에 포함했다. 쿠팡·네이버 확장의 `chrome.debugger`와 native UI 문자열은 반복 HTTP 실행에 남은 의존성인지 별도 확인해야 한다.
- package 명령 138개를 색인했다. 20개는 직접 `node file.mjs` 형태가 아니어서 호출 그래프 해석을 보류했다. Python·PowerShell 등은 소스 재고에 포함하지만 실행하지 않았다.
- 누락 참조는 **고유 경로 11개**다. 5개 구현 모듈, 5개 테스트, 1개 Inpock 실증 파일이며 eBay/Inpock의 계획된 범위에 집중돼 있다. 기능별 중복 참조를 세면 35회다.
- Coupang·Naver·Tistory·affiliate·social-x 등의 실행기가 서비스 기능 매니페스트에 충분히 연결되지 않았다. 이들은 재고 수준으로 조사했으며 쿠팡은 별도 HTTP 표본을 실행했다. 공개 발행이나 계정 쓰기는 실행하지 않았다.
- 6개 기능은 복수 증거 그룹을 가진다. 기존 검사기의 “유효한 그룹 하나면 통과”를 유지하고 별도 검토 목록으로 남겼다.
- Naver catalog 23개가 두 위치에 복제돼 있다. Tistory catalog는 79개다. 이 수를 고유 전체 API 수로 합산하지 않았다.

## 이번 새 HTTP 확인

2026-10-15 09:30–09:33 UTC, 기존 클라이언트를 이용한 익명 읽기다. 브라우저 캡처·계정 인증·제휴 발급·구매·음성 생성·공개 발행은 이번 라이브 표본 범위에 없다. `captured` 등 기존 실행기의 상태는 원문 필드로 남기되, 이번 fresh browser capture는 모든 표본에서 false다. 익명 cookie bootstrap은 계정 credential 전파와 구분한다.

| 표본 | HTTP 및 실제 결과 |
|---|---|
| Amazon 메뉴 | 200 JSON, 37개 메뉴·343개 목적지 |
| Amazon 검색 | 읽기 POST 200 streaming JSON, 상품 16개 |
| Rakuten 홈 | 200 HTML, 메뉴 10개·링크 40개 |
| Rakuten 검색 | 200 HTML, 상품 49개 |
| Yahoo Shopping 홈 | 200 HTML, 카테고리 노드 448개 |
| Yahoo Shopping 상품 | 200 HTML, 상품 1개·옵션 6개 |
| Coupang 카테고리 | 200, JSON 계약 검증, 카테고리 노드 3,228개 |
| Coupang Travel 자동완성 | 읽기 POST 200 JSON, 제안 7개 |
| Coupang 쿠키 없는 검색 Document 진단 | **403 HTML**, `COUPANG_HTTP_403`, 상품 결과 없음. 유지되는 RSC 검색 클라이언트와 다른 경로 |
| Allbirds/Shopify 예측 검색 | 200 JSON과 통화 조회 200 JavaScript MIME, 상품 3개 |
| eBay 자동완성 | 200 JSON, 제안 10개·카테고리 힌트 2개 |

카테고리 CLI는 MIME/조회 시각을 직접 출력하지 않아 해당 표본에는 JSON을 강제하는 reader 계약과 결과 수집 시각을 사용했다고 명시했다. HTTP 200만으로 성공을 판정하지 않았으며 parser/schema와 결과 건수를 함께 확인했다. 서비스 소스 24개 해시가 실행 이후 현재 파일과 일치함을 확인했다. 의존성 전체를 해시한 증명은 아니다.

추가 공개 원천 검사는 정책 12건, SH 10건의 제한된 결과와 모두투어 추천 10건·매칭 상품/상세 각 1건을 읽었다. SH와 전체 공고 snapshot은 불완전하다. **NOL/야놀자 검색은 `YANOLJA_SEARCH_SCHEMA_INVALID`**, 국토부는 기존 `MOLIT_PUBLIC_REDIRECT_BLOCKED`로 건너뛰었다. aggregate receipt가 제공하지 않는 상태/MIME를 추측해서 채우지 않았다. AliExpress는 이번 라이브 대상에서 제외했다.

## 브라우저 실증과 남은 작업

agent-browser 0.39.1의 Rust Windows 바이너리를 `work/`에 설치하고 버전과 도움말을 확인했다. Chrome Canary 158.0.8105.0, Stable 155.0.8059.79를 각각 고유 namespace·새 합성 프로필로 명시 실행했으나 첫 `open about:blank`와 `close`에서 `outcome_unknown`이 반환됐다. Canary 진단은 socket timeout `os error 10060`을 확인했다. **합성 행동 완료 0건, 운영 사이트 캡처 0건**이며 브라우저 동작·로그인 성공을 주장하지 않는다.

우선순위는 다음과 같다.

1. **Rust 브라우저 IPC/CDP 실행 복구:** 로컬 fixture의 클릭·본문·정제·HTTP 값 비교부터 통과시킨다. initiator와 redirect ancestry는 별도 수집 확장 대상이다.
2. **기능 매니페스트 연결:** 미등록 실행기를 검토해 Naver·Tistory·affiliate·social 등의 서비스/기능 및 인증·readback 조건을 연결한다. 후보를 자동으로 기능 성공으로 등록하지 않는다.
3. **실제 실패 회귀:** NOL/야놀자의 현재 HTML/schema 차이를 관측한다. 쿠팡은 후속 RSC 검색 200을 별도로 기록했으며, 남은 범위는 전체 세션의 장기 자동 갱신이다. 쿠키 없는 Document 진단 403은 해당 경로의 결과로 보존한다.
4. **기록 갱신과 미구현 분리:** 재검증 21개·pending live 16개를 서비스별 현재 읽기로 검증한다. 계정·쓰기·생성 기능은 해당 기능의 준비와 readback 조건을 갖춘 별도 실행이 필요하다.

실행 당시 기준 source revision은 `2af4d895bbdc4dd0894d85f520a94ddf332938c5`이며 새 조사 도구와 Windows 테스트 수정은 이 결과와 함께 반영한다. 보고서에 없는 외부 사이트나 계정 기능의 현재 상태는 확인하지 않았다.

합성 테스트 프로세스의 후속 조회에서는 해당 임시 프로필을 사용하는 Chrome/runner가 보이지 않았다. runner 자체의 close는 확인되지 않았고 임시 폴더 3개 삭제는 자동 승인 검토의 정책 차단으로 실행되지 않았다. 원본 사용자 프로필을 복사하거나 종료하지 않았다.
