# sns-threads — XHR API-only

Node.js 22+ 직접 HTTP Threads 클라이언트. 공개 프로필 게시물 조회, 게시물 조회수 조회, 텍스트 글·체인(연속 답글) 발행을 제공합니다. 반복 실행에 브라우저 자동화를 사용하지 않습니다. 구조는 [sns-X](https://github.com/Lee-SiHyeon/sns-X)와 같습니다.

코드 출처: `web-api-playbook/service-packs/threads`(공개 읽기)와 `affiliate-content-operations/apps/affiliate-api-hub/scripts/sns/writers/threads.mjs`(글쓰기 요청 형식·응답 파서). 이 저장소에서 새로 추정한 엔드포인트나 필드는 없습니다.

## 현재 검증 범위

- **이 저장소에서 실행한 라이브 요청은 없습니다.** 모든 operation의 `live_replay`는 `false`이며 테스트는 모의 fetch만 사용합니다.
- 공개 프로필 조회(`BarcelonaProfileThreadsTabDirectQuery`): 원본 service pack이 2026-10-11 Linux Node HTTP로 `@threads` 공개 5개를 실제 재생함(원본 기록). 이 저장소는 익명 세션을 프로세스 메모리에만 유지하도록 바꿨습니다(DPAPI 캐시 미이식).
- 텍스트 발행(`configure_text_only_post`): 경로·form 필드·`text_post_app_info` 키는 로그인된 first-party 번들 발췌에서 확인된 것(원본 `writers.md`). 원본 저장소에서 다른 클라이언트(`threads-reply.mjs`)로 외부 텍스트 답글 1건이 owner readback까지 확인됨. **이 클라이언트로 직접 발행·readback한 기록은 없습니다.**
- 이미지/영상: `rupload_igphoto`/`rupload_igvideo` 업로드 전용 요청 빌더만 이식(`src/media.mjs`, CLI 미연결). 원본에서 업로드 단독 HTTP 200은 확인됐지만 **이미지·영상 게시물 configure/발행은 미검증**이라 `publish`는 media 입력을 `THREADS_MEDIA_PUBLISH_UNVERIFIED`로 거부합니다.
- `contracts/threads.json`은 메타데이터만 담은 날짜 스냅샷이며 operation별 다섯 상태(`captured`, `client_exists`, `credential_propagated`, `remnant_free`, `live_replay`)를 기록합니다.

## 실행 모드

| 단계 | 모드 |
|---|---|
| 공개 읽기 (익명 CSRF/LSD 부트스트랩 + GraphQL) | `pure_http` |
| 글쓰기 요청 전송 | `pure_http` |
| 로그인 세션 획득 | 이 저장소 범위 밖. 세션 공급자가 담당하며, 공급자가 브라우저를 쓰면 전체 실행은 `headless_assisted_http`로 따로 기록해야 함 |

## 실행

```bash
npm test
echo '{"operation":"profile","handle":"threads","limit":5}' | node src/cli.mjs
echo '{"operation":"views","handle":"threads","code":"POSTCODE","postId":"1234567890123"}' | node src/cli.mjs
```

## 글쓰기

```bash
# 검토용: 네트워크 발행 없음, 요청 메서드·경로·본문 해시만 출력
echo '{"operation":"publish","posts":["첫 글","이어지는 글"],"expectedOwner":"YOUR_HANDLE","expectedOwnerId":"YOUR_DS_USER_ID","jobId":"unique-job-001"}' | node src/cli.mjs
# 실제 발행: 위에서 검토한 동일 JSON 입력에 --execute 추가
```

- `--execute`가 있을 때만 POST를 보냅니다. `posts`가 여러 개면 같은 `chain_id`·`self_thread_context_id`를 쓰고 두 번째부터는 직전 게시물 ID를 `barcelona_source_reply_id`/`reply_id`로 답니다(원본 composer 발췌 근거). `replyId`로 첫 글을 기존 게시물의 답글로 만들 수 있습니다.
- `expectedOwner`/`expectedOwnerId`는 공급자가 선언한 owner·`ds_user_id`와 일치해야 합니다. 보호된 owner 조회로 토큰 소유자를 증명하는 기능은 아직 없습니다.
- `runtime/<jobId>.json`을 독점 생성(`wx`)해 같은 작업의 재발행을 막습니다. 각 POST 전에 intent(메서드·경로·본문 SHA-256)를 기록합니다. 본문·쿠키는 저장하지 않습니다.
- POST는 자동 재시도하지 않습니다. 원본 writer의 HTTP 202 재시도 루프는 제거했고, 202·전송 오류·타임아웃은 `unknown_needs_review`, 일부 생성 후 실패는 `created_needs_review`입니다. 401/403은 `AUTH_REJECTED`, 429는 `RATE_LIMITED`. 재실행 전 실제 계정에서 결과를 먼저 확인하세요.
- `PENDING` 응답(post_client_id)은 상태 폴링 쿼리가 인증 Relay 컨텍스트(fb_dtsg)를 필요로 해 이식하지 않았고 `THREADS_CREATE_PENDING`으로 멈춥니다.
- readback은 익명 공개 프로필 최근 창(최대 30개)에서 permalink code/ID와 본문을 대조합니다. 원본의 인증 readback(`BarcelonaPostPageTargetQuery`)은 미이식이며, 창 밖이거나 비공개면 `created_needs_review`가 됩니다.

## 토큰 공급자

`THREADS_SESSION_PROVIDER_MODULE`에 신뢰하는 로컬 JS 모듈의 절대경로를 지정합니다. 외부 데이터가 이 경로를 정하게 하면 안 됩니다.

```js
export default {
  async getSession({origin}) {        // origin === 'https://www.threads.com'
    return {owner, cookies:{sessionid, csrftoken, ds_user_id}, lsd, appId,
            asbdId, webSessionId, userAgent, origin, expiresAt};   // 뒤 5개는 선택
  },
  async close() {}
};
```

없으면 환경변수 `THREADS_OWNER`, `THREADS_SESSIONID`, `THREADS_CSRFTOKEN`, `THREADS_DS_USER_ID`, `THREADS_LSD`, `THREADS_APP_ID`(선택: `THREADS_ASBD_ID`, `THREADS_WEB_SESSION_ID`, `THREADS_USER_AGENT`)를 읽습니다. 인증 헤더는 `https://www.threads.com/api/v1/media/configure_text_only_post/` 정확 경로에만 붙고, close 시 메모리에서 지웁니다. 쿠키를 저장소·명령 인수·로그·평문 파일에 두지 마세요. 브라우저 쿠키 DB 추출은 구현하지 않습니다. 서버 쿠키 회전(`rotateMetaCookies`)과 세션 갱신은 미이식입니다.

## 계약 갱신

`npm run discover -- <handle>`은 공개 프로필 HTML을 쿠키 없이 GET해 preload된 프로필 쿼리 이름·docId·변수 키만 출력합니다. 토큰 값은 출력하지 않고 계약 파일을 자동 수정하지 않습니다.

## 남은 공백

이미지/영상 게시물 발행, 인증 readback, PENDING 상태 폴링, 쿠키 회전, 삭제·수정, 프로필 편집(원본에서도 fail-closed), 원본 social-actions의 검색·팔로우·답글·인사이트 기능은 이 저장소에 없습니다.
