# 해외 커머스: 공식 API 우선 원칙

확인일: 2026-10-14. 해외 몰은 익명 스토어프런트 수집보다 **공식 제휴·상품 API → 제휴 네트워크 피드 → 공개 HTTP 계약** 순서로 고른다. 위 단계가 막혀 있으면 막힌 이유를 기록하고, 아래 단계로 내려갈 때는 [봇 차단 경계](anti-bot-boundaries.md)와 [약관 정리](legal-tos-overseas.md)를 먼저 확인한다.

## 왜 공식 API부터 보는가

- 가격·재고·수수료가 판매처 통화와 대상 국가 기준으로 구분돼 반환된다. 스토어프런트 HTML은 IP·쿠키에 따라 바뀐다.
- Amazon처럼 약관이 가격 표시를 API·데이터 피드로만 허용하는 곳이 있다.
- 요청 서명과 한도가 문서로 공개돼 있어 재현과 감사가 가능하다.

## 서비스별 경로

| 서비스 | 1순위 | 인증 | 이 저장소 상태 | 출처 |
|---|---|---|---|---|
| AliExpress | Affiliate API (`aliexpress.affiliate.product.query`, `productdetail.get`, `hotproduct.query`, `link.generate`), `POST https://api-sg.aliexpress.com/sync` | AppKey/AppSecret 서명(md5 또는 hmac/sha256), `tracking_id`; 사용자 session 불필요 | `lib/commerce/aliexpress-affiliate.mjs`; 링크 발급은 [aliexpress-portals 체크리스트](../checklists/services/aliexpress-portals.json) | [link.generate 문서](https://developer.alibaba.com/docs/doc.htm?articleId=45804&docType=2&treeId=674) |
| Amazon | Creators API `https://creatorsapi.amazon/catalog/v1/*` | LwA OAuth2 client credentials, 토큰 1시간, `x-marketplace` 헤더, `partnerTag` | `lib/commerce/amazon-creators.mjs` | [마이그레이션 가이드](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/migrating-to-creatorsapi-from-paapi) |
| Amazon (구) | PA-API 5 | AWS SigV4 | **사용 금지**: 폐기, 호출 시 403 `AccessDeniedException` | [폐기 공지](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation) |
| Temu | 제휴 대시보드의 링크·코드(공개 상품 API 미확인) | 제휴 계정 | [temu 체크리스트](../checklists/services/temu.json) | [Affiliate FAQ](https://www.temu.com/affiliate_question.html) |
| SHEIN | Awin 프로그램(US 15920, UK 15919) 상품 피드 | Awin publisher 승인 | [shein 체크리스트](../checklists/services/shein.json), `lib/commerce/awin.mjs` 재사용 후보 | [Awin SHEIN US](https://ui.awin.com/merchant-profile/15920) |
| iHerb | Awin·CJ·Impact·Partnerize 중 하나의 제휴 프로그램 | 네트워크 publisher 자격 | [iherb 체크리스트](../checklists/services/iherb.json), `lib/commerce/impact.mjs`·`awin.mjs` 재사용 후보 | [iHerb Affiliates](https://www.iherb.com/info/affiliates) |

## 주의할 점

- Amazon PA-API 5 폐기: 공식 문서는 폐기와 403 응답을 명시한다. 2026-04-30 폐기, 2026-05-15 종료라는 날짜는 제3자 글([paapiplugin](https://paapiplugin.com/amazon-is-retiring-pa-api-v5-is-your-affiliate-plugin-ready/))이 고객 메일을 인용한 것이며 **공식 문서로는 미확인**이다.
- Temu Partner Platform(`openapi-b-us|eu|global.temu.com/openapi/router`, MD5 서명)은 셀러·ERP용 API다. 제휴 상품 조회 API가 아니다([문서](https://partner.temu.com/documentation?menu_code=52ef88bdef1d4527b15f6d303b173e48)).
- AliExpress 서명 timestamp는 TOP 문서상 GMT+8 `yyyy-MM-dd HH:mm:ss`, 허용 오차 10분이다. 기존 어댑터의 서명 구현을 재사용하고 새로 만들지 않는다.
- 공식 API의 승인 조건(판매 실적, 트래픽 심사)은 수시로 바뀐다. 승인 거절은 `blocked`로 기록하고 스토어프런트 수집으로 대체한다고 가정하지 않는다.
- 수수료율은 프로그램 페이지에서 날짜와 함께 확인한다. 위 SHEIN 15%/1% 같은 값은 2026-10-14 Awin 프로필의 표시값이고 지역·시점마다 다르다.
