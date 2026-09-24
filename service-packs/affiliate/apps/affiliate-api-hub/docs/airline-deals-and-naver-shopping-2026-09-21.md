# 항공사 공식 특가 수집처와 네이버 쇼핑 XHR 검증

확인일: 2026-09-21, 한국시간. 실행 호스트: 집 Windows `DESKTOP-TO2H6OD`.

네이버 오늘끝딜 스페셜딜 수집기를 구현하고 독립 Node HTTP로 **5페이지, 고유 상품 85개, 마지막 `hasNext=false`**를 확인했다. 이 중 목록상 판매 상태 83개, 품절 2개다. 항공사는 국내 10개와 해외 2개 공식 사이트를 조사 대상으로 정리했다. 항공사별 확인 수준은 아래 표와 카탈로그에 구분했다. 일반 네이버 키워드 검색은 실제 내부 XHR을 관측했으나 독립 HTTP가 418을 반환하므로 아직 운영 가능한 API 수집기가 아니다.

**항공사 공식 수집처**

| 우선순위 | 항공사·공식 경로 | 글감으로 모을 내용 | 이번 검증과 남은 범위 |
|---|---|---|---|
| P0 | [아시아나 이벤트](https://flyasiana.com/C/KR/KO/event/list) | 계절 특가, 국내선, 노선별 코드, 첫 구매·제휴 혜택 | 익명 HTTP 200에서 행사 링크·기간 확인. 추석 행사 상세의 구매/탑승 기간 확인. 목록 파서·페이지 순회는 미구현 |
| P0 | [제주항공](https://www.jejuair.net/ko/main/base/index.do) | 회원 특가, 동남아·일본·마카오 등 노선별 코드, 최저가 달력 | 공개 HTML에서 현재/종료 행사가 섞인 목록과 상세 링크 확인. 상품별 할인 조건은 상세 XHR·이미지 추가 확인 필요 |
| P0 | [트리니티항공 이벤트](https://www.trinityairways.com/app/promotion/event/being) · [출발 임박](https://www.trinityairways.com/app/upcomingDeparture/route) | 첫 프로모션, 결제 혜택, 임박 항공권, 탑승객 제휴 혜택 | 기존 twayair.com이 현 도메인으로 이동함을 확인. 행사 목록은 직접 HTTP 200이며 첫 페이지 9개 항목 확인. 임박 경로는 공식 메뉴에서 발견했으며 운임 API는 미검증 |
| P0 | [진에어 진행 행사](https://www.jinair.com/promotion/inprogressEvent) · [최저가 노선](https://www.jinair.com/promotion/anytime) | 네이버페이·카드 할인, 노선 프로모션, 날짜별 편도 총액 | 정상 Chrome에서 목록·기간과 최저가 카드 확인. 행사 추가 목록 POST XHR의 JSON 응답 관측. 독립 익명 재현은 403 |
| P0 | [피치 가을 세일](https://www.flypeach.com/kr/um/specials/sale/sale) · [한국어 홈페이지](https://www.flypeach.com/kr) | 일본 노선 세일, 판매 시작·마감 시각, 노선별 탑승일/제외일 | 공개 HTTP 200. 9/18 12:00~9/21 23:59 KST 판매 확인. 노선별 운임 숫자는 동적 데이터여서 이번 직접 HTML에서는 미확인 |
| P1 | [에어프레미아 학생 할인](https://www.airpremia.com/p/2026-talk-id) · [한국 홈페이지](https://www.airpremia.com/a/ko) | 미주·아시아 노선 대상 할인, 학생·결제 조건별 혜택 | 공식 캠페인 본문에서 조건·기간 확인. 일반 홈페이지 직접 요청은 403. 미국 시장 이벤트 목록을 한국 시장 목록으로 대체하지 않음 |
| P1 | [에어서울 진행 행사](https://flyairseoul.com/CM/ko/ingEvent.do) | 괌 혜택, 카드 제휴, 리조트·여행지 혜택 | 공식 웹 자료에서 행사명·기간 확인. 집 PC 직접 HTTP 403. 진행중 목록에도 9/14 종료 얼리버드가 보여 날짜 필터 필요 |
| P1 | [에어로케이 진행 행사](https://www.aerok.com/ko-KR/event-benefit/event/being) | 청주 출발 노선, 특별 운항, 노선 코드, 탑승객 호텔 혜택 | 정상 Chrome에서 6개 행사 링크와 마지막 페이지 상태 확인. [청주–마쓰야마 상세](https://www.aerok.com/ko-KR/event-benefit/event/395)의 8/13~9/27·10월 특별 운항 제목 및 CJJMYJ 링크 확인. 세부 가격·이미지 약관은 미확인. 직접 HTTP 403 |
| P1 | [이스타 현행 홈페이지](https://main.eastarjet.com/) · [최저가 항공권](https://main.eastarjet.com/fare-insight) · [이벤트 메뉴](https://www.eastarjet.com/newstar/PGWTA00001) | 얼리버드·임박 특가, 출발일별 편도 총액, 새 노선 | 정상 Chrome에서 현재 배너·상품 카드를 확인. 현행 홈페이지 직접 HTTP 200은 정적 틀만 확인. 레거시 이벤트 메뉴는 안내창 후 빈 페이지여서 상세 검증 보류 |
| P1 | [에어부산 진행 행사](https://www.airbusan.com/content/common/flynjoy/flyNEvent/) | 부산·지방 출발 특가, 편도총액·수하물 조건, 탑승객 제휴 | 공식 홈페이지와 행사 메뉴 확인. 검색된 9/9~9/15 국내선 특가는 이미 종료되어 제외. 현재 항공권 특가 상세·목록 API는 미검증. 홈페이지 직접 HTTP 403 |
| P1 | [대한항공 프로모션](https://www.koreanair.com/contents/promotion/list) · [한국 시장 운임 페이지](https://www.koreanair.com/flights/ko-kr/?subfolder=flights) | 노선별 운임 달력, 시즌 행사·결제 혜택 | 한국 시장 홈페이지 직접 HTTP 200, 공식 프로모션 메뉴 확인. 동적 행사 목록과 실제 운임은 미검증. 한국어 경로와 KR 시장을 구분 |
| 보류 | [스쿠트 한국어 홈페이지](https://www.flyscoot.com/ko) | 싱가포르·경유 노선 세일 후보 | 공식 홈페이지·취항지 페이지는 확인했지만 웹 추출 결과가 비어 현재 세일과 API 경로를 확보하지 못함 |

**현재 글감 후보**

| 소재 | 공식 확인 사항 | 글 작성 전 필요한 확인 |
|---|---|---|
| [피치 오늘 마감 세일](https://www.flypeach.com/kr/um/specials/sale/sale) | 판매 2026-09-18 12:00~09-21 23:59 KST. 한국 출발 표시 운임은 편도 총액, 위탁 수하물·좌석은 별도 | 노선별 탑승 기간·제외일과 실제 남은 SALE 좌석. 오늘 마감이라는 표현은 발행 시각 재검증 |
| [아시아나 추석 항공 특가](https://flyasiana.com/C/KR/KO/event/detail/CM202609140002530589) | 구매 09-16~09-27, 탑승 09-16~11-30. 국내선·한국 출발 국제선 대상, 공식 웹/앱 구매 | 선택 노선의 실제 총액과 제외편. 판매 마감과 탑승 종료를 혼동하지 않음 |
| [제주항공 태국 노선 할인 코드](https://www.jejuair.net/ko/event/eventDetail.do?eventNo=0000004282) | 목록에 최대 50%, 행사 09-15~09-27 | 상세 코드·대상편·할인 기준을 확인해야 발행 가능. 목록 제목의 최대 할인율을 전 노선 총액 할인으로 표현하지 않음 |
| [진에어 네이버페이 결제 혜택](https://www.jinair.com/promotion/eventView?evntSeq=15563) | 공식 목록의 행사 기간 09-16~09-30 | 결제 최소액·할인 상한·선착순·중복 조건. 제목에 없는 할인 금액은 추정하지 않음 |
| [트리니티 첫 프로모션](https://www.trinityairways.com/app/promotion/event/being) | 공식 목록의 기간 09-14~09-30. 9월 결제 할인 행사도 별도 존재 | 첫 프로모션·결제 할인·경품 추첨을 따로 분류하고 실제 중복 가능 여부 확인 |
| [에어프레미아 학생 항공권](https://www.airpremia.com/p/2026-talk-id) | 구매 05-14~12-31, 카카오톡 학생증 인증 대학/대학원 재학생, 카카오페이 원화 결제. 항공 운임 최대 15%이며 세금·유류할증료 제외 | 졸업생 제외, 다른 쿠폰 중복 불가. 탑승 기한은 노선별 2027-02-28~04-30로 다름 |
| [에어로케이 청주–마쓰야마](https://www.aerok.com/ko-KR/event-benefit/event/395) | 행사 제목 08-13~09-27, 10월 특별 운항. 공식 링크의 코드 CJJMYJ | 실제 할인율·운항 날짜·수하물은 상세 이미지/검색에서 추가 확인 |

진에어·이스타의 홈페이지 최저가 카드는 **특정 날짜의 표시 운임**이다. 모든 날짜의 최저가, 왕복 합계, 최종 결제 가능한 좌석으로 간주하지 않는다. 여행 기사 데이터에는 출발 공항·도착 공항·편도/왕복·인원·통화·구매 기간·탑승 기간·제외일·수하물·결제 조건·확인 시각을 각각 보관한다.

**네이버 쇼핑: 관측 → 클라이언트 → 독립 HTTP**

공개 쇼핑 검색 OpenAPI 종료와 네이버 서비스 내부 XHR의 동작 여부는 별개다. 이번에는 기존 정상 로그인 Chrome에서 `멀티탭`, `공기청정기` 검색을 실행하고 실제 요청·JSON 응답을 관측했다.

| 작업 | 관측된 계약 | 독립 실행 결과 |
|---|---|---|
| 검색 추가 결과 | `GET search.shopping.naver.com/ns/v1/search/paged-composite-cards` | 브라우저 200 JSON, 추가 페이지 50개 카드 관측. 익명·현재 세션·실제 전송 헤더 전달 모두 Node 418. 초기 페이지 검색 API는 아직 구현하지 않음 |
| 상품 기본 정보 | `GET /ns/v1/channel-products/by-ids` | 브라우저에서 상품명·판매가·할인가 JSON 관측. 독립 fetch 및 표준 HTTP/2는 418 |
| 상품별 할인 혜택 | `POST /ns/v1/product-benefits/list` | 상품 ID별 혜택 JSON 관측. 직접 HTTP 성공 미검증 |
| 오늘끝딜 스페셜딜 | `GET vertical-api.shopping.naver.com/v1/waffle-maker/layouts/{layoutId}/auto-sort-products` | **익명 독립 HTTP 200 JSON, 5페이지 85개, 마지막 hasNext=false** |
| 행사 ID 찾기 | `GET shopping.naver.com/promotion`의 `__NEXT_DATA__` | 공개 HTML을 HTTP로 받아 AUTO_SORT_PRODUCT 구성과 기간만 추출. ID를 고정하지 않음 |

검색 계열의 `x-wtm-ncaptcha-token`과 세션 헤더는 관측된 이름만 보관했다. 정상 세션을 메모리로 전달했지만 서버가 사업 데이터 응답을 수락하지 않았으므로 인증 성공으로 기록하지 않았다. 브라우저 내부 fetch나 headless 실행을 독립 HTTP 성공으로 취급하지 않는다. 진단 요청을 반복하거나 별도 우회 수단을 붙이지 않았다.

오늘끝딜의 재사용 코드는 [어댑터](../adapters/naver-shopping-deals.mjs), [CLI](../scripts/naver-shopping-deals.mjs), [검증 기록](../references/naver-shopping-today-deals-replay-2026-09-21.json)에 있다. 저장소 루트에서 실행한다.

```powershell
node apps/affiliate-api-hub/scripts/naver-shopping-deals.mjs --output .runtime/partner-discovery/naver-today-deals-latest.json
```

상품 ID·이름·판매가·표시 할인가·배송비·품절 여부·행사 기간·출처를 정규화한다. 첫 페이지 `first=&page=1&type=VIEW`, 이후 `page=N&type=VIEW`를 사용하며 최대 페이지 수, 스키마, HTTP 상태, 응답 크기를 검사한다. 한국시간 종료일을 UTC로 변환하고, 배송비 미상은 0원으로 바꾸지 않는다. 페이지 제한에 도달하면 `complete=false`와 CLI 종료 코드 2를 반환한다.

이 실행의 행사 창은 **09-20 11:00~09-21 10:59:59 KST**다. 수집된 상품 가격은 결제 최종가가 아니며, 다른 오늘끝딜 탭·키워드 검색·전체 네이버 쇼핑은 수집 범위에 포함되지 않는다. 개인별 `display-infos` 혜택 XHR은 관측했지만 익명 수집기에 넣지 않았다.

신규 테스트 6개와 affiliate-api-hub 전체 테스트 **57개 통과**. 스케줄 등록과 글 발행은 하지 않았다. 항공사 API 클라이언트는 이번에 구현하지 않았으며, 진에어의 관측된 행사 JSON도 독립 요청이 403이므로 완료로 표시하지 않았다.

다음 편집 순서는 오늘끝딜 85개에서 동일 옵션·배송비를 맞춘 비교 후보 선별, 공식 항공 행사에서 마감 임박·노선 한정·학생/결제 조건별 글감 선별이다. 항공사 직접 구매 링크를 마리트 제휴 링크로 자동 대체하지 말고 같은 운항편·운임·판매 조건을 확인해야 한다.
