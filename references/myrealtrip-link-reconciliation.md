# MyRealTrip 링크 계약과 독립 확인

상품 원문 `source_url`, API가 발급한 `affiliate_url`, 발급 `mylink_id`, 운영 UI가 실제 선택한
목적지는 서로 다른 사실이다. 원문 URL만 저장돼 있는 행을 제휴 연결 완료로 표시하지 않는다.
이 저장소의 root `scripts/myrealtrip.mjs`는 아래 웹 파트너 경로를 사용한다. 공식 v1 Partner
API를 자동 선택하는 명령을 새로 추가한 것은 아니다.

| 경로 | 인증·쓰기 | 성공 계약 |
|---|---|---|
| 관측한 웹 파트너 API | `api3-backoffice.myrealtrip.com`, `partner-access-token`, `POST /partner/v2/mylink` | HTTP/application 200, `data.id`, `mylink`, `expirationMinutes` |
| 공식 Partner API | `partner-ext-api.myrealtrip.com`, Bearer API key, `POST /v1/mylink` | 2026-10-11 실측 HTTP/application 201, `data.mylinkId`, `mylink` |

웹 로그인·refresh token은 공식 API key와 같은 자격이 아니다. response field 이름과 성공 status도
섞지 않는다. [공식 API 가이드](https://docs.myrealtrip.com/)의 `/health`는 공개
`requiresAuth:false` endpoint이므로 200만으로 API key·링크 발급 권한이 검증됐다고 하지 않는다.
인증된 업무 operation의 실제 결과를 별도 확인한다. 공식 문서의 `/v1/mylink` 입력은 2,000자
제한이며 웹 adapter의 입력 제한을 그대로 적용하지 않는다.

공식 상품 조회는 [투어·티켓 검색 recipe](myrealtrip-official-catalog-search.md)를 따른다.
읽기 전용 검색 POST와 링크 발급 POST의 재시도·가격·저장 계약을 구분한다.

## 발급과 검증 실패를 구분

기존 [root link flow](../lib/myrealtrip-link-flow.mjs)는 검증한 owner와 정규화 target의
안정된 저널 키를 POST 전에 예약한다. 응답 유실·알 수 없는 성공 응답·로컬 저널 실패를
서버 미생성으로 추정하지 않는다. 성공적으로 얻은 short link는 보존하고 verification만
읽기 전용으로 재개한다. 실패한 검증을 해결하려고 같은 링크를 다시 발급하지 않는다.
`ok:true / outcome:created / verification.verified:false`는 발급 ACK와 검증 실패를 함께 나타낸다.

웹 `createLink`의 restart-safe 저널과 composite `createFlightLink`의 coverage는 다르다.
flight landing이 완료됐다면 그 URL부터 재개해야 하며, 전체 workflow를 다시 보내지 않는다.
새 공식 API adapter를 이식할 경우에도 기존 root CLI의 저널이 자동 적용된다고 가정하지 않는다.

## 익명 short-link readback

실제 verifier는
[`verifyMyrealtripLink`](../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs)다.
관측한 short-link 응답 하나만 GET하며 credential과 쿠키를 보내지 않고 `redirect:manual`로 멈춘다.
단축 URL은 HTTPS `myrealt.rip`의 단일 영숫자 path이며 query·fragment·userinfo를 거절한다.

HTTP 301/302/303/307/308의 Location이 정확한
`https://www.myrealtrip.com/main/bridge/marketing`이고 `return_url`이 하나여야 한다.
그 안의 HTTPS 목적지에 대해 아래를 확인한다.

- 원문 origin·path를 그대로 보존한다. host suffix 속임수·다른 상품·외부 목적지를 거절한다.
- 원문 query의 날짜·옵션을 `getAll`로 비교한다. 반복 값의 누락·추가·순서 변경도 거절한다.
- 추가할 수 있는 query key는 `mylink_id`, `t_scope`, `utm_source`뿐이다.
  새 date/option/redirect key는 원문과 ID가 맞아도 거절한다.
- `mylink_id`는 정확히 한 번이고 발급 응답의 정수 ID와 같아야 한다.
- `t_scope`가 있으면 한 번이고 `web` 또는 `604800`이다. `web`만 허용하면 실제 공식
  v1 링크를 잘못 거절한다. `604800`을 만료 시각·통화·수수료율로 해석하지 않는다.
- `utm_source`가 있으면 한 번이고 관측한 `mktpartner`다. 다른 값·중복 값은 새 계약을
  검토하기 전까지 거절한다.

알 수 없는 query를 임의로 버리고 검증 성공 처리하지 않는다. 계약이 변하면 첫 실패와
비밀을 제외한 shape를 기록하고, API 재발급 없이 기존 short-link GET만 다시 검증한다.
short-link GET 자체가 방문 집계에 반영될 가능성은 있으며, 이를 최종 상품 방문·예약·전환으로
주장하지 않는다. 일반 affiliate URL에 이 MyRealTrip 전용 검증 방식을 적용하지 않는다.

2026-10-11에는 이 저장소에 이미 기록돼 있던 canary를 새 verifier로 GET 1회 재검증했다.
정확 목적지·발급 ID·301이 통과했고 POST·로그인·최종 redirect follow는 하지 않았다.
[읽기 영수증](../verification/myrealtrip-link-readback-2026-10-11.json)은 현재 adapter hash를
기록한다. 이 영수증은 당시 웹 owner 인증·현재 수수료·다른 상품 전체를 새로 증명하지 않는다.

## 운영 사이트에 붙인 뒤

검증한 ID와 원문이 현재 행과 같고 기존 `affiliate_url`이 NULL인 경우에만 좁은 CAS transaction으로
붙인다. 원문·가격·관측 시각·image·journal을 보존한다. COMMIT 뒤 독립 DB readback과 사이트의
실제 outbound route를 각각 확인한다. route의 host allowlist에 `myrealt.rip`이 빠져 있으면
DB에 링크가 있어도 원문으로 대체될 수 있다. 검증은 bot/no-follow 요청처럼 의도한 analytics
영향을 줄이는 경로를 사용하고, Location과 저장한 short link가 정확한지 대조한다.

사진 보완은 같은 상품·프로모션의 원본 JSON/DOM 또는 확인한 숙소 상세만 사용한다.
페이지 공통 OG·플랫폼 로고·항공사 로고를 개별 상품 사진으로 추정하지 않는다. ID·제목·원문을
맞춘 기존 NULL만 보완하며, image URL 존재·이미지 MIME 200·실제 화면 로딩을 별도 기록한다.

회귀 검사는 `node --test tests/myrealtrip-link-verification.test.mjs
tests/myrealtrip-link-flow.test.mjs`이며 모두 합성 응답이다. 실제 short-link readback과 구별한다.
