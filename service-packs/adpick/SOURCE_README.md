# adpick-api

애드픽 로그인 세션으로 상품 검색, 캠페인 목록, 제휴몰, 링크 생성과 링크 조회를 HTTP로 호출하는 클라이언트입니다. Vercel의 `api/` 함수로 그대로 배포합니다. 브라우저 자동화 코드는 없습니다.

## 세션

이메일 로그인은 `POST /?ac=proc&tac=login` 입니다. 필드는 `nurl`, `memid`, `mempwd`, `captcha_str`, `loginChk=on` 입니다. 보안문자는 `GET /apis/captcha.php` JPEG이고, 같은 `ADPICK_CAPTCHA` 쿠키로 로그인 요청을 보냅니다.

성공 본문은 이 스크립트입니다.

```html
<script language=javascript>location.replace("/?ac=main");</script>
```

`loginChk=on` 으로 받은 로그인 쿠키의 `Expires`는 응답 시각으로부터 365일 뒤였습니다. `PODGATE_D1`, `PODGATE_S`는 3일, `ADPICK_LOGIN_EVENT`는 브라우저 세션 쿠키였습니다. 쇼핑·검색·링크·리포트 스크립트 안에는 별도의 세션 갱신 URL이 없었습니다.

갱신은 두 단계입니다.

1. `GET /?ac=dashboard` 에 `로그아웃`이 있고 로그인 폼이 없으면 세션을 그대로 씁니다. 대시보드가 짧은 스크립트로만 응답하는 환경은 보호된 `link_list` JSON의 `total_all`, `total_cnt`, `list` 스키마로 재확인합니다. 익명 호출은 이 응답을 받지 못하는 것을 실측했습니다.
2. 로그인 폼이 보이면 `reauth_required` 입니다. 보안문자를 다시 받아 같은 로그인 POST를 한 번 보냅니다. 만료된 쿠키를 일부러 지운 뒤의 복구는 확인하지 않았습니다.

구글 버튼은 계정 로그인 화면을 띄웁니다. 그 화면은 이 클라이언트가 대신하지 않습니다. 콜백 `GET /apis/sns-callback.php` 만 HTTP입니다. 코드가 없으면 `Social Login Fail` 스크립트가 옵니다. 성공 콜백 본문은 보지 못했습니다.

## Vercel

모든 함수는 `Authorization: Bearer <ADPICK_SERVICE_TOKEN>` 헤더가 필요합니다.

저장소를 import 하고 Environment Variables에 아래 값을 넣습니다. Git에는 넣지 않습니다.

- `ADPICK_SERVICE_TOKEN`: 최소 32자의 서버 호출용 비밀값. Lifehack 웹에도 같은 값으로 설정합니다. 공개 변수로 사용하지 않습니다.
- `ADPICK_COOKIE`: 로그인 응답의 `cookieHeader`. 세션이 필요한 기존 함수가 사용합니다.
- `ADPICK_AFFID`: 회원 아이디. [SDK 안내](https://www.adpick.co.kr/?ac=guide&tac=sdk)에 로그인하면 캠페인·추천·핫딜 URL의 `affid`로 채워집니다.
- `ADPICK_API_KEY`: [수익링크 API](https://www.adpick.co.kr/?ac=link&tac=shopping&md=linkapi) 화면의 내 API Key. 로그인하면 이미 발급된 값이 보입니다. 별도 발급 버튼은 없습니다.

캠페인 API는 안내에 적힌 대로 1분에 1회 이하로 호출합니다. 수익링크 함수는 키를 응답에 넣지 않고, 서버에서 `print=1`로 호출한 뒤 `link`만 돌려줍니다.

| 함수 | 호출 |
|---|---|
| `/api/captcha` | 보안문자 JPEG를 base64로 반환합니다. `captchaCookie`를 다음 로그인에 그대로 넣습니다. |
| `/api/login` | `POST {"email","password","captcha","captchaCookie"}`. 성공 시 `cookieHeader`를 `ADPICK_COOKIE`에 저장합니다. |
| `/api/session` | 대시보드로 세션을 확인합니다. |
| `/api/search?q=텀블러` | 상품 검색입니다. |
| `/api/campaigns?q=쇼핑` | 캠페인 HTML 카드입니다. |
| `/api/coupang?q=텀블러` | 쿠팡 검색입니다. 2026-10-12에 이 단어는 `total_cnt` 0이었습니다. |
| `/api/malls` `/api/keywords` `/api/categories` `/api/recommend` `/api/hotdeal` | 조회입니다. |
| `/api/links` | 만든 링크 목록입니다. |
| `/api/report` | 쇼핑 리포트 요약입니다. |
| `/api/product-link` | `POST {"urls":["https://..."]}`. 링크를 한 번 만들고 결과를 폴링합니다. 응답이 끊기면 다시 보내지 않습니다. |
| `/api/mall-link` | `POST {"offer":"..."}`. 제휴몰 단축 링크를 만듭니다. |
| `/api/sdk-offers` | `ADPICK_AFFID`로 `offers.php`를 조회합니다. `os`, `adtype`, `category`, `order`를 그대로 넘깁니다. |
| `/api/sdk-shopping` | 추천 상품 SDK입니다. |
| `/api/sdk-hotdeal` | 핫딜 SDK입니다. |
| `/api/sdk-link` | `POST {"url"}`. 상품 수익링크 API의 JSON 응답(`print=1`)입니다. `POST {"url","redirect":true}`이면 키 없는 짧은 주소로만 이동합니다. GET은 발급하지 않습니다. |
| `/api/banner` | `GET`은 배너 목록, `POST {"url","offer"}`는 배너를 한 번 만듭니다. `offer` 기본값은 `rand`입니다. |
| `/api/shopbox` | `POST {"title","description","category","listnum","style"}`. 저장되면 `ADPICK_AFFID`로 `https://deg.kr/shopbox/{affid}`를 붙입니다. |
| `/api/appbox` | `POST {"category","listnum","listorder"}`. 저장되면 `https://deg.kr/appbox/{affid}`를 붙입니다. |
| `/api/native` | `ADPICK_AFFID`로 네이티브 박스 iframe 소스를 조립합니다. `bannerType`, `limit`. 서버 저장은 없습니다. |
| `/api/media` | 등록된 매체 목록입니다. `mtype`은 화면 탭과 같습니다. 삭제와 북마크는 호출하지 않습니다. |

로컬에서는 같은 핸들러를 Node로 불러 씁니다. `src/client.js`의 `AdpickClient`가 요청을 만듭니다.

```bash
node --test
```

## 확인된 범위

2026-10-12에 로그인된 세션으로 제휴몰 목록, 카테고리, 검색어, 추천 상품, 상품 검색, 쿠팡 검색, 상품 URL 검사, 상품 링크 1건, 제휴몰 링크 1건, 링크 목록 재조회를 호출했습니다. 링크 목록의 개수는 그 두 건과 맞았습니다.

출금, 링크 삭제, 배너 삭제, 매체 삭제, 채팅 참여, 웹훅, 그룹 생성, 마이도메인 결제는 호출하지 않습니다. 페이스북·인스타 매체 등록은 myranky 로그인 창이라 이 클라이언트가 대신하지 않습니다. 캠페인·배너·매체 목록은 HTML입니다.

`/?ac=link&tac=shopping&md=linkapi`의 상품 수익링크 API는 `https://deg.kr/cps/click.php` 하나입니다. 주소의 `offer`는 그 호출에 들어가지 않습니다. 제휴몰 대표 링크는 `/api/mall-link`이고, 상품 URL 수익링크는 `/api/sdk-link`입니다. 제휴몰 목록 응답에서는 `affid`를 빼서 돌려줍니다.

비밀번호와 쿠키 원문은 이 저장소에 없습니다.

## Lifehack 웹 연동

`GET /api/capabilities`는 설정 여부·계정 다이제스트·세션 상태만 반환합니다. API Key, 쿠키, 회원 원문은 반환하지 않습니다. 설정 등록과 실제 원본 API 인증·발급은 별도로 확인합니다.

웹의 `/api/cron/hub-adpick`는 SDK 상품을 시간당 한 번 Supabase에 저장합니다. `/admin/adpick`에서는 저장된 최근 상품을 골라 수익링크를 발급하고 연결합니다. 웹의 DB에 발급 의도를 먼저 기록하여 응답 유실 시 자동 재발급을 막습니다. 직접 `/api/sdk-link`를 사용하는 호출자도 영속 저널로 중복·결과 불명확 상태를 처리해야 합니다.

[웹 연동 문서](https://github.com/Lee-SiHyeon/lifehackailab-web/blob/main/docs/adpick-vercel.md)와 [온톨로지](https://github.com/Lee-SiHyeon/affiliate-content-operations/blob/main/apps/naver-blog-api/research/content-store/adpick-commerce-ontology.v1.json)를 참고합니다.
