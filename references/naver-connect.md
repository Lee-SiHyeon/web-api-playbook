# 네이버 쇼핑커넥트 · 여행커넥트

네이버 브랜드커넥트 웹 앱에서 관측한 요청을 실행하는 독립 HTTP 클라이언트입니다. 공식 공개 API 키를 요구하지 않습니다. 최초 로그인 세션 취득에는 사용자의 네이버 브라우저 로그인이 필요하며, 이후 명령은 Windows DPAPI에 저장한 서비스 범위 세션을 사용합니다.

## 설치 및 실행

저장소 루트에서 `npm ci --ignore-scripts`를 실행합니다. Node.js 24 이상과 Windows 현재 사용자 DPAPI를 사용합니다. 다른 PC에서는 그 PC에서 로그인 세션을 다시 취득해야 합니다. 쿠키 파일을 Git에 넣거나 다른 PC로 복사하지 마세요.

```powershell
node scripts/brandconnect.mjs status
node scripts/brandconnect.mjs health
'{"query":"여행","limit":100}' | node scripts/brandconnect.mjs shopping-search
'{"query":"이탈리아"}' | node scripts/brandconnect.mjs travel-search
node scripts/brandconnect.mjs travel-rates
node scripts/brandconnect.mjs travel-tabs
'{"section":"REGION_BEST","tabId":"ALL"}' | node scripts/brandconnect.mjs travel-recommend
'{"affiliateProductId":"807701517671809"}' | node scripts/brandconnect.mjs shopping-detail
'{"minAffiliateUrlCreatedDate":"2025-09-26","maxAffiliateUrlCreatedDate":"2026-09-25"}' | node scripts/brandconnect.mjs shopping-links
'{"minCreatedDate":"2025-09-26","maxCreatedDate":"2026-09-25"}' | node scripts/brandconnect.mjs travel-links
```

조회 기간은 실행 시점에 맞춰 바꿉니다. 목록의 `data`와 `paging`을 확인하며 `page`를 증가시킵니다. 추천은 현재 관측한 `SPECIAL_OFFER/여행핫딜`, `REGION_BEST/ALL`, `PRICE_DROP/ALL` 조합을 지원합니다.

### 링크 발급

```powershell
'{"affiliateProductId":"807701517671809"}' | node scripts/brandconnect.mjs shopping-create-link
'{"productUrl":"https://pkgtour.naver.com/products/ybtour/APP1050TW00-20261012?reqChannel=brandconnect"}' | node scripts/brandconnect.mjs travel-create-link
```

예제 상품은 2026-09-25 관측값입니다. 실제 사용 시 검색·상세 응답에서 얻은 현재 상품 ID/URL로 바꾸세요. 이미 발급된 상품은 `outcome: existing`으로 기존 링크를 반환합니다. `created_verified`는 발급 응답과 관리 목록의 ID/URL이 일치한 상태입니다. `created_unverified`, `previous_attempt_unresolved`, `WRITE_OUTCOME_UNKNOWN`은 완료로 간주하지 말고 관리 목록으로 대사하세요. 해당 명령을 반복해도 같은 저널의 쓰기를 다시 전송하지 않습니다.

세션 가져오기는 `import-session`에 `{cookies, expectedLoginId, spaceId, userAgent}`를 **메모리 파이프의 stdin**으로 전달합니다. `cookies`는 로그인한 브라우저에서 `https://gw-brandconnect.naver.com/`에 실제 적용되는 쿠키 객체 배열입니다. 비밀값을 명령 인수, 환경 덤프, HAR, JSON 파일 또는 로그에 기록하지 않습니다. `/brand-connect/query/me`의 로그인 ID·크리에이터 자격·활성 스페이스와 `check-owner`를 확인한 세션만 저장합니다.

### 세션 갱신

브랜드커넥트는 네이버 공통 로그인 쿠키(`.naver.com`의 `NID_AUT`·`NID_SES`)로 인증합니다. 따라서 네이버 블로그 HTTP 로그인으로 갱신된 세션을 그대로 넘겨 갱신할 수 있습니다.

```powershell
# {cookies}만 메모리 파이프의 stdin으로 전달합니다. 저장된 로그인 ID·spaceId·referer·UA는 유지됩니다.
node scripts/brandconnect.mjs renew-session
```

저장된 계정과 같은 로그인 ID, 크리에이터 자격, 활성 스페이스, `check-owner`를 다시 확인한 뒤에만 저장합니다. 다른 계정의 쿠키면 `ACCOUNT_MISMATCH`로 중단하고 기존 세션을 그대로 둡니다. 2026-09-25 실제 HTTP로 블로그 세션 쿠키 갱신과 후속 health 통과를 확인했습니다. 네이버 로그인 자체가 CAPTCHA·추가 인증·보호조치를 요구하면 사람이 로그인해야 합니다. affiliate-content-operations의 `session-keeper.mjs`가 이 순서를 자동으로 실행합니다.

## 범위와 증거

- API origin: `https://gw-brandconnect.naver.com`만 허용합니다.
- 요청에는 해당 계정의 `X-Space-Id`가 필요합니다. 다른 사용자의 spaceId를 넣지 않습니다.
- 쇼핑: 상품 검색, 스토어 검색, 추천 스토어, 상품 상세, 발급 링크 관리.
- 여행: 검색, 추천 탭·추천 상품, 수수료, 상품 상세, 발급 링크 관리.
- 링크 발급은 계정에 링크 레코드를 만듭니다. 상품 구매나 여행 예약이 아닙니다. 발급 전 상품의 제휴 가능 상태와 기존 단축 링크를 확인하고, 새 발급은 저널 기록 후 한 번만 전송합니다. 결과가 모호하면 자동 재전송하지 않습니다.
- 쇼핑 링크 발급: `POST /affiliate/command/affiliate-urls?affiliateProductId=…`, JSON `{}`.
- 여행 링크 발급: `POST /affiliate/command/connect-urls`, JSON `{url: 상품URL}`.
- 여행 목록의 `originUrl`은 입력한 출발일 포함 URL과 달리 대표 상품 URL일 수 있습니다. 성공 응답의 `connectUrlId`로 대사해야 합니다.
- `check-owner` 성공 응답은 HTTP 200에 빈 본문입니다. JSON 파싱 성공을 요구하지 않으며, 단독으로 로그인 증거로 사용하지 않습니다.

## 실패와 갱신

2026-09-25 실제 HTTP 발급에서는 생성 응답 직후 관리 목록에 나타나지 않고 후속 조회에서 나타나는 지연을 관측했습니다. 이때 최초 결과는 `created_unverified`입니다. 같은 입력으로 명령을 다시 실행하면 기존 저널을 읽고 **조회만** 수행하여 `already_created`로 대사합니다. 최초 저널 날짜부터 현재 날짜까지 최대 100페이지를 조회하며, 미확인 상태를 임의로 성공으로 바꾸지 않습니다.

HTTP 200만으로 인증 성공을 판정하지 않습니다. 계정/스페이스가 불일치하거나 세션이 거부되면 중단합니다. 관측한 응답의 쿠키 회전은 보호 저장소에 반영합니다. 네이버 로그인 자체(비밀번호 로그인·보호조치 해제·문자 인증)는 이 클라이언트가 수행하지 않습니다. 네이버 블로그 쪽 HTTP 로그인으로 세션이 갱신되면 `renew-session`으로 가져오고, 그 로그인이 사람 확인을 요구하면 정상 로그인 후 다시 가져옵니다.

여행의 티켓/패스 및 국내 골프투어는 웹 화면에서 실적 대상 제외로 안내됩니다. 상품별 `affiliateEnabled`와 최신 수수료를 확인하세요. 쇼핑의 제휴 상태와 수수료도 변경될 수 있습니다. 단축 링크가 있다는 사실만으로 가격·출발일·실적 인정 조건까지 보장되지는 않습니다.

## 콘텐츠 사용

쇼핑 화면이 안내하는 대가성 문구: “이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.” 실제 게시 위치와 채널 제한은 서비스의 최신 안내를 따릅니다. 이 도구는 블로그 게시나 예약을 자동 수행하지 않습니다.
