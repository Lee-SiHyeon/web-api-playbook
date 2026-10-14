# 해외 요청의 지역·로케일·통화

확인일: 2026-10-14. 가격과 가용성은 **지역이 붙은 관측**이다. amazon.com US 배송지의 USD 가격과 KR 스토어프런트 KRW 견적은 같은 Offer가 아니다. 해외 관측마다 아래 축을 기록하고, 별도 환율 관측 없이 통화를 바꾸지 않는다.

## 필수 관측 필드

| 필드 | 의미 |
|---|---|
| `marketplaceId` | 마켓 호스트 (`www.amazon.com`, `www.amazon.co.jp`, SHEIN 국가 호스트 등) |
| `shipToCountry` | 견적에 쓴 ISO 3166-1 alpha-2 도착국 |
| `storefrontLocale` | 사이트가 쓴 언어/로케일 (`en_US`, `ko_KR` 등) |
| `currency` | **응답 금액**의 ISO 4217 |
| `dataChannel` | `official_api` \| `publisher_feed` \| `public_http` |
| `observedAt` | RFC3339 |

축이 불명이면 null로 두고 KRW·무료배송을 추론하지 않는다.

## 플랫폼 입력 (보낸 값을 문서화)

아래는 공개 문서와 기존 어댑터 기준의 작업 메모다. 새 쿠키 계약을 주장하려면 라이브 영수증으로 다시 확인한다.

### AliExpress Affiliate API

공식 상품 API에 `target_currency`, `target_language`, `ship_to_country` / `ship_to`, `locale`를 보낸다 (`lib/commerce/aliexpress-affiliate.mjs`). 스토어프런트 쿠키보다 이를 우선한다.

### AliExpress 스토어프런트 (공개 HTTP — 제한)

브라우저 캡처에서 `aep_usuc_f`(지역·통화·언어), `intl_locale`이 자주 보인다. **이 저장소에 Node 고정 계약으로 검증되지 않았다.** 익명 가격 조회를 주장하지 않는다. SEO 전용 조회는 쿠키 적용을 암시하지 않는다.

### Amazon Creators API

`marketplace` / `x-marketplace`(예: `www.amazon.com`)와 맞는 `partnerTag`를 쓴다. Offer는 마켓 로컬이다. `.com` 자격과 `.co.jp` 태그를 섞지 않는다.

### Amazon 스토어프런트

브라우저 선호에 `i18n-prefs`(통화), `lc-main`(언어), 배송 우편번호가 있다. 익명 XHR 카탈로그는 `checklists/services/amazon.json`에서 미확인/차단이다. 스크래핑하지 말고 Creators API를 쓴다.

### SHEIN / Temu / iHerb

제휴 프로그램이 승인한 국가 호스트를 쓴다(예: `us.shein.com`). 네트워크 API에는 그 국가의 campaign/MID를 넘긴다. 검증되지 않은 스토어프런트 로케일 쿠키는 수집기에 넣지 않는다.

### 일반 HTTP 헤더

- `Accept-Language`: 공식 API나 검증된 공개 계약이 명시한 때만 보낸다. 아니면 생략.
- 막힌 스토어프런트를 “탐색”하려고 `Accept-Language`나 geo 헤더를 돌리지 않는다.

## 환율

통화 환산은 HTTP 클라이언트 밖이다. 응답 통화 금액을 그대로 기록한다. 원화 표시는 별도 `FxRate` 관측(환율·출처·시각)이 필요하며 온톨로지/웹 DB 범위다.

## 관련

- [overseas-official-api-first.md](overseas-official-api-first.md)
- [region-egress-proxy.md](region-egress-proxy.md)
