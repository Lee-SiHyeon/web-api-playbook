# 쇼핑 쇼츠 영상 소스 (video-sources)

확인일: 2026-10-17. 쇼핑 쇼츠에 쓸 **상품 영상**을 찾고, 출처 기록과 함께 내려받고, 판매 가능한 상품으로 다시 연결하는 기능 묶음이다. 체크리스트: [`checklists/services/video-sources.json`](../checklists/services/video-sources.json).

## 업계 소싱 절차 (2026 강의 30편 자막 기준)

1. 쿠팡에서 상품 선정(로켓배송, 주방·생활·뷰티·패션).
2. 상품명을 중국어로 번역 → 샤오홍슈·더우인·타오바오·1688에서 영상 검색. 역방향으로 릴스 캡처를 이미지 검색해 상품명 확인.
3. 외부 다운로더로 3~4개 클립 확보 → GPT 대본 → TTS+SRT → 캡컷/Vrew 편집 → 인스타·네이버 클립·유튜브·틱톡 동시 업로드, 인포크 자동 DM/유튜브 쇼핑 태그.

강의들도 "해외 영상이 100% 안전하지 않다"고 말한다. 이 저장소는 내려받은 모든 파일에 **권리 근거**를 기록하고, 권리가 확인되지 않은 파일은 `third_party_work_verify_rights_before_publishing`으로 표시한다.

## 구현 상태

| 소스 | 경로 | 상태 |
|---|---|---|
| AliExpress 판매자 상품 영상 | `mtop.aliexpress.pdp.pc.query` (acs.aliexpress.com, appKey 12574478) → `data.result.HEADER_IMAGE_PC.productVideo` | **동작**: 브라우저 탭 전송으로 3/3 SUCCESS, 영상 2개 다운로드 |
| AliExpress 공식 제휴 API | `has_video`, `product_video_url` (`lib/commerce/aliexpress-affiliate.mjs`) | 코드 있음, app_key/app_secret 필요 |
| 1688 검색 | `mtop.relationrecommend.wirelessrecommend.recommend/2.0` (h5api.m.1688.com, appKey 12574478, appId 32517) → `data.data.OFFER.items` 60개 | **동작**(로그인 없음, 탭 전송): ID·제목·위안 가격·판매 건수·재구매율·이미지 |
| 1688 상품 영상 | `detail.1688.com/offer/{id}.html` 서버 HTML의 `"video":{videoId, videoUrl, coverUrl, title}` | **동작**: Node 직접 GET은 punish 페이지, 탭 fetch는 200. 영상 2개 다운로드 (`cloud.video.taobao.com` → `caiyuanbao.alicdn.com`) |
| 타오바오 상세 영상 | 같은 MTOP H5 서명 | 미관측 |
| Amazon US 판매자 영상 | PDP `"videos"` + HLS 1080p | **동작**(로그인 없음, 탭 전송) |
| 더우인 / 샤오홍슈 | 웹 서명(a_bogus / x-s) + 로그인 | **로그인 필요 확인**: 더우인은 검색 시 로그인 모달, 샤오홍슈는 `code -101 无登录信息` |
| 쿠팡 상품 매칭 | 제목·이미지 기준 동일 상품 확인 | 미구현 |

## AliExpress: 왜 브라우저 탭 전송인가

- 서명: `sign = md5(token & t & appKey & data)`, token은 `_m_h5_tk` 쿠키의 `_` 앞부분.
- 2026-10-15: 익명 Node 호출 → `FAIL_SYS_USER_VALIDATE`.
- 2026-10-17: 자동화 프로필 쿠키를 Node로 재사용 → 첫 호출 SUCCESS, 이후 `RGV587_ERROR::SM`(위험 관리). 같은 시점에 **탭 안에서 보낸 fetch는 3/3 SUCCESS**.
- 그래서 기본 전송은 `browser_tab_fetch`: 서명·파싱은 Node, 전송만 사용자가 띄운 루프백 CDP 프로필(Chrome Canary `:9333`)의 `ko.aliexpress.com` 탭에서 `fetch(..., {credentials:'include'})`. 클릭·챌린지 풀이·DOM 읽기는 하지 않는다. `challenge` 판정이면 즉시 멈추고 사람이 브라우저에서 해결해야 한다.
- 호출 간격 기본 2.5초(`minIntervalMs`), 토큰 회전(`FAIL_SYS_TOKEN_EXOIRED`)은 1회만 재서명.

## 사용법

```powershell
# 자동화 Canary 프로필 실행(이미 떠 있으면 재사용)
powershell -File $env:USERPROFILE\.config\affiliate-content-operations\browser\start-naver-canary.ps1

npm run video:sources -- aliexpress product-media --product-id 1005007677070035 --download .runtime\video-sources
# 선택: 쿠키 묶음을 DPAPI에 저장하고 Node HTTP로 재생(위험 관리에 걸리기 쉬움)
npm run video:sources -- aliexpress session-import --cdp http://127.0.0.1:9333
npm run video:sources -- aliexpress product-media --product-id <id> --transport http
```

결과: 상품명, 이미지(최대 30), `video{videoId, playUrl, posterUrl, uploaderAccountId}`, 스토어 신호(180일 판매량, 긍정 평가율, 스토어 평점), 호출 영수증. `--download`는 `video.aliexpress-media.com` → `gv-vod-cdn.aliexpress-media.com` 리다이렉트만 허용하고, 파일 옆에 `<file>.provenance.json`을 쓴다.

## 권리 근거 값 (`RIGHTS_BASIS`)

| 값 | 의미 |
|---|---|
| `seller_product_video_unverified` | 마켓 판매자가 올린 상품 영상, 재사용 조건 미확인 |
| `affiliate_api_media` | 공식 제휴 API가 홍보용으로 반환한 미디어 |
| `supplier_licensed_marketing` | 공급사가 재판매자에게 명시적으로 허락한 마케팅 소재 |
| `own_footage` | 직접 촬영 |
| `creator_content_unlicensed` | SNS 크리에이터 콘텐츠, 허락 없으면 참고용 |

## 1688 사용법

```powershell
npm run video:sources -- 1688 search --keyword 折叠电子钢琴
npm run video:sources -- 1688 offer-media --offer-id 678197228838 --download .runtime\video-sources
```

- 검색어는 중국어. `charset=utf8`로 보내서 GBK 변환이 필요 없다.
- 같은 판매자의 여러 상품이 영상 하나를 공유한다(관측: 1047106487219와 848877992659가 같은 videoId). 영상 ID로 중복 제거한다.
- 1688 영상은 1~2분, 가로·정사각이 많다. 쇼츠에는 3~5초 단위로 잘라 쓴다.

## Amazon (US) 판매자 영상

```powershell
$env:FFMPEG_BIN = "C:\path\to\ffmpeg.exe"   # 또는 PATH
npm run video:sources -- amazon search --keyword "folding piano keyboard"
npm run video:sources -- amazon product-videos --asin B0DS23X39K --download .runtime\video-sources
```

- PDP Document의 `"videos":[...]`(이미지 블록 `IB_G1`). `aciContentId`가 `amzn1.ive.seller.video.*` / `amzn1.ive.vendor.video.*`이면 판매자·브랜드 영상으로 분류하고, 그 외(크리에이터·고객 영상)는 `--include-creator` 없이는 제외한다.
- 직접 MP4는 480p(`default.jobtemplate.mp4.480.mp4`)뿐이다. HLS 마스터에서 짧은 변 기준 ≤1080 최고 화질을 골라 ffmpeg `-c copy`로 합친다(세로 1080x1920 유지).
- 2026-10-17: 검색 52 ASIN, 표본 6개 중 4개에 판매자 영상, 3개 다운로드(19초).

## 유사상품 탐색 (`npm run video:similar`)

```powershell
$env:FFMPEG_BIN = "C:\path\to\ffmpeg.exe"
npm run video:similar -- --title "IRIN PJ88C 접이식 디지털 피아노 88키" --image https://ae-pic-a1.aliexpress-media.com/kf/<id>.jpg --per-source 30 --judge --videos 6 --output .runtime\similar.json
```

1. 키워드: `--ko/--zh/--en`이 없으면 로그인된 agy(Gemini)로 생성(알리 KR=ko, 1688=zh, 아마존=en).
2. 소스별 검색(탭 전송) → 후보의 대표 이미지 dHash(ffmpeg 9x8) + 같은 언어 제목 trigram + **모델 코드 일치(PJ88C 등, 언어 무관) 가산** → 점수.
3. `--judge`: 상위 25개를 LLM이 `same / type / different`로 판정, 순서 `same > type > 미판정 > different`.
4. `--videos N`: 위 순서대로 `different`를 건너뛰며 판매자 영상 조회.

관측(2026-10-17): 판매자마다 사진이 달라 dHash 거리는 22~29에 몰려 약한 신호다. 모델 코드와 LLM 판정이 결정적이었다. 1688 이미지 검색은 업로드(imageId)까지만 되고 검색은 막혀 미구현.

## 조사했지만 구현하지 않은 소스 (2026-10-17)

| 소스 | 관측 | 판단 |
|---|---|---|
| Walmart | 탭 fetch로 검색·PDP 정상. 표본 4개 모두 `"videos":null`, `videoInfographics`(VIG_*)만 있음 = 월마트가 상품 이미지로 자동 생성한 슬라이드 | 판매자 실촬영이 아니라 쇼츠 소재 가치 낮음 |
| Shopify 브랜드 스토어 | 5개 브랜드 × 12상품의 `/products/{handle}.js` 미디어에 영상 0개, 3곳은 `/products.json` 403 | 브랜드별 스토어라 검색 소스가 아님 |
| 1688 이미지 검색 | 업로드(`uploadBase64WithRequest`, JPEG 필수) → imageId까지 성공, `imageSimilarSearchV2`는 params invalid. 2026-10-26 재확인: 같은 탭에서 업로드 직후 `getOfferList`에 `tab=imageSearch, imageId, imageIdList`를 넣으면 `searchScene=pcOfferSearch`는 이미지와 무관한 일반 추천 60개, `pcImageSearch`는 0개. 결과 화면 `s.1688.com/youyuan/index.htm`은 슬라이더 인증(punish), `similar_search.html?imageAddress=`는 검색 호출 자체가 없음 | 비로그인으로는 쓸 수 없음. 자동화 Canary에 1688 로그인 후 재확인 |
| 더우인 / 샤오홍슈 | 검색에 로그인 필요 | 작업용 계정이 생기면 추가 |

## 판정기(judge) 선택 — 2026-10-17 실측

| `--judge` | 경로 | 상태 |
|---|---|---|
| (기본) `codex` | 설치된 Codex 앱의 `codex.exe exec --model gpt-6-luna --output-schema` + 이미지·제목 | **동작.** ChatGPT 구독, API 크레딧 불필요, 10개 판정 약 5~10초. 제목을 빼면 다른 브랜드를 same으로 오판 |
| `gateway` | Vercel AI Gateway 채팅(OIDC 또는 `AI_GATEWAY_API_KEY`) | 무료 $5 크레딧 팀은 `gemini-2.5-flash`만. Gemini 3.x·Jev·Claude는 403 |
| `agy` | Antigravity CLI 텍스트 판정 | 동작, 이미지 없음 |

Decision 모델 계약(크레딧 충전 후 사용, 현재 403/429):
- Vercel: `POST https://ai-gateway.vercel.sh/v1/decisions`, `model: "openai/gpt-6-luna-decisions"` 또는 `microsoft/microsoft-decision-1`.
- OpenAI 직접: `POST https://api.openai.com/v1/decisions`, `model: "gpt-6-luna"`.
- 본문: `{ model, input: [{ role: "user", content: [{type:"input_text",text}, {type:"input_image", image_url:"data:image/jpeg;base64,..."}] }], questions: [{type:"predicate", instructions}, {type:"choice", instructions, choices:[{value:"same"},{value:"type"},{value:"different"}]}] }` (Vercel은 choice에 `label` 허용, OpenAI는 `label` 거부. 이미지는 base64 data URL만, 외부 URL 불가). Codex CLI(ChatGPT 계정)에서는 decision 모델이 거부된다.

## 쿠팡 → 해외 같은 상품 → 판매자 영상 (`npm run video:pipeline`)

```powershell
npm run video:pipeline -- --coupang-url https://www.coupang.com/vp/products/8733070301 --out .runtime\pipeline --include-type --max-videos 4
npm run video:pipeline -- --coupang-query "접이식 피아노" --pick 3 --out .runtime\pipeline
```

- 쿠팡 검색·상품 Document는 Node 직접 GET이 403이라 탭 전송으로 읽는다. 상품 페이지의 `og:title`, `og:image`(640x640)가 기준.
- 결과: `<out>/coupang-<productId>/manifest.json`(기준 상품, 키워드, same/type 매칭과 사유, 영상 상태) + 영상 파일과 `.provenance.json`(매칭된 쿠팡 상품 ID·판정 포함).
- 2026-10-17: 토이게이트 88건반(국내 브랜드) → same 0, type 8, 아마존 판매자 영상 4개, 63초. 국내 브랜드 상품은 same이 없을 수 있어 `--include-type`으로 같은 종류 영상을 쓴다.

### 탐색 누락 방지 (2026-10-26)

소유자 지시: "판매자 영상이 있는데 못찾는 누락이 발생하지 않게". 쿠팡 상품 네 개(SKY 베라 피지 흡입기, 88그로스 욕실 청소기, 지티스
접이식 전기포트, APEXSO 디스펜서)가 모두 same 0이었고, 원인은 탐색 범위였다.

| 원인 | 수정 |
|---|---|
| 소스마다 검색어 1개(일반명사)만 사용 | `productKeywords`가 `koAlt/zhAlt/enAlt`(더 구체적인 표현, 판매자 관용어)를 함께 반환하고 모두 검색 |
| 1688 첫 페이지 상위 30개만 사용 | 1688 2페이지(`--pages-1688`), 소스당 최대 60개(`--per-source`), 키워드 간 중복 제거 |
| dHash 상위 10개만 판정(카탈로그 썸네일은 배경이 달라 dHash 순위가 약하고, 한 소스가 10칸을 다 차지) | 소스별로 번갈아 섞은 순서로 10개씩 배치 판정, `--judge-max`(기본 60)까지. same이 영상 목표의 2배 나오면 중단 |
| "0개"가 실제로 없는 것인지 판정 못 한 것인지 구분 불가 | manifest `coverage`(소스별 검색 수·후보·판정·same·type·미판정·오류)와 `possibleMiss`(same 0인데 미판정이나 검색 오류가 있으면 사유 목록). `possibleMiss`가 있으면 "없음"으로 결론 내리지 않는다 |
| 같은 상품 판매 페이지라도 영상은 공장 투어이거나 다른 색·모델 | 받은 영상에서 6프레임을 뽑아 기준 상품 사진과 Codex로 비교(`codexVideoCheck`). `match: same`만 목표 개수에 넣고, 나머지는 `rejected/`로 옮긴 뒤 `videoStatus: rejected:<match>/<content>`로 기록. 끄려면 `--no-video-check` |
| 실행마다 LLM 검색어가 달라 앞서 찾은 같은 상품이 다음 후보군에서 빠짐 | 쿠팡 상품별 캐시 `%LOCALAPPDATA%\web-api-playbook\video-pipeline\coupang-<id>.json`에 same 판정을 누적하고, 매 실행 후보에 다시 넣는다(`carried: true`) |

SKY 베라 피지 흡입기(7728282851) 실측: 기존 same 0·영상 0 → 검색 범위 확장 후 후보 288개, same 12, 영상 4. 그러나 영상 4개 중 2개는
공장 영상과 민트색 다른 모델이었다. 영상 단계 검증을 넣은 실행에서는 후보 328개를 전부 판정해 same 8, 받은 영상 7개가 모두 다른 모델이나
공장 영상이라 걸러졌다.
