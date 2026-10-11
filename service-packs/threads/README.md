# Threads HTTP 자료 수집 스냅샷

원본 monorepo의 `threads-public.mjs`, `threads-xhr.mjs`를 이식했습니다. 저장소 루트에서 `npm ci --ignore-scripts`를 실행한 뒤 아래 라이브러리를 사용할 수 있습니다. 실제 세션 파일은 포함하지 않습니다.

```js
import { fetchThreadsXhr, probeThreadsViews } from './service-packs/threads/threads-xhr.mjs';
const result = await fetchThreadsXhr('PUBLIC_HANDLE', 5);
// result.items: 게시물 자료. result.receipt: 요청/출처/범위 증거.
// 비공개 작업 폴더에서 필요한 결과 필드만 소비하세요.
```

실행하면 해당 공개 프로필에 HTTP 요청이 나갑니다. 네트워크를 사용하지 않고 코드만 확인하려면 실행하지 마세요. `PUBLIC_HANDLE`은 실제 사용하려는 공개 계정명으로 바꿉니다. 이 패키징 작업에서 위 요청을 실행하지는 않았습니다.

## 어떤 흐름인가

1. 공개 프로필 HTML을 HTTP로 읽어 익명 CSRF 및 Relay 계약을 준비합니다.
2. 관측한 profile GraphQL operation을 별도 HTTP로 요청합니다.
3. JSON의 실제 작성자/본문/날짜를 검증해 게시물로 반환합니다. XHR 함수가 실패하면 HTML 본문으로 몰래 대체하지 않습니다.
4. 별도 `threads-public.mjs`는 명시적인 공개 HTML embedded-JSON parser입니다. XHR와 다른 방법입니다.
5. `probeThreadsViews({handle,code,postId})`는 다른 관측 operation을 사용합니다. 서버가 조회수를 `null`로 보내면 0으로 바꾸지 않습니다.

익명 bootstrap은 계정 로그인이나 전체 검색 권한이 아닙니다. API schema/doc ID/클라이언트 헤더는 변경될 수 있습니다. 현재 계약이 거부되면 다시 관측해야 하며, 오래된 ID를 근거 없이 바꾸지 않습니다.

## 세션 재사용

이식한 `session-vault.mjs`는 root `ProtectedStore`와 잠금을 사용합니다.

- Windows: 현재 사용자 DPAPI로 익명 session bundle을 저장합니다.
- 다른 OS: 같은 프로세스 메모리에만 유지합니다. 재실행 시 fresh HTTP bootstrap이 필요합니다.
- scope/handle/post code, TTL, cookie/CSRF 짝을 확인합니다. 최대 캐시 연령은 클라이언트 재사용 규칙이며 서비스의 공식 만료 보장은 아닙니다.
- 계정 로그인 쿠키를 읽거나 다른 서비스의 인증을 복사하지 않습니다.

public function은 limited items를 반환하며 `fullTimeline:false`입니다. 페이지 전체/계정 전체를 수집했다고 보고하지 않습니다. 과거 원본 관측/이식 변경 hash는 [추가 출처](../../provenance/additional-sources.json)에 있습니다.

2026-10-11에는 이 기존 client를 Linux Node HTTP로 실제 재생해 `@threads`의 공개 5개를 검증했습니다. 초기 패키징 당시의 미실행 범위와 별도 기록입니다. [현재 공개 데이터 recipe](../../references/creator-public-data.md)와 [원문 없는 실행 기록](../../verification/creator-public-data-2026-10-11.json)을 참고하세요. 익명 CSRF 전달은 account authentication이 아니며 공식 keyword search의 approved token provider는 별도로 미연결입니다.
