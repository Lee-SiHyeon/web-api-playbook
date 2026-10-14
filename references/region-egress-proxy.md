# 서버 지역·이그레스

확인일: 2026-10-14. 수집기·Vercel·에이전트 박스의 **출구 IP 지역**은 가격·언어·차단 여부에 영향을 준다. 이 문서는 그 사실을 기록한다.

## 사실

- 같은 URL이라도 US 이그레스와 KR/아시아 이그레스에서 통화·배송비·품절·챌린지 발생이 달라질 수 있다.
- 관측 영수증에 `egressRegion` 또는 실행 환경 라벨(예: `vercel-iad`, `box-unknown`)을 남기는 것을 권장한다. 정확한 ASN/IP는 비밀이 아니면 선택이다.
- 공식 API(Creators, AliExpress Affiliate, Awin/Impact)는 보통 앱 자격으로 국가를 고르므로, 이그레스보다 `marketplace` / `ship_to` 파라미터가 우선이다.

## 허용

- 플랫폼이 제공하는 고정 리전(Vercel 리전 선택, 자체 서버 1곳)에서 **허용된** 공개 HTTP·공식 API를 호출한다.
- 지역이 가격을 바꿨으면 [geo-locale-currency.md](geo-locale-currency.md) 축에 그대로 기록한다.
- 기업/클라우드 이그레스 IP를 공식 파트너 콘솔에 화이트리스트로 등록하는 것(문서화된 경우).

## 비밀 관리

- 프록시 자격증명을 레포·로그·영수증에 남기는 것.

## 미확인

- 각 해외 몰 ToS가 “자동화된 접근에 데이터센터 IP만 허용/금지”인지는 몰마다 다르다. 계정별 파트너 약관을 추가로 확인한다 ([legal-tos-overseas.md](legal-tos-overseas.md)).
