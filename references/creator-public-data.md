# 크리에이터 공개 데이터: HTTP 계약과 검증 범위

스튜디오 링크와 가이드 수집 다음에는 **실제 공개 데이터**를 읽는다. 2026-10-11에 독립 HTTP로 확인한 범위는 아래와 같다. 모든 시각은 UTC이며, 전체 플랫폼·전체 페이지·계정 로그인을 확인했다는 뜻은 아니다. [계약 목록](creator-public-data-contracts.json), [출처](../provenance/creator-public-data-2026-10-11.json), [원문을 제외한 실행 기록](../verification/creator-public-data-2026-10-11.json)을 함께 읽는다.

| 소스 | 실제 응답 | 의미와 한계 | 재사용 위치 |
|---|---|---|---|
| Google Trends KR | 20:41:33, HTTP 200 / RSS XML, 키워드 10개 | 근사 트래픽 라벨과 관련 기사. 명시 순위·집계 기간·전체 키워드 수는 미확인 | 기존 Naver pack의 `fetchGoogleTrending` |
| Google Trends US / TW | 20:31:34, 각 HTTP 200 / RSS XML, 10개 | 별도 시장 요청. UI 번역과 시장 필터는 서로 다름 | 같은 기존 RSS client; 이번 native replay는 KR만 |
| TikTok Creative Center JP / US | 20:40:20, 각 JSON 4개 / 응답 total 100 | 익명 첫 페이지 preview, 광고 포함. 보고 기준일 10월 9일 | 웹 프로젝트의 `creator-tiktok.ts`; Playbook native adapter는 없음 |
| Meta Newsroom | 20:38:57, JSON 20개 / 전체 2,626개, 132페이지 | 공식 발행 소식. 검증된 Facebook·Instagram·Threads 분류 중 적합한 3개 | 웹 프로젝트의 `creator-meta.ts`; Playbook native adapter는 없음 |
| Threads `@threads` | 20:31:29, 별도 GraphQL JSON 5개 | 공식 공개 계정의 일부 게시물. 국가 트렌드·키워드 검색이 아님 | 기존 Threads pack의 `fetchThreadsXhr`; 별도 웹 port도 검증됨 |
| NAVER Shopping Insight | 2026-10-15 16:37:43.804Z, fresh anonymous HTTP replay: LCS GET 200 `image/gif`; rank POST 200 `application/json`, 12 periods × 10 ranks | category `50000003` / `date` 한 조합만 확인. LCS 발급 세션 쿠키 중 NNB만 필요·전달되고 BUC는 선택사항. 실제 요청에는 category selector `_datalab_cid`도 포함 | 기존 Naver pack의 `bootstrapAnonymousNaverSession` → `fetchShoppingRanks`; [현재 replay](../verification/remaining-naver-insight-2026-10-16/ranking-replay.json) |

이 표의 웹 client는 별도 `lifehackailab-web` 작업본에서 검증했다. Playbook의 runtime import 대상으로 연결하지 않으며 웹 배포·DB 저장·운영 cron까지 검증한 기록으로 확대하지 않는다.

후속 [웹 fresh replay](../verification/creator-public-data-web-fresh-2026-10-11.json)는 20:49~20:50에 최종 웹 코드로 별도 실행했다. Google KR·US·JP·TW·ES·FR·DE·BR 각 10개 키워드(합계 80개)와 관련 기사 projection 218개, TikTok 8개, Meta 3개, Threads 5개로 총 314개 후보가 공통 schema 검사를 통과했다. 16개 실제 HTTP 요청은 모두 200이었고 browser·계정 인증·DB 쓰기는 없었다. 요청 harness가 네트워크 전에 거부한 1개 route는 수정 후 Threads만 재검증했으며 공급자 오류로 세지 않는다. 이 기록은 native Playbook KR 단일 재생과 별도이며 production persistence는 미확인이다.

## 기존 native client 먼저 사용

저장소 루트에서 root 의존성을 설치한다. 아래 호출은 실제 HTTP 읽기다. 공개 글·키워드 원문, 이미지 주소, 익명 CSRF/session 값을 Git에 저장하지 않는다.

```js
import { fetchGoogleTrending } from './service-packs/naver/apps/naver-blog-api/research/trend-radar/sources/google-trends-rss.mjs';
const google = await fetchGoogleTrending({ geo: 'KR' });
// google.trends: keyword, approxTrafficLabel, publishedAt, news.
// approxTrafficLabel을 보존한다. "5K+"를 정확한 5,000회로 표시하지 않는다.

import { fetchThreadsXhr } from './service-packs/threads/threads-xhr.mjs';
const threads = await fetchThreadsXhr('threads', 5);
// threads.items는 공개 게시물 일부다. fullTimeline은 false다.
```

RSS client는 Node HTTP와 상대 import만 사용하며 블로그 로그인·Windows DPAPI를 요구하지 않는다. 기존 helper는 manual redirect, 요청당 15초, 최대 두 번의 제한된 시도를 사용하지만 본문을 `response.text()`로 읽으므로 streaming byte cap을 제공하지 않는다. 이번 KR 재생은 주입한 `fetchImpl`에서 정확한 origin/path/query, 10초·1 MiB, cookie/authorization 없음, redirect 거부와 총 1회 요청을 추가로 제한했다. 이 검증 wrapper의 제한을 원래 모듈의 기능으로 기록하지 않는다.

Threads는 fresh 공개 프로필 HTTP bootstrap에서 서버가 발급한 익명 CSRF와 현재 Relay 계약을 준비한다. Linux에서는 같은 프로세스 메모리, Windows에서는 기존 protected store 정책을 사용한다. 계정 로그인이나 검색 권한이 아니다. 기존 client의 본문 상한은 3,000,000 bytes, 요청 timeout은 15초다. 계약·cookie/CSRF 짝이 맞지 않으면 실패하며 HTML 게시물로 자동 대체하지 않는다.

## 소스별 요청 계약

### NAVER Shopping Insight (bounded anonymous replay)

2026-10-15 16:37:43.804Z UTC에 fresh Node process에서 유지 client로 한 조합을 재생했다. `GET https://lcs.naver.com/m`는 계정·credential·브라우저 없이 HTTP 200 `image/gif`를 돌려주고 NNB와 BUC를 발급했다. 랭킹 요청에는 NNB만 LCS 세션 쿠키로 전달했다. client는 같은 요청에 해당 category를 지정하는 `_datalab_cid` selector cookie도 붙인다. `POST https://datalab.naver.com/shoppingInsight/getKeywordRank.naver?timeUnit=date&cid=50000003`는 HTTP 200 `application/json;charset=UTF-8`로 응답했고, schema validation 결과 12개 기간에 각 10개 rank가 있었다. 키워드 원문과 cookie 값은 증거에 기록하지 않았다.

2026-10-15 16:22:57.981Z UTC의 별도 A/B 기록은 같은 NNB 값으로 BUC를 포함한 요청과 제외한 요청이 모두 동일한 200 JSON schema/byte count를 반환했음을 보여준다. [A/B 증거](../verification/remaining-naver-insight-2026-10-16/buc-ab-comparison-2026-10-15.json). 이는 BUC가 관측될 수는 있어도 필수 인증/세션 쿠키가 아님을 뒷받침한다. 현재 실행 증거는 `categoryId=50000003`, `timeUnit=date`에 한정되며 다른 category/timeUnit 조합은 별도 재생해야 한다.

유지 client는 bootstrap 또는 전송 실패를 Shopping Insight 각 요청의 실패로 기록하고 결과를 반환한다. 그러면 상위 trend run은 해당 source를 실패로 표시하면서 autocomplete, RSS 등 다른 source를 계속 진행할 수 있다. 실패를 검색량 0이나 정상 빈 결과로 바꾸지 않는다. 체크리스트의 `recorded_live`도 이 bounded replay만 뜻한다.

### Google RSS

`GET https://trends.google.com/trending/rss?geo=KR`의 실제 MIME은 `text/xml; charset=utf-8`였다. RSS XML을 JSON XHR로 표시하지 않는다. `title`, `ht:approx_traffic`, `pubDate`, `ht:news_item`을 분리한다. XML `pubDate`는 항목 발행시각이고 요청시각이나 고정 24시간 집계 기간이 아니다. 기사 URL은 별도의 관련 기사다. 이번에 현재 공식 RSS export 문서를 검증하지 않았으므로 provenance는 `first_party_observed_feed`이며 `first_party_documented_feed`로 올리지 않는다.

`geo`의 두 글자 문법 통과가 시장 지원을 보장하지 않는다. CN은 HTTP 400 HTML로 관측되어 사용할 수 없었다. 이 결과를 검색량 0 또는 정상 빈 피드로 표시하지 않는다.

### TikTok 공개 video preview

각 시장의 고정 origin은 JP `https://ads.tiktok.com`, US `https://ads.us.tiktok.com`이다. `GET /CreativeOne/Report/GetTopContentsOverview`의 `lastDailyEndTimestamp`를 읽고, 같은 origin의 `GET /CreativeOne/Report/CreativeCenterGetTopContentsList`에 다음 query를 전달한다.

| 필드 | 관측한 값·출처 |
|---|---|
| `periodDimension` | 3: source의 `Last7DaysCreated` selector |
| `periodEndTimestamp` | 직전 overview의 현재 값; 저장된 10월 9일 값을 재사용하지 않음 |
| `orderByMetric` | 1 |
| `countryCode` | 해당 JP 또는 US |
| `contentLabelIDs` | 빈 문자열 |
| `organicOnly` | false |
| `limit`, `page` | 20, 1 |

`Accept: application/json`, `Agw-Js-Conv: str`를 사용하며 cookie·로그인 credential을 보내지 않는다. HTTP 200과 `BaseResp.StatusCode === 0`, `entityInfos`, `pagination`을 함께 검증한다. 실제 응답 limit은 4, total은 100, pageCount는 25, hasMore는 true였다. public UI의 추가 보기 로그인 경계에서 멈추며 다음 페이지를 자동 요청하지 않는다.

요청 selector는 7일이지만 실제 항목 생성일은 8~9월이었다. `windowVerified:false`, 일반 지표의 period는 unknown을 유지한다. 이름에 `LifeTime`이 명시된 지표만 lifetime으로 표시한다. 첫 페이지 배열 위치는 명시 순위가 아니며 market은 작성자 국적이나 제목 언어가 아니다. `organicOnly:false`이므로 광고 포함이라는 조건을 유지한다.

계약 출처는 현재 공개 first-party JS의 route manifest와 business module이다. 익명 브라우저는 403이었고 성공 XHR capture는 없었다. 순수 HTTP business replay는 성공했으므로 두 결과를 각각 기록한다. 웹 collector의 3일 보고 기준일 제한은 로컬 6개 테스트와 후속 20:49 최종 SHA의 실제 재생으로 확인했다. 기준일이 3일보다 오래되면 목록을 요청하지 않고 실패한다. 20:40의 이전 SHA 재생과 20:49의 guard 추가 SHA 재생은 각 기록에 따로 남긴다.

`POST /CreativeOne/KnowledgeAPI/GetHashtagList`는 조회용 POST지만 HTTP 200 / application status 50000으로 실패했다. 공급자 ranking index가 없다는 응답이었다. `/cc_portal_api/api/trendsTcc`도 HTTP 500이었다. 두 기능을 video preview 성공에 묶거나 정상 empty로 처리하지 않는다.

### Meta 공식 발행 데이터

`GET https://about.fb.com/wp-json/wp/v2/posts?per_page=20&orderby=date&order=desc`는 JSON 배열이다. `X-WP-Total: 2626`, `X-WP-TotalPages: 132`를 읽고 첫 20개만 확인했다. `GET /wp-json/wp/v2/categories?per_page=100`로 실제 46개 분류를 확인했다. 이번에 관측한 IDs는 12=`facebook-app`, 14=`instagram`, 331=`threads`다. 다른 source나 변경된 taxonomy에 이 숫자를 그대로 적용하지 않는다.

웹 collector는 이 검증된 세 분류와 원래 `date_gmt`에 따른 30일 cutoff를 사용한다. `modified_gmt`와 `observedAt`은 별도 시각이다. 제목·본문은 upstream HTML이므로 안전한 텍스트 처리 또는 sanitization 후 소비한다. 최신 공식 발행 소식은 검색량·전국 인기 순위·사용자 참여량이 아니다. 첫 페이지를 전체 발행 자료로 보고하지 않는다.

### Threads 공개 profile GraphQL

`GET https://www.threads.com/@threads`에서 현재 `BarcelonaProfileThreadsTabDirectQuery`의 Relay preloader를 관측하고, 별도 `POST https://www.threads.com/api/graphql`를 실행했다. bootstrap HTML에서 게시물을 가져온 기록이 아니다. numeric doc ID, server variables, user ID, CSRF/LSD와 cookie 값은 현재 bootstrap에 바인딩해 메모리로만 전달하며 provenance에 저장하지 않는다.

관측된 form field 이름은 `av`, `__user`, `__a`, `dpr`, `__ccg`, `__comet_req`, `fb_api_caller_class`, `fb_api_req_friendly_name`, `server_timestamps`, `variables`, `doc_id`, `lsd`, `__rev`, `__hs`, `__hsi`, `__spin_r`, `__spin_b`, `__spin_t`다. 실제 header/field 구성은 기존 client를 재사용한다. 공개 read-only POST이며 발행·수정 요청이 아니다. 응답 MIME `text/javascript; charset=utf-8`의 JSON과 application error를 검증한다.

필드는 `caption.text`, `user.username`, `code`, `taken_at`, `like_count`, `text_post_app_info.direct_reply_count` / `repost_count`다. 서버가 제공하지 않은 views는 null이고 0이 아니다. 5개 profile 게시물은 전체 timeline이나 keyword search 결과가 아니다. [공식 keyword search](https://developers.facebook.com/documentation/threads/keyword-search)의 실제 예시는 `GET https://graph.threads.net/v1.0/keyword_search`다. 별도 token과 `threads_basic` / `threads_keyword_search` permissions가 필요하며 현재 provider가 연결되지 않았다. 미승인 앱은 본인 게시물만 검색할 수 있고 public search는 해당 permission 승인 후 가능하다. 이 권한은 국가별 시장 필터나 검색량을 제공한다는 근거도 아니다.

## 다섯 상태와 자동 체크리스트

`captured`는 이 기록에서 실제 request/response 관측을 뜻한다. browser XHR 여부는 별도 field로 둔다. 로그인 owner read가 없는 익명 소스의 `credential_propagated`는 `not_applicable`이며 Threads의 익명 CSRF 전달은 따로 기록한다.

| 범위 | captured | client_exists | credential_propagated | remnant_free | live_replay |
|---|---|---|---|---|---|
| Google native KR | HTTP RSS 관측; XHR 아님 | native pack 있음 | not_applicable | true | 현재 native 코드 1회 성공 |
| Threads native profile | 서버 Relay + 독립 HTTP JSON | native pack 있음 | not_applicable; 익명 CSRF 검증 | true | 현재 native 코드 5개 성공 |
| TikTok video | first-party JS 계약 + HTTP; browser XHR 없음 | 웹 client 있음, native pack 없음 | not_applicable | true | 이전/최종 guard 웹 SHA 각각 성공 |
| Meta publication | first-party API JSON 관측 | 웹 client 있음, native pack 없음 | not_applicable | true | 웹 SHA 20개 성공 |

새 checklist는 `creator-google`, `creator-threads`, `creator-tiktok`, `creator-meta`, `creator-access-gaps`다. 이 저장소의 기존 automatic verifier가 bare observed RSS provenance와 익명 cookie bootstrap GraphQL을 지원하지 않아 native Google·Threads는 `pending_live`다. 이는 실제 HTTP 재생이 없었다는 뜻이 아니라 **typed automatic evidence gate가 아직 없다는 뜻**이며 sanitized 기록과 위 표를 함께 본다. `naver.shopping`에는 별도 typed anonymous-read verifier를 추가했고, 현재 receipt가 `recorded_live`인 범위는 위의 한 category/timeUnit replay뿐이다. cookie가 사용된 Threads를 cookie-free public receipt로 꾸미거나 RSS를 공식 문서 검증으로 올려 gate를 통과시키지 않는다.

TikTok·Meta는 별도 웹 client가 있어도 package의 `implementation.files`에 외부 경로를 넣지 않으므로 `source_candidate`다. sourceEvidence는 계약 확인 재고이며 저장된 실행 기록을 자동 live gate로 승격하지 않는다. 웹 배포 확인은 별도 검증이다.

```bash
npm run checklist -- --service=creator-google --run-tests
npm run checklist -- --service=creator-threads
npm run checklist -- --service=creator-tiktok --strict
npm run checklist -- --service=creator-meta --strict
npm run checklist -- --service=creator-access-gaps --strict
npm run checklist
```

현재 required gaps 때문에 strict는 2가 정상이다. 형식 오류 1과 구별하고 기본 exit 0을 전체 완료로 보고하지 않는다.

## 다른 공개 데이터와 접근 경계

| 기능 | 확인한 계약 | 현재 부족한 부분 |
|---|---|---|
| YouTube chart | [videos.list](https://developers.google.com/youtube/v3/docs/videos/list), `GET /youtube/v3/videos`, API key·`chart=mostPopular`·`regionCode` | key provider/current replay 없음. 2025-07-21 이후 chart scope는 Music·Movies·Gaming이며 전 주제 trending으로 확대하지 않음 |
| NAVER Shopping Insight | 기존 pack `bootstrapAnonymousNaverSession` → `fetchShoppingRanks`; [fresh replay](../verification/remaining-naver-insight-2026-10-16/ranking-replay.json) | Anonymous LCS bootstrap에서 NNB와 선택적 BUC가 관측됐다. NNB 세션 쿠키만으로 category `50000003` / `date` rank request가 HTTP 200 JSON으로 검증됐다. HTML fallback은 여전히 실패다. Bootstrap 실패는 per-contract source failure이며 다른 trend sources는 계속된다. 다른 category/timeUnit은 미검증 |
| NAVER DataLab | [공식 search API](https://developers.naver.com/docs/serviceapi/datalab/search/search.md), `POST /v1/datalab/search` | Developer credential/current replay 없음. 입력 keyword groups의 상대 관심도(max 100), keyword discovery·절대 검색량 아님 |
| NAVER Creator Advisor | 관측된 `/api/v6/trend/category`, `/api/v6/trend/demo`, `/api/v6/trend/trend-contents`, `/api/v6/trend/search-inflow-trend` 후보 | 현재 owner session·서명·Linux native provider/replay 미확보. account analytics를 공개 aggregate로 사용하지 않음 |
| X 공개 aggregate | 기존 social pack과 요청별 접근 경계를 먼저 확인 | 현재 국가별 aggregate collector/replay 없음. 로그인된 계정 timeline과 전체 국가 트렌드를 혼동하지 않음 |

차단·미구현·공급자 오류를 seed 자료나 다른 플랫폼 결과로 채우지 않는다. 다음 재검증은 실패한 접근/transport/entitlement/schema 경계에 한정하고, 실사용 데이터의 market·type·source kind·출처·관측시각·원래 발행/수정시각·지표 기간·부분 수집 상태를 보존한다.
