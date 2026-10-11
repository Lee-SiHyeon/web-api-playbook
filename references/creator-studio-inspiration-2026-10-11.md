# 스튜디오 영감·인기 데이터의 실제 계약 — 2026-10-11

사용자가 요청한 것은 플랫폼 안에서 제공하는 인기 게시물·영상·음원·주제·검색어 데이터다. 공식 도구 링크, 공식 소식, 선택한 공식 계정 게시물은 이 기능의 성공 근거로 사용하지 않는다. 이 문서의 [관측·출처·실행 상태](../provenance/creator-studio-inspiration-2026-10-11.json)는 원문·계정 식별자·인증값을 제외한 날짜별 기록이다. 이전 [공개 피드 계약](creator-public-data.md)은 당시 범위를 유지한다.

## 확인한 화면과 데이터 범위

| 대상 | 실제 화면·문서 근거 | 실제 목표 데이터와 한계 |
|---|---|---|
| X Creator Studio → Inspiration | 사용자 스크린샷의 EN 콘텐츠 언어, 24h·7d·30d, 좋아요·댓글·인용 정렬. 추가 정렬 항목은 잘려서 미확인 | 현재 익명 앱과 실제 모듈은 읽었지만 해당 영감 요청은 미캡처. 인기 게시물 JSON 0개 |
| YouTube Analytics → Trends | 공식 도움말의 audience·saved searches 기반 top searches, breakout videos, recent videos, Shorts content gaps, 관심도, topic 관련 시청/검색 영상 | 여러 카드의 문서상 기간은 최근 28일. 국가별 24h·7d·30d 피드와 다르며 Studio business JSON 0개 |
| Instagram Trending Audio·Reels templates | 현재 공식 Get Inspired 문서의 인기 음원 50개와 Reels 카메라의 trending templates | 실제 음원/인기 게시물 JSON과 기간·정렬·국가·언어 계약 미캡처 |
| Facebook Professional Dashboard → Inspiration Hub | 2023 공식 공지의 popular reels·hashtags·topics·music. 2026 Creator Assistant는 자체 콘텐츠·audience에 맞춘 별도 기능 | 초기 문서상 Assistant 시장은 US·CA·IN. Hub의 대체 기능·현재 계정 접근·국가 순위를 확인하지 않았고 목표 JSON 0개 |
| Threads Search → trending topics | 현재 `/search`의 실제 Relay 입력과 별도 GraphQL HTTP200 JSON | 5개 공개 주제 preview와 소스 AI 요약. 국가·집계 기간·명시 순위·참여 지표 미제공. 주제의 게시물 확장은 application error로 중단 |
| TikTok Creative Center video preview | 이전 독립 HTTP에서 JP·US 각각 4개, 응답 total 각 100 | 합계 8개 익명 첫 페이지. 광고 포함, 요청 selector는 7일이나 실제 생성 기간은 미검증. 전체 인기 게시물/해시태그 성공으로 확대하지 않음 |
| NAVER Creator Advisor trends | 기존 first-party client와 역사적 계정 계약의 category·demo·trend-contents·search-inflow-trend | 현재 해당 origin의 세션·서명·business replay 미확보. Brandconnect provider와 별도 범위이며 계정별 개인 analytics 제외 |

콘텐츠 언어와 국가, 화면 번역 언어를 분리한다. API가 국가를 제공하지 않으면 `market:UNKNOWN`을 유지한다. 선택한 기간이 지표의 실제 집계 기간을 보장하지 않으며 누적 likes/views를 7일 증가량으로 바꾸지 않는다. 배열 위치는 `sequencePosition`이고 명시 순위가 있을 때만 `explicitRank`를 기록한다. 없는 날짜·지표는 null 또는 빈 metrics이며 0·현재 시각으로 채우지 않는다.

## 실제 성공한 Threads 주제 요청

2026-10-11 21:54:30 UTC에 다음 두 단계를 순수 HTTP로 확인했다. 브라우저나 소유 계정 credential은 사용하지 않았다.

1. `GET https://www.threads.com/search`: HTTP200 HTML은 **입력 준비에만** 사용했다. 현재 Relay preloader에서 `BarcelonaSearchTrendingTopicsSectionQuery`의 queryID·variables와 `LSD`, `SiteData`, `RelayAPIConfigDefaults`, 익명 CSRF를 메모리로 확보했다.
2. 같은 origin의 `POST /api/graphql/`: HTTP200 `text/javascript` 응답의 JSON과 application result를 검증했다. 실제 데이터 root는 `data.trends.edges[].node`이며 5개만 읽었다. 요청 변수는 `first:5`, `serp_prefetch:true`, `surface_type:"search_tab"`, `__relay_internal__pv__BarcelonaDiscussionSummariesrelayprovider:true`였다.

현재 JSON의 `trend_llm_keyword`, title/summary fragments, `search_url`, `trend_type`을 구분한다. 소스가 작성한 AI 요약은 `summaryOrigin:source_ai`, 표면은 `trending_topics`, 범위는 `unlocalized_topic_preview`다. 응답은 국가·날짜·명시 순위·likes/replies/views를 제공하지 않아 이를 추정하지 않는다. 기사·원 게시물을 독립 확인한 사실 보도와도 구분한다.

이 operation 이름은 관측 계약이다. **numeric docID나 opaque 입력을 저장·하드코딩하지 않는다.** 매 실행마다 같은 실제 bootstrap에서 현재 queryID와 변수·CSRF/LSD 짝을 다시 얻고, origin·Graph URI·actor·필드·MIME·HTTP/application error를 검사한다. 오래된 docID, 다른 서비스 쿠키, HTML에 들어 있던 주제 내용을 비즈니스 데이터로 재사용하지 않는다.

21:58:13 UTC에 첫 주제의 실제 게시물 조회는 HTTP200이어도 `APPLICATION_ERROR`였다. `STOPPED_NO_FALLBACK`으로 종료했으며 게시물 0개다. 주제 5개를 얻었다고 게시물 본문·작성자·참여량도 얻었다고 표시하지 않는다.

웹 저장소의 `src/lib/hub/ontology/creator-threads-trending.ts`는 별도 구현이다. 캡처 JSON을 오프라인으로 읽었을 때 Hub item·creator projection 각 5개가 유효했다. 이 Playbook에 해당 HTTP client를 이식했다는 뜻은 아니다. 새 collector revision의 실제 HTTP 재생·DB 저장·native Cron·공개 readback은 이 기록에서 미검증이며, 이후 증거는 해당 SHA와 실행 시각의 별도 영수증으로 추가한다.

## 현재 인증·provider 경계

현재 native metadata에는 NAVER Brandconnect credential이 존재하고 recorded status가 ready다. 허용 origin은 `https://gw-brandconnect.naver.com`뿐이며 최근 기록된 health와 현재 인증 성공은 구분한다. 이 사실은 `creator-advisor.naver.com`의 권한을 공급하지 않는다. 세션을 다른 origin으로 전달하지 않는다.

검토한 service vault의 SNS provider rows는 0이다. 이것만으로 모든 native credential provider에 로그인이 없다고 일반화하지 않는다. 기존 SNS Windows DPAPI CurrentUser provider와 현재 Linux의 사용 가능성, 계정 feature entitlement도 각각 다르다. 값·private email·Windows 식별자를 읽거나 문서에 보관하지 않았다.

현재 Google 인증은 알려진 연결 identity의 identifier를 한 번 제출한 뒤 `/v3/signin/rejected`의 “This browser or app may not be secure”에서 중단했다. password 제출과 2FA 단계는 0이며 owner 인증 성공이 아니다. X의 공개 로그인 HTTP200과 브라우저 HTTP403도 별도 관측이다. COS·stealth·TLS/sandbox 완화나 차단 우회 없이 기존 provider를 보존한다.

로그인 성공만으로 Studio audience data를 공개 aggregate로 바꾸거나 모든 기능을 green으로 만들지 않는다. provider → 소비자 → transport → 인증 → 기능 권한 → schema 순서로 실패한 경계를 확인하고, 이미 허가된 로그인은 같은 범위에서 이어간다.

## 플랫폼별 다음 실제 근거

- **X:** 현재 canonical은 옛 `__INITIAL_STATE__`/responsive-web main이 아니라 실제 `x-web` logged-out entry다. 기존 manifest404는 그 오래된 계약의 실패이며 X 전체 API 부재의 근거가 아니다. 현재 확인한 nearby profession/subscription 모듈에는 Inspiration wiring이 없었다. 인증된 앱의 정확한 영감 route·loader·operation을 확보한 다음 실제 콘텐츠 언어/기간/정렬로 bounded JSON을 재생한다. profile timeline과 Explore Trends를 대신 호출하지 않는다.
- **YouTube:** [Trends](https://support.google.com/youtube/answer/11962757?hl=en), [Inspiration](https://support.google.com/youtube/answer/15575509?hl=en), [Ask Studio](https://support.google.com/youtube/answer/16291691?hl=en)는 문서 근거다. Inspiration은 desktop English의 채널 기반 AI 아이디어이며 2026-08부터 단계적 종료 안내가 있다. Ask Studio는 채널·audience별 대체 assistant로, 국가 전체 트렌드 API가 아니다. API key 기반 Data API와 Studio session도 구분한다.
- **Instagram:** [Get Inspired](https://creators.instagram.com/get-inspired)와 [Reels](https://creators.instagram.com/reels)의 음원·template 설명을 실제 데이터로 세지 않는다. 기존 reader는 profile/posts 범위다. professional-account 접근과 실제 Trending Audio/Reels Trends module·요청·응답을 별도로 확보한다. 음원은 기존 keyword/issue/video/hashtag에 억지로 넣지 말고 실제 계약 확인 후 audio 타입을 검토한다.
- **Facebook:** [2023 Inspiration Hub 설명](https://about.fb.com/news/2023/06/helping-creators-get-discovered-and-earn-money-on-facebook/amp/)과 [2026 Creator Assistant 공지](https://about.fb.com/news/2026/06/creator-assistant-more-languages-for-ai-translations-on-facebook/)를 구분한다. 교육 사이트의 `/professional-dashboard` 링크나 generic `/api/graphql/` 문자열은 native target route나 요청이 아니다. 현재 eligible account와 정확한 read-only JSON 계약이 필요하다.
- **NAVER:** 기존 `GET /api/v6/trend/category`, `/api/v6/trend/demo`, `/api/v6/trend/trend-contents`, `/api/v6/trend/search-inflow-trend`는 동일 Creator Advisor origin 아래의 역사적 계약이다. day/week/month selector와 실제 응답 날짜·ratio/rank를 독립 확인한다. `channelId`에 묶인 개인 referrer/revenue/follower 데이터는 공개하지 않는다. DataLab developer 상대 관심도와 public shopping ranks는 별도 capability다.

## 상태 기록과 재사용

`captured`, `client_exists`, `credential_propagated`, `remnant_free`, `live_replay`는 **해당 목표 operation**에만 적용한다. 공식 도움말을 읽거나 앱 JS를 찾은 것을 target business capture로 올리지 않는다. 이번 Threads 주제의 실제 HTTP 성공도 새로운 web revision·package-native client·클라우드 운영 완료와 별도다.

이 문서 갱신은 기존 날짜별 피드 기록이나 동결한 official-news/profile 확장을 최신 전체 성공으로 바꾸지 않는다. 구현 전에는 현재 공식 입력 witness를 재사용하고, 차단·인증 redirect·rate limit·application error 뒤 재시도/호스트 교체/seed fallback을 하지 않는다. 다음 증거에는 원문을 제외한 method·origin·path·field names·status·MIME·count·hash·관측 시각·부분 범위·실행 revision을 남긴다.

추가 검증(22:08:32 UTC): 새 web 수집기 revision `f20e7c84eab0aa6f9903ed66395946ee35f165e7`에서 최신 입력으로 GET·JSON POST 한 쌍을 실행해 5개를 실제 수집했다. 데이터 본문 SHA는 `78024827e62a198a9281ab5bc31924d2ab718ba1980e8ff1753fed620d83c807`이며 과거 오프라인 캡처와 구분한다. 이 단독 수집 검증의 DB 쓰기는 0이고, Vercel 자동 실행·저장은 별도 검증 대상이다.
