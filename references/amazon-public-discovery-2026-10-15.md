# Amazon HTTP discovery — 2026-10-15

사용자 범위: “알리빼고 다른곳들”, “아마존같은곳부터”. Amazon을 먼저 확장하고 AliExpress는 제외했다. XHR뿐 아니라 브라우저에서 관측한 URL의 독립 HTTP Document 읽기도 유효하다. 전체 카탈로그 완료나 계정 로그인 성공을 주장하지 않는다.

## 확인된 실행

| 작업 | 현재 검증 | 제한 |
| --- | --- | --- |
| 홈 전체 메뉴 | Canary에서 All 클릭 후 두 XHR의 요청/응답을 관측. 쿠키 없는 Node 재실행으로 37 메뉴, 342 목적지, 418 연결 | 206 목록 목적지와 39 상품 목적지의 전수 방문은 미완료. 기본 메뉴가 브라우저의 KR/한국어 메뉴와 일치한다는 증거 없음 |
| 검색 | `POST /s/query`, `wireless mouse` 1~4페이지, 중복 제거 60 ASIN | 각 페이지에서 검증된 주 상품 카드만 수집. 1/4페이지의 일부 카드·추천 ASIN은 미포함 |
| 재개 | 1~3페이지 실행 결과를 새 프로세스에 입력해 4페이지부터 실행 | 다음 5페이지 대기. 마지막 페이지 도달 미확인. 저장 파일은 백그라운드 작업이 아님 |
| 상품 상세 | 로션 `B08KT2Z93D`, 다른 향 `B08KT5HM98`, 마우스 `B004YAVF8I`의 정확한 ASIN·제목·설명/특징·표시가격·재고 문구·이미지 URL | 초기 공개 브라우저 세션 필요. 결제 가격, 수량 재고, 완전한 이미지 갤러리 미확인 |
| 옵션 | 로션 15 향 + 4 크기, 마우스 7 색상 + 2 묶음 수 선택지와 child-ASIN 연결 | 차원별 선택지 수이며 모든 조합 수가 아님. 각 옵션의 가격·재고 전수 조회 미완료 |
| Twister XHR | 관측된 쿼리를 별도 HTTP로 재전송해 200, ASIN 일치, JSON 프레임 확인 | Value는 객체. 반복 실행 입력 도출 및 가격/오퍼 의미 검증 미완료. 유지관리 CLI의 옵션은 Document에서 읽음 |
| 리뷰 | 공개 세션을 붙인 리뷰 GET이 302 `/ap/signin`으로 이동 | 리다이렉트 미추적, 리뷰 본문과 페이지네이션 미완료 |
| 온톨로지 | `acada:cps-commerce`: 62 상품, 47 표시가격 관측, 47 차원별 옵션 연결 | 60 검색 상품 + 검색에 없는 상세 2개. 옵션으로만 발견된 child-ASIN에 가격을 만들지 않음. DB 쓰기 0 |

원본 공개 응답의 영수증과 투영은 `verification/amazon-discovery-2026-10-15/`에 있다. `browser-observation.json`은 XHR 요청/응답 쌍만 기록하며 상품 Document의 CDP 캡처는 주장하지 않는다. 상품 DOM에서 확인한 공개 경로와 별도 HTTP 결과를 구분한다.

## 실행

```powershell
node scripts/retail.mjs amazon navigation --output=work/amazon-menu.json
node scripts/retail.mjs amazon crawl --query="wireless mouse" --max-pages=3 --output=work/amazon-pages-1-3.json
node scripts/retail.mjs amazon crawl --query="wireless mouse" --max-pages=1 --checkpoint=work/amazon-pages-1-3.json --output=work/amazon-page-4.json
node scripts/amazon-retail-session.mjs status
node scripts/retail.mjs amazon product --asin=B08KT2Z93D --output=work/amazon-product.json
node scripts/amazon-ontology.mjs --inputs=work/amazon-pages-1-3.json,work/amazon-page-4.json,work/amazon-product.json --output=work/amazon-ontology.json
node scripts/verify-amazon-expansion.mjs
node scripts/checklist.mjs --service=amazon --run-tests --strict
```

출력 파일은 덮어쓰지 않는다. 검색 호출은 한 실행당 1~5페이지, 클라이언트는 최대 20페이지로 제한한다. 관측한 다음 페이지 링크만 따라가며, 다음 링크 누락은 마지막 페이지 증거가 아니다. 다음 버튼의 명시적 비활성화 처리는 테스트했지만 실제 마지막 페이지는 아직 확인하지 않았다. 재개 결과에는 그 실행에서 읽은 상품만 있으므로 이전 실행 파일과 함께 투영한다.

## 세션 경계

- 상세의 무쿠키 GET은 HTTP 200이어도 `validateCaptcha` 폼만 반환했다. 폼을 제출하거나 해결하지 않았다.
- 성공한 동일 Amazon XHR에서 관측한 공개 세션 쿠키 13개를 stdin으로 전달해 Windows CurrentUser DPAPI에 보호 저장했다. 저장소 이름은 `amazon-retail-public-v1`이다. 쿠키 값·원시 세션 HTML·런타임 쿼리는 저장된 증거나 Git에 없다.
- Cookie의 바깥 큰따옴표는 [RFC 6265 §4.1.1](https://www.rfc-editor.org/rfc/rfc6265#section-4.1.1)이 허용한다. `sp-cdn`의 유효한 큰따옴표가 초기 가져오기에서 거부되던 공통 검증기를 수정했다. 내부 따옴표, 구분자와 제어 문자는 계속 거부한다.
- 여러 독립 Node 프로세스에서 DPAPI를 다시 읽었고 실제 Undici 송신 Cookie 헤더가 기대한 문자열과 같음을 메모리에서 확인했다. 응답 쿠키 회전·삭제만 같은 출처에 반영한다.
- 최초 bootstrap은 브라우저를 사용했다. 반복 상세 읽기는 브라우저나 JS 엔진을 사용하지 않는다. 계정 owner/auth 검증은 없고 전체 세션 만료 후 재발급도 미확인이다. 6시간은 보수적인 **로컬** 사용 제한이며 서버 TTL이 아니다.
- challenge, HTTP 실패, 로그인 리다이렉트, 필수 쿠키 삭제는 자동 반복하지 않는다. 로컬 세션은 재bootstrap 필요 상태로 남긴다. 보호 저장 실패를 성공으로 반환하지 않는다.

## 남은 탐색

`frontier.json`에 모든 메뉴 목적지, 발견된 ASIN, 다음 검색 페이지와 미완료 중첩 작업을 유지한다. Headphones 목록 목적지 하나는 Document 200을 받았지만 현재 검색 카드 선택자로 상품이 0개여서 레이아웃/계약 분석 대상으로 남긴다. 계정·외부 목적지는 자동 수집하지 않는다. 메뉴 트리 반환 완료와 전체 상품 탐색 완료는 별개다.

통화는 명시적인 ISO 코드만 인정한다. 기준가 문구를 정가로 단정하지 않으며 배송비·관세·세금·도착 총액은 null이다. 이미지 URL 개수에는 같은 사진의 표시 크기와 썸네일이 포함된다. 상품 설명은 판매자 표시 내용의 관측이며 독립적인 품질/효능 검증이 아니다.
