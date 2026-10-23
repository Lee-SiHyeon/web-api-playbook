# 플레이북 실행 경로 재감사 — 2026-10-15

쿠팡에서 드러난 진단 경로와 유지 실행기 혼동이 다른 서비스에도 있는지 조사했다. **등록 서비스 41개·기능 379개를 정적으로 대조하고, 별도로 선택한 공개 읽기를 실행했다.** 모든 기능·계정 세션을 현재 라이브 검증한 결과는 아니다. 서비스에 상태를 변경하는 요청은 하지 않았다. 알리는 사용자 지시에 따라 라이브 탐색에서 제외했다.

## 발견한 오류와 수정

| 대상 | 원인 | 수정 및 검증 |
|---|---|---|
| Yanolja/NOL 검색 | 200 HTML에 상품명이 있었지만 예전 DOM 선택자가 8개 카드의 제목을 모두 놓쳤다. | 관측한 현재 상품명 선택자를 추가했다. 같은 강릉 검색이 8개 유효 카드로 재현됐다. 제목을 다른 필드에서 추측하지 않는다. |
| Sephora 검색 | 요청 페이지 크기 10과 실제 응답 60개를 비교해 정상 JSON을 스키마 오류로 거부했다. | 확인된 60개 응답을 검증하고 요청 크기와 실제 크기를 구분한다. 같은 검색의 유지 CLI가 60개를 반환했다. 후속 요청에도 실제 크기를 전달하며 다른 검색으로 상태가 새지 않게 했다. |
| Rakuten·Yahoo Japan, Amazon | 오프라인 validator/verifier 해시를 HTTP 실행 코드 해시처럼 취급했다. 일본 11개 기능은 클라이언트 변경 없이 재검증 필요로 바뀌었고, Amazon 독립 검증기도 중단됐다. | 정확히 지정한 검증 도구만 이력으로 분리했다. 실행 코드와 원래 응답 해시는 계속 엄격하게 검사하고 현재 validator로 증거 계약도 검증한다. 과거 관측 시각은 그대로다. |
| SHEIN·iHerb 검증 명령 | 오프라인 검증이 과거 응답에 현재 코드 해시를 붙여 proof 파일을 덮어썼다. | 명령을 읽기 전용으로 바꿨다. 실행 코드·증거 변조를 거부하고, 기존 proof의 바이트와 시각이 보존되는지 회귀검증했다. |
| X 서비스 팩 | 401과 403을 모두 `AUTH_REJECTED`로 분류했다. | 401=`AUTH_REJECTED`, 403=`ACCESS_BLOCKED`로 분리하고 status/MIME을 보존한다. 게시 실패의 기존 저널·무재시도 원칙은 유지한다. 로컬 mock 검증이며 현재 X 세션 실패를 관측한 것은 아니다. |

Yanolja는 유효 카드와 잘못된 카드가 섞이면 제외 수·사유를 기록한다. 전부 잘못됐거나 빈 응답·차단 응답이면 실패한다. `schemaPartial`은 스키마 제외 여부이고, `completeCatalog:false`와 첫 페이지 제한은 별도다. 행 집계는 URL 필터를 통과한 파서 카드 기준(`parsed_product_cards_after_url_filter`)이며 모든 원시 DOM 후보를 센 값은 아니다. 이 범위 표기 개선은 13:07 UTC HTTP 재생 뒤 오프라인으로 검증했다.

Sephora의 13:17 UTC 라이브 결과는 745개 중 첫 페이지 60개다. 그 뒤 후속 페이지 크기 전달·검색 간 상태 분리 변경은 로컬 60+25개 fixture로 검증했으며, 전체 페이지를 새로 원격 수집하지 않았다. 최초 실패·응답 구조 진단·단일 페이지 성공·후속 로컬 검증은 [commerce-review.json](commerce-review.json)에 분리했다.

## 이번에 수행한 공개 HTTP 확인

| 경로 | 확인된 결과 | 범위 |
|---|---|---|
| iHerb sitemap | XML 200, 상품 식별자 10개 | 가격·재고·상품명 미검증 |
| SHEIN 홈 | HTML 200, 상품 카드 10개 | 홈 카드와 메뉴만; 상세·옵션·리뷰 미검증 |
| Yanolja 강릉 검색 | HTML 200, 유효 카드 8개 | 표시된 45페이지 중 1페이지; 다음 페이지 계약 미검증 |
| ModeTour | 3개 GET 200 | 추천 10개에서 상품 1개·상세 1개 |
| 정책브리핑 | 목록·상세 HTML 200 | 목록 12개, 상세 1개 |
| SH 공고 | 목록·상세 읽기 가능 | 목록 10개, 상세 표본 1개라 `partial` |
| MOLIT 공고 | HTTP 307 | 허용되지 않은 redirect에서 중단; 유효 본문 미확인 |
| OliveYoung Global | JSON·HTML 200, 베스트셀러 20개 | 한국 배송/USD 문맥의 홈 베스트셀러 |
| Sephora 검색 | JSON 200, 상품 60개 | `serum` 검색 첫 페이지; 전체 수집 미완료 |

쿠팡의 별도 세션 검색 수정과 실제 RSC 재생은 [직전 교정 기록](../coupang-recheck-2026-10-15/README.md)을 참조한다. 이번 후속 감사에서는 쿠팡 세션을 다시 읽지 않았다. Amazon·일본의 이번 결과는 **저장 증거의 오프라인 재검증**이다. eBay·Shopify 보고서의 같은 날 표본도 앞선 감사 자료이며 이번에 재실행한 것으로 세지 않았다.

## 미구현·미등록·증거 부족의 구분

- LinkPrice·MyRealTrip은 유지 HTTP 실행기와 과거 성공 증거가 있지만 capability manifest 등록에서 빠져 있다. 현재 세션 확인은 하지 않았다.
- Google Trends·Threads의 일부 `pending_live`는 저장 재생 증거를 지원하는 typed validator의 공백이다. 원격 실패를 뜻하지 않는다.
- eBay 소비자 catalog의 계획 파일은 없고 audit도 `unimplemented`로 판정한다. 유지 CLI의 제안 검색과 파트너 Browse API는 범위가 다르다.
- Temu·Walmart의 유지 상품 읽기는 미구현이다. 옛 브라우저 오류나 200 challenge 문서를 현재 상품 API 성공·403으로 바꾸어 해석하지 않았다.
- 제휴 API의 키·승인 전제 부족은 실제 서버 403과 구분했다. OliveYoung의 옛 모바일 HTML 403도 별도 public XHR 경로의 실패로 일반화하지 않았다.
- Shopify와 Shopify Storefronts의 Allbirds 경로는 같은 클라이언트를 재사용한다. 별도 독립 구현으로 중복 집계하지 않았다.

## 검증과 파일

수정 관련 로컬 회귀 **62개 통과**, Amazon·일본·해외 리테일 오프라인 검증기 3개 통과. 기존 실행 증거 파일은 수정하지 않았다. 새 CLI 성공 표본을 이전 상세·리뷰·전체 수집의 proof로 재발급하지 않았다.

최종 오프라인 집계는 `recorded_live` 54, `needs_reverification` 29, 필수 미충족 212다. 일본 11개는 검증 도구만의 변경을 바로잡아 기록 상태를 회복했다. 반대로 실제 Sephora/공용 실행 코드 변경에 걸린 과거 증거 8개는 재검증 필요로 유지했다. 전체 테스트 실행을 요청하지 않았으므로 기존 local-only 기능 17개는 `pending_local_test`다. 전체 필수 게이트 통과와 현재 전체 원격 가용성은 확립되지 않았다.

- [전체 기능 상태](audit.md) · [기계 판독 감사](audit.json)
- [41개 서비스 범위·최종 소스 해시](scope.json) · [회귀 및 오프라인 검증 결과](verification-results.json)
- [해외·알리 정적 범위](root-review.json) · [리테일·일본](retail-review.json) · [커머스 14개](commerce-review.json)
- [앱·제휴·미등록 실행기](apps-review.json) · [여행·공공 공고](ontology-review.json)
- [iHerb·SHEIN 현재 표본 요약](public-live-samples.json) · [iHerb 실행](iherb-live.json) · [SHEIN 실행](shein-live.json)
