# 해외 제휴·수집 약관·고지 (요약)

확인일: 2026-10-14. **법률 자문이 아니다.** 운영 전에 각 프로그램의 현재 Operating Agreement를 계정으로 다시 읽는다. 불확실하면 해당 capability를 `blocked`로 둔다.

## Amazon Associates

- 운영 정책: https://affiliate-program.amazon.com/help/operating/policies
- Product Advertising Content(가격·가용성 등)는 Amazon이 제공하는 링크·승인 API/피드로만 표시. **스크래핑·데이터 마이닝·로봇으로 PAC를 추출·재사용하는 것은 금지**(사전 서면 승인 없는 경우).
- 비이미지 PAC 캐시는 최대 24시간 후 새로고침·재표시; 이미지 파일 자체 캐시는 금지, 이미지 URL은 24시간 범위에서 유지 가능한 것으로 정책에 명시된 범위를 따른다.
- PA-API 5는 폐기. Creators API로만 카탈로그를 읽는다 ([폐기 공지](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation)).
- 필수 Associates 고지 문구를 링크 근처에 둔다. 한국 표시광고 고지와 별개로 **미국 FTC 계열 고지**도 콘텐츠 언어·대상에 맞게 검토한다.

## AliExpress Affiliate / Portals

- 플랫폼 약관 예: https://terms.alicdn.com/legal-agreement/terms/suit_bu1_aliexpress/suit_bu1_aliexpress202003132026_84536.html (게시 시점 스냅샷; 최신본 재확인).
- 상품·링크는 공식 Affiliate API·대시보드 도구를 쓴다. 스토어프런트 챌린지 우회 수집은 이 플레이북에서 금지.
- `tracking_id`·프로모션 링크 규칙을 어기지 않는다.

## Temu

- 제휴 FAQ: https://www.temu.com/affiliate_question.html — 대시보드 링크/코드·성과 조회.
- Partner Platform 약관/API는 셀러·ISV용([partner.temu.com](https://partner.temu.com/documentation?menu_code=d8425dcd25b04658843e622e178a3b42)). 제휴 퍼블리셔가 셀러 OpenAPI로 소비자 카탈로그를 긁는다고 가정하지 않는다.
- 스토어프런트 자동 수집·비문서 API 역공학은 금지 쪽으로 운영한다 (공개 ToS 전 조항 인용은 **계정별 재확인 필요**, 미확인 항목으로 둔다).

## SHEIN

- Awin 프로그램 프로필·Publisher Terms를 따른다 (US 예: https://ui.awin.com/merchant-profile/15920). 수수료·쿠키 일수는 프로필 시점 값이며 변동한다.
- 상품 데이터는 Awin 피드/딥링크 API를 우선한다.

## iHerb

- https://www.iherb.com/info/affiliates — Awin, CJ, Impact, Partnerize.
- Rewards 코드를 제휴 링크에 섞는 취급은 프로그램 FAQ를 따른다. 건강·효능 표현은 기존 콘텐츠 금지 규칙과 함께 본다.

## 한국 표시·통관 (운영 메모)

- 광고 표시: 제휴·광고임을 이용자가 쉽게 알 도록 고지 (기존 국내 쿠팡/애드픽 고지 규칙과 동일 취지).
- 목록통관 면세 한도: 일반 자가사용 **미화 150달러**, 미국발 특송 목록통관 **미화 200달러** 등 — 관세청 안내 기준. 출처: [관세청 특송물품 통관](https://customs.go.kr/kcs/cm/cntnts/cntntsView.do?cntntsId=819&mi=2821), [예상세액 조회](https://www.customs.go.kr/kcs/ad/tax/BuyTaxCalculation.do). 목록통관 배제 물품·건강기능식품 등은 한도가 달라질 수 있으니 **통관 전에 관세청 최신 고지를 확인**한다. 세액 추정은 온톨로지의 estimate 필드로만 다루고 확정 세금처럼 쓰지 않는다.

## 미확인 / 재확인 필요

- Amazon 정책 페이지의 세부 절 번호·캐시 문장 전문 (요약은 공식 정책 URL에 의존).
- Temu 소비자 사이트 ToS의 크롤링 금지 조항 원문.
- SHEIN/iHerb의 국가별 프로그램 ID·현재 수수료 (Awin 프로필은 변동).
- PA-API 종료 일자 2026-04-30 / 2026-05-15 — 제3자 인용, 공식 문서에는 “deprecated / migrate”와 403이 명시.
