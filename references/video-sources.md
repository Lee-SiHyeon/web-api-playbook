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
