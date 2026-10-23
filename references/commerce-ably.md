# Ably (에이블리) public reads

확인일: 2026-10-19. 대상: 패션 앱 에이블리 웹(`m.a-bly.com`, `mobile.a-bly.com`)과
그 데이터 API `https://api.a-bly.com`. 용도: 코디 레퍼런스(트렌드 여성 의류)와 상품 링크 수집.
요청/응답 스키마는 [commerce-ably-contracts.json](commerce-ably-contracts.json)에 있다.

## 사용법

Node 24 이상, 의존성 없음. 결과는 JSON(stdout, `--output=<새 파일>` 선택)이다.

```sh
node scripts/ably.mjs categories                                # 랭킹 카테고리 트리(sno)
node scripts/ably.mjs ranking --category=467 --period=weekly --limit=20   # 비치웨어 주간 랭킹
node scripts/ably.mjs ranking --category=10 --limit=30          # 원피스/세트
node scripts/ably.mjs search --q="린넨 원피스" --limit=30
node scripts/ably.mjs product --id=66796623                     # 상세+옵션+리워드 추정
node scripts/ably.mjs outfits --limit=30                        # 요즘코디(커뮤니티 코디)
node scripts/ably.mjs outfits --goods=66796623                  # 이 상품을 태그한 코디
node scripts/ably.mjs style-contents --limit=10                 # 룩북/스타일 콘텐츠(인플 PICK 포함)
node scripts/ably.mjs markets --type=7 --limit=20               # 셀럽(인플루언서 운영) 쇼핑몰 랭킹
```

자주 쓰는 패션 카테고리 sno: 상의 8, 팬츠 174, 원피스/세트 10(미니 206, 롱 207), 스커트 203,
아우터 7, 비치웨어 467(비키니 468, 모노키니 502, 래쉬가드 469, 원피스수영복 503), 신발 481, 가방 11.
값은 바뀔 수 있으므로 `categories` 결과를 기준으로 한다. `--period`는 daily/weekly/monthly,
`--age`는 1(10대)~5(30대 이상).

## 동작과 경계

- 실행 모드: `pure_http`. 관측만 브라우저(CDP 자동화 탭)에서 했고, 반복 수집은 Node fetch로만 한다.
- 세션: 첫 요청에서 `GET /api/v2/anonymous/token/`이 발급한 익명 JWT를 `X-Anonymous-Token`
  헤더로 보낸다(`X-Device-Id`는 프로세스마다 새 UUID). 토큰은 메모리에만 두고 출력·영수증에 쓰지 않는다.
  토큰 없이 부르면 401이다. 쿠키는 쓰지 않는다(토큰 응답의 Cloudflare 쿠키는 무시).
  공개 조회 명령에는 계정 로그인이 없다(제휴 발급 `affiliate-link`만 로그인된 Canary 세션을 쓴다). 영수증의 `credentialsUsed:false`는 사용자 자격증명이 없다는 뜻이며,
  익명 토큰 전송 여부는 `anonymousTokenSent`로 따로 기록한다.
- 간격: 요청 사이 최소 3초(`--interval-ms`로 늘릴 수만 있음). 401/403/챌린지 HTML은 즉시 중단,
  429/5xx도 재시도하지 않고 `ABLY_RATE_LIMITED`/`ABLY_HTTP_ERROR`로 끝낸다
  ([anti-bot-boundaries](anti-bot-boundaries.md)).
- 쓰기 없음(공개 조회 명령): 찜, 장바구니는 구현하지 않았다. 공유/리워드 링크 발급(POST)은 `affiliate-link` 명령에만 있다(아래 제휴 절).
- `mobile.a-bly.com` 정적 자산은 비브라우저 클라이언트에 Cloudflare managed challenge를 돌려준다.
  `api.a-bly.com` JSON은 이번 확인에서 Node에 챌린지를 걸지 않았다. 이는 2026-10-19 관측이며
  지속 보장은 아니다.

## 관측 근거

`m.a-bly.com/`은 `mobile.a-bly.com/`(Vite SPA, 빈 셸, `__NEXT_DATA__` 없음)으로 넘어간다. 데이터는
모두 `api.a-bly.com` XHR이다. `m.a-bly.com`의 Next.js 페이지(style, content/style, affiliate)의
`__NEXT_DATA__`에는 세션 컨텍스트만 있고 목록은 클라이언트 fetch로 온다.

| 기능 | 관측 요청 |
|---|---|
| 카테고리 트리 | `GET /api/v2/goods/ranking-filters/` |
| 랭킹 | `GET /api/v2/goods/?filter=best&market_type_sno=1&category_sno=467[&period=weekly]`, 다음 쪽 `&last_ranking=10&last_sno=<sno>` (10개씩) |
| 검색 | `GET /api/v2/screens/SEARCH_RESULT/?query=`, 다음 쪽 `&next_token=` (약 36개씩, `ad`가 있으면 광고) |
| 상세 | `GET /api/v3/goods/{sno}/basic/`, `/api/v3/goods/{sno}/detail/?channel=0`, `/api/v2/goods/{sno}/review_summary/` |
| 옵션 | `구매하기` 클릭 후 `/api/v2/goods/{sno}/options/brief/`, `/options/?depth=1`, `/options/?depth=2&selected_option_sno=` |
| 리워드 추정 | `GET /api/v2/affiliate/goods/{sno}/` → `expected_reward`, `SETTLEMENT_RATE: 2` |
| 코디 | `GET /community/webview/outfits/?per_page=30&order_by=recommend`, `/api/v2/goods/{sno}/related-outfits/` |
| 스타일 콘텐츠 | `GET /api/v2/style_contents/` |
| 셀럽 쇼핑몰 랭킹 | `GET /api/v2/markets/rankings/available_types/`, `/api/v2/markets/rankings/7/` |

랭킹 순위는 응답의 `goods[].ranking` 값만 쓴다(배열 위치로 순위를 만들지 않음, 중복이면 실패).
평점은 별점 평균이 노출되지 않고 `positive_review_rate`/`positive_percent`(만족 %)만 있다.
가격: `consumer`=정가(retail_list), `base_thumbnail_price`=판매가(retail_current),
`thumbnail_price`=쿠폰적용가(보는 사람의 쿠폰에 따라 달라지는 표시값).

## 링크 형식

- 웹: `https://m.a-bly.com/goods/{sno}` (basic 응답 `webview_url`과 같음)
- 앱 웹: `https://mobile.a-bly.com/goods/{sno}`, 앱 딥링크: `ably://goods/{sno}`
- 코디: `https://m.a-bly.com/content/style/{sno}/goods`, 스타일 콘텐츠: `https://m.a-bly.com/events/{sno}`,
  쇼핑몰: `https://mobile.a-bly.com/markets/{marketSno}`

이 링크들은 추적 파라미터가 없는 일반 링크이며 수익이 발생하지 않는다. 정책상 주소창 URL 복사는
리워드 대상이 아니다.

## 인플루언서 관련

- 셀럽 쇼핑몰(`markets --type=7`): 인플루언서가 운영하는 마켓 순위, 인스타그램 URL, 찜 수, 스타일 태그.
- 요즘코디(`outfits`): 사용자 착용 코디 사진, 태그, 좋아요/북마크, 태그된 상품(가격·링크).
  작성자 닉네임·키·몸무게는 개인 정보라 출력하지 않는다.
- 스타일 콘텐츠(`style-contents`): 에디터 룩북. 태그에 `인플 PICK`, 협업 인플루언서 이름이 붙는다.
- 회원 프로필 `GET /community/webview/communities/profiles/{memberSno}/`은 익명으로 200이지만
  생년월일·키·몸무게가 포함되어 구현하지 않았다.

## 제휴(크리에이터 [공유 리워드]) 프로그램 — 로그인 세션 필요, 발급 구현

`node scripts/ably.mjs affiliate-link --sno=<goods sno> [--check-only] [--reissue-reason=<text>]`.
Canary(CDP 9333)에 이미 로그인된 에이블리 세션을 쓴다. 명령이 임시 탭(`https://m.a-bly.com/my`)을 열고
탭 안에서 fetch하며, 끝나면 그 탭만 닫는다. 토큰·자격은 출력·저장하지 않는다. 구현 파일:
`lib/commerce/ably-affiliate.mjs`. 발급 기록은 write journal(service `ably`, operation
`affiliate.link_create`)에 reserve→finish로 남고, 이미 `issued`인 sno는 `--reissue-reason` 없이는 거부된다.
`--check-only`는 쓰기 없이 가입·캠페인 플래그만 읽는다.

### 확인된 계약 (2026-10-20, 번들 + 실제 호출)

- 가입 여부: `GET /api/v2/affiliate/goods/{sno}/` → `is_affiliate_member`, `is_campaign_member`, `expected_reward`.
  `members/me`의 `affiliate_information.is_link_campaign_affiliator`가 true일 때만 사이트가 발급 경로를 쓴다.
  (가입 직후에도 캠페인 참여 전에는 false였고, 그때 발급된 응답에는 `uid`가 없어 귀속되지 않았다.)
- 발급: `POST https://api.a-bly.com/api/v2/affiliate/links/` (끝 슬래시 필수; 없으면 405로 리다이렉트됨),
  body `{"goods_sno": <sno>}` → `201 {"link": "/goods/<sno>?uid=<uid>", "app_link": "https://applink.a-bly.com/<code>"}`.
- 헤더: `Authorization: JWT <ably-jwt-token 쿠키 값>`, `X-Device-Id`(localStorage `device-id`),
  `X-Web-Type: Web`, `X-Device-Type: PCWeb`, `X-App-Version: 0.1.0`.
- 링크 검증: `app_link`는 airbridge 단축 링크로 302 → `https://m.a-bly.com/goods/<sno>?uid=<같은 uid>&tracking_content=...&airbridge_referrer=...`.
  웹 `link`의 uid와 동일하다. 명령은 발급 직후 Location의 goods 경로와 uid 일치를 검사해 저널에 남긴다.
- 발급 로그 집계: 랜딩의 `uid`로 `POST /api/v2/affiliate/links/access-logs`(사이트 JS가 호출).
- 발급 전 확인: `POST /api/v2/tracking-links/`는 비가입자용 추적 경로이며 이 명령은 쓰지 않는다.

### 시작 전 조건 (사용자 측)

- 에이블리 웹/앱 계정 로그인, 앱에서 크리에이터 가입(실명·SNS 채널), 그리고 '공유 리워드'(링크 캠페인) 참여.
  참여 여부는 `--check-only`의 `member.isLinkCampaignAffiliator`로 확인한다.
- 가입은 사용자 결정이며 자동화하지 않는다.

### 정책 요지 (운영정책 이미지)

존재 확인. 익명 `members/me` 응답에 `affiliate_information.link_campaign_onboarding_deeplink`가
있고 상품 상세에 "최대 N원 받기 / 공유하기"가 보인다.

- 안내: `https://m.a-bly.com/affiliate/events/3a3c7d4a` (상품 링크 공유 → 링크 클릭 후 24시간 이내
  구매 → 결제액 일부를 현금 리워드). 가입 버튼(`campaign-register-button`)은 로그인 회원에게만 동작.
- 운영정책 `https://m.a-bly.com/affiliate/agreement/campaign-policy`(이미지) 요지: 에이블리 회원,
  본인 실명 신청, 본인 소유 SNS 채널(미디어)로 신청, 기본 리워드율 2% + 카테고리 이벤트율,
  쿠폰·포인트 제외 실결제액 기준, 구매확정 건만, 본인 링크 구매·주소창 URL·링크 임의 수정은 제외,
  월 정산(M+1월 15일), 개인은 3.3% 원천징수, 사업자는 세금계산서, 계좌 등록은
  `마이페이지 > 크리에이터 되고 수익 얻기 > 계좌등록`, 콘텐츠 첫 줄에 경제적 이해관계 문구 필수
  ("기재된 제휴 링크를 통해 상품을 구매하실 경우, 상품 구매로 발생한 수익의 일부가 작성자에게 분배됩니다."),
  만 14세 이상 미성년자는 법정대리인 동의, 문의는 카카오톡 채널 '에이블리 크리에이터'.
  리워드 대상 카테고리: 브랜드 패션, 소호 패션, 뷰티, 라이프.
- 정산 계좌·세무 정보 등록은 사용자 몫이며 자동화하지 않는다(위 '시작 전 조건'과 계약은 위 절 참조).
- AI 인플루언서 계정으로 신청 가능한지는 정책에 명시가 없다("본인이 적법하게 소유한 SNS 채널",
  "본인 실명"). 운영 측 확인이 필요하다.

## 실측 (2026-10-19)

`verification/ably-live-2026-10-19.json`: 새 Node 프로세스, 17개 GET 모두 200.
비치웨어 주간 랭킹 12위(2쪽), "린넨 원피스" 검색 20개, 1위 상품 상세(옵션 2단계, 상세 이미지 8장,
리뷰 51개·만족 90%, 리워드 추정 576원/2%), 코디 3개와 상품 연관 코디 3개, 스타일 콘텐츠 5개,
셀럽 쇼핑몰 5개. 능력별 영수증은 `verification/ably-2026-10-19/`, 체크리스트는
[checklists/services/ably.json](../checklists/services/ably.json).

## 제한

- 랭킹은 표시된 상위 순위만 검증한다. 카탈로그 전체 수집 기능이 아니다.
- 검색 결과에는 리뷰 수가 없다(상세에서 읽음). 광고 카드는 `isAd:true`.
- 쿠폰적용가는 보는 사람과 시간에 따라 바뀐다. 재고는 옵션의 품절 플래그만 보고, `stock` 값은 쓰지 않는다.
- 코디 상세 단건 JSON 경로는 관측하지 못했다(페이지는 RSC 문서). 목록과 상품 연관 코디로 대신한다.
- 대량 크롤링 용도가 아니다. 검증은 소량으로만 했다.
