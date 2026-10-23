# 해외 쇼핑 원천 확장 — 2026-10-15

대상은 기존 `acada:cps-commerce` 온톨로지의 `aliexpress`, `temu`, `shein`, `iherb`다. 여행·공고 원천 감사만으로 전체 범위를 완료했다고 표시하지 않는다. 브라우저는 Chrome Canary에서 마우스로 탐색했고, 반복 수집 클라이언트는 Node 직접 HTTP다. Document·HTML 안의 공개 JSON·XML도 수집 대상으로 포함한다.

| 원천 | 이번 구현·검증 | 미완료 범위 |
|---|---|---|
| AliExpress | 기존 관측 sitemap 계약을 CLI에 연결. XML/gzip 크기 제한·중복 제거·재개 해시를 오프라인 검증 | 사이트 도구 안전 정책이 페이지 접근을 거부해 알리 직접 HTTP 호출 0회. 현재 sitemap·검색·상세·가격·옵션·리뷰 라이브 미검증 (2026-10-16 sitemap-index·sitemap-products 직접 HTTP 200 재확인: [keyless probe](overseas-keyless-probe-2026-10-14.md#status-vs-main-readers-2026-10-16-0920-kst-recheck). 검색·상세·가격·옵션·리뷰는 여전히 미검증) |
| Temu | 화면 탐색과 관측된 `/kr/channel/best-sellers.html` GET 확인 | HTTP 200, 2,922바이트이지만 검증된 상품 목록 없음. 상품 요청 캡처·HTTP 클라이언트 미완료 |
| SHEIN | KR 홈 Document의 `gbRawData`를 JS 실행 없이 파싱. 상품 10개·KRW 표시가·메뉴 목적지 15개 | 후속 분류 GET이 302 `/risk/challenge`로 이동하여 추가 요청 중단. 상세·SKU·재고·리뷰·전체 분류·페이지 이동 미검증 |
| iHerb | www 사이트맵 3개 발견. 첫 XML의 고유 ID 20,500개 중 100개를 CLI로 출력 | 첫 파일 나머지와 2개 파일, 상품명·가격·재고·옵션·리뷰. 별도 KR storefront는 403 challenge |

SHEIN의 별도 브라우저/HTTP 10개 표본에서 공통 상품명 8개 모두 표시가가 일치했다. 나머지 2개는 추천 구성원이 달랐다. 10/10 UI 대조나 전체 카탈로그 성공으로 표시하지 않는다. 현재 브라우저 `Network.enable`은 paused-document runtime 오류로 실패했으므로 신규 4개 원천의 `captured`는 false다. HTTP 성공과 브라우저 네트워크 캡처는 별도 상태다.

SHEIN 홈 성공은 후속 분류 challenge **이전**의 관측이다. 현재 계속 접근 가능하다는 보장이 아니다. 알리 사이트 정책 차단을 다른 도메인·도구·직접 HTTP로 우회하지 않았다. eBay도 추가로 관찰했으나 Electronics 분류 직접 HTTP는 403이어서 신규 성공 클라이언트로 등록하지 않았다.

## 실행과 재개

```bash
# 로컬 범위/진행 상태; 네트워크 없음
npm run retail:overseas -- status

# 허용된 원천의 직접 HTTP 실행 예시; 출력은 새 파일만 허용
node scripts/overseas-retail.mjs iherb sitemap-products --shard-index=0 --offset=0 --limit=100 --output=work/iherb-001.json

# 앞선 결과 data.frontier.next의 실제 해시·offset 사용
node scripts/overseas-retail.mjs iherb sitemap-products --shard-index=0 --offset=100 --limit=100 --snapshot-sha=ACTUAL_PREVIOUS_SNAPSHOT_SHA256 --output=work/iherb-002.json
```

`sitemap-index`는 관측된 파일 목록을 반환한다. `sitemap-products`는 실제 index에서 선택한 shard만 읽고, limit 1–1,000 범위의 ID를 출력한다. offset이 0보다 크면 이전 XML의 `--snapshot-sha`가 필수이며 XML이 바뀌면 `SITEMAP_SNAPSHOT_CHANGED`로 중단한다. 이 offset은 로컬 XML 내 위치이며 서버 페이지네이션이 아니다. 매번 XML 한 파일을 다시 받는다. `completeCatalog:false`, 전체 파일 수·현재 파일·다음 offset을 함께 반환한다. 403/429/challenge 응답 후에는 재시도하지 않는다.

SHEIN `home`, AliExpress `sitemap-index`/`sitemap-products`도 구현되어 있다. 이번에 관측한 서비스/도구 차단이 해소되기 전에는 재실행하지 않는다. Temu는 지원 명령이 없으며 네트워크 없이 `OVERSEAS_OPERATION_UNVERIFIED`로 종료한다. [재개 목록](overseas-retail-frontier.json)은 4개 원천과 SHEIN의 15개 목적지, iHerb의 미수집 범위를 유지한다.

## 온톨로지 입력

`lib/retail/ontology.mjs`는 기존 `affiliate-content-operations/apps/affiliate-api-hub/references/cps-commerce-ontology.v1.json`의 필드를 따른다. 의존 checkout이나 계정 없이 이 저장소에서 재현할 수 있다.

```bash
node scripts/overseas-retail-ontology.mjs --input=verification/retail-shein-home-cli-2026-10-15-v2.json --proof=verification/retail-shein-direct-http-proof-2026-10-15.json --output=work/shein-ontology.json
node scripts/overseas-retail-ontology.mjs --input=verification/retail-iherb-sitemap-cli-2026-10-15-v2.json --proof=verification/retail-iherb-direct-http-proof-2026-10-15.json --output=work/iherb-ontology.json
```

입력 파일·공개 데이터·구현 해시가 영수증과 일치해야 한다. SHEIN은 `CommercialOffering` 10개와 `OfferObservation` 10개를 생성한다. KRW 원 단위를 유지하며, 상품 상세 URL·SKU·배송 국가·재고·배송비·관세·최종 결제가는 null 또는 unknown이다. 홈 표시가를 옵션 확정가로 바꾸지 않는다. iHerb 100행은 상품명·가격이 없으므로 `identityCandidates`에 두고 Offering/Offer를 만들지 않는다. 리뷰·옵션을 추론하지 않는다. 이는 로컬 입력 산출물이며 운영 웹 수집기 등록·DB 반영·배포는 수행하지 않았다.

## 검증 근거

- 실제 실행: [SHEIN](../verification/retail-shein-home-cli-2026-10-15-v2.json), [iHerb](../verification/retail-iherb-sitemap-cli-2026-10-15-v2.json)
- 독립 로컬 readback: [SHEIN proof](../verification/retail-shein-direct-http-proof-2026-10-15.json), [iHerb proof](../verification/retail-iherb-direct-http-proof-2026-10-15.json)
- 추가 요청: [SHEIN 분류·Temu Document](../verification/retail-overseas-followup-probes-2026-10-15.json)
- 로컬 투영: [SHEIN 온톨로지](../verification/retail-shein-ontology-2026-10-15.json), [iHerb ID 후보](../verification/retail-iherb-ontology-2026-10-15.json)
- [체크리스트 감사](../verification/retail-overseas-audit-2026-10-15.json): SHEIN 홈과 iHerb ID 조회는 현재 코드 해시의 `recorded_live`. 4개 사이트의 전체 strict 검사는 남은 필수 기능 때문에 예상대로 종료 코드 2다. 관련 테스트 50개가 통과했다(두 명령에서 공통 테스트 3개 중복 실행).

`scripts/verify-overseas-retail.mjs`는 저장된 CLI 결과를 읽어 필드·고유 ID·요청 상태·구현 해시를 검증하며 네트워크를 사용하지 않는다. `direct_http_observed` 검증은 별도 실제 CLI 결과와 결합하며, `recorded_live`는 해당 날짜의 실행 증거다. 계정 자격 증명·제휴 승인·전체 카탈로그를 뜻하지 않는다. 원문 HTML과 인증값은 증거에 저장하지 않았다.

2026-10-15 경로 재감사에서 이 명령을 읽기 전용으로 교정했다. 과거 proof 파일과 `checkedAt`를 보존하고 저장 당시의 실행 코드 해시를 대조한다. 실행 코드가 바뀌면 실패하며, 과거 응답을 현재 코드의 성공 증거로 다시 발급하지 않는다. verifier 자체 변경은 별도 이력으로 보고하고 현재 계약 검증은 계속 수행한다.
