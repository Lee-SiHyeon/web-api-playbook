# ChatGPT 이미지 생성 경로 관찰 - 2026-10-29

스크립트: `scripts/chatgpt-image.mjs` (로그인된 브라우저 UI를 CDP로 조작). 헬퍼: `lib/chatgpt-web-image.mjs`, 테스트: `tests/chatgpt-web-image.test.mjs`.
이 문서는 관찰한 사실만 적습니다. 쿠키, 토큰, 계정 식별값은 기록하지 않았습니다.

## 1. "ChatGPT로 로그인" 제3자 경로로는 이미지를 만들 수 없음

blogai 동반 앱은 OAuth로 `auth.openai.com`에 로그인합니다 (동적 클라이언트, `client_id`는 `oaiapp_…` 형식).

- scope: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`
- 호출: `POST https://api.openai.com/v1/responses`, `tools: [{type: "image_generation"}]`
- 서버 응답: HTTP 400, `invalid_request_error`, code `subscription_sharing_unsupported_capability`, param `tools`
- 메시지 원문:
  "User subscription sharing currently supports only 'web_search' and developer-defined 'function' and 'custom' tools, including 'namespace' and 'programmatic_tool_calling'; tool 'image_generation' is not supported. Remove it or use an API key instead."

같은 경로의 텍스트 생성은 동작했습니다. 즉 구독 공유 경로에서는 `image_generation` 도구만 거부됩니다.

## 2. ChatGPT Android 앱 (1.2026.293, versionCode 2629319) 정적 문자열

- 엔드포인트 문자열: `backend-api/f/conversation`, `backend-api/f/conversation/prepare`, `backend-api/conversation`
- 기능 플래그: `image_gen_enabled`, `image_gen_tool_enabled`
- 이미지 결과 참조: `sediment://`, `file-service://` 자산 포인터

앱에서는 이미지 생성이 정상 동작했습니다 (약 1분).
앱의 전송 경로(`f/conversation`)는 호출하지 않습니다. sentinel/proof 토큰이 필요하고 계정 위험이 있습니다.
전송은 실제 웹 UI로 하고, 결과 조회·다운로드만 아래 "캡처된 계약"의 읽기 호출로 합니다.

## 3. 폰 Chrome 경로 (동작 확인)

- Android Chrome 155가 `@chrome_devtools_remote` 소켓을 노출합니다.
  `adb forward tcp:9471 localabstract:chrome_devtools_remote` 후 `http://127.0.0.1:9471`로 CDP에 붙습니다.
- Google 로그인 후 페이지는 `https://chatgpt.com/?lightweight_authenticated=1&mweb_fallback=1` (모바일 경량 웹)으로 이동합니다.
- 셀렉터 (한국어 UI):

| 요소 | 관찰 |
|---|---|
| 입력창 | `form [contenteditable="true"]`, class `ProseMirror`, aria-label "ChatGPT에게 물어보세요" |
| 보내기 | 텍스트를 넣은 뒤에만 나타남. aria-label "보내기", `data-testid` 없음 |
| 폼의 다른 버튼 | "파일 등 추가", "ChatGPT 모델 선택", "음성 입력", "음성 대화 시작" |
| 레이아웃 | `<main>` 요소 없음 |

- `element.focus()`와 `document.execCommand`는 사용자 활성화(user activation)가 없어서 동작하지 않았습니다.
  대신 `Input.dispatchMouseEvent`로 실제 클릭을 보낸 뒤 `Input.insertText`로 입력했습니다.
- 결과: `img`, alt "생성된 이미지 1", `data-testid="generated-image-preview"` 안, src `blob:https://chatgpt.com/<uuid>`.
  16:9 요청에 대해 1672×941 PNG, 약 2.0 MB.
- 탭 처리 (실기기 확인): 폰 Chrome 155는 `PUT /json/new?<url>`에 "Could not create new page"로 응답합니다.
  그래서 폰에서는 새 탭을 만들지 않습니다. `/json/list`에서 `https://chatgpt.com/`으로 시작하는 기존 페이지 탭을 재사용하고,
  없으면 `adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d https://chatgpt.com/`로
  Chrome을 띄운 뒤 `/json/list`를 최대 20초 폴링합니다. 실행 전에 `Page.navigate`로 `https://chatgpt.com/`을 열어 매번 새 대화로 시작하고,
  실행이 끝나도 그 탭은 닫지 않습니다. PC(`--target=pc`)와 `--cdp` 지정 시에는 기존처럼 스크립트가 탭을 만들고 끝나면 닫습니다.
- 생성 시간: 약 60-75초. 완료 후 URL이 `/c/<conversation-id>`로 바뀝니다.
- 비용: 추가 과금 없음 (구독 범위 내).

## 4. 비교

| 항목 | 제3자 OAuth + Responses API | ChatGPT Android 앱 | 폰 웹 UI (이 스크립트) |
|---|---|---|---|
| 로그인 | 앱이 OAuth로 별도 로그인 | 앱 자체 로그인 | 소유자가 기기 Chrome에서 직접 로그인 |
| 엔드포인트 | `api.openai.com/v1/responses` | first-party `backend-api` (비공개) | chatgpt.com 페이지 UI |
| 이미지 도구 | 불가 (`subscription_sharing_unsupported_capability`) | 가능 | 가능 (UI 기능) |
| 비용 | API 키 과금 또는 구독 공유 불가 | 구독 | 구독 |
| 자동화 방식 | HTTP 직접 호출 | 앱 조작 또는 비공개 API 재현 (하지 않음) | CDP로 실제 페이지 조작 |

## 5. 경계

- 로그인은 소유자가 기기에서 직접 합니다. 스크립트는 로그인하지 않으며, 로그인되지 않았으면 `NOT_LOGGED_IN`(exit 3)으로 끝냅니다.
- 쿠키를 내보내지 않습니다. 토큰을 유도하지 않습니다.
- 전송 호출(`POST /backend-api/f/conversation`)은 재생하지 않습니다. 기록은 `discovery/` 캡처에만 두고 레지스트리에 등록하지 않습니다.
- 읽기 호출 3개(대화 조회, 파일 다운로드 메타, conversation/init)만 레지스트리에 등록합니다. 모두 페이지 안에서 페이지의 세션으로 실행하며, 토큰은 페이지 밖으로 나가거나 출력되거나 저장되지 않습니다.
- 재생성(regeneration) 정책은 호출하는 쪽의 책임입니다. 스크립트는 한 번 보내고 한 장을 저장합니다.

## 6. 사용 예

```sh
# 점검만 (아무것도 보내지 않음)
node scripts/chatgpt-image.mjs --probe

# 폰 Chrome (기본)
node scripts/chatgpt-image.mjs out/cat.png --prompt="창가의 고양이, 16:9, 수채화" --timeout=300

# 폰에서는 기존 chatgpt.com 탭을 재사용하고 닫지 않음 (새 탭은 만들지 않음)
# PC 자동화 Canary (포트 9333), 스크립트가 만든 탭은 끝나면 닫음
node scripts/chatgpt-image.mjs out/cat.png --prompt="..." --target=pc
```

출력은 stdout의 JSON 한 줄입니다: `{out, bytes, mime, width, height, conversationPath}`.
종료 코드: 0 성공, 2 사용법 오류, 3 로그인 필요, 4 생성/시간 초과/기타 실패.

`service-packs/chatgpt/contracts/registry.json`에는 읽기 계약 3개가 캡처 상태로 있습니다 (`history.conversation.read`, `image.conversation.init`, `image.file.download`).
전송 계약은 등록되지 않았습니다 (`text.send`는 여전히 `CONTRACT_NOT_CAPTURED`).

## 캡처된 계약 (2026-10-29)

원본: [`service-packs/chatgpt/discovery/xhr-capture-2026-10-29.json`](../service-packs/chatgpt/discovery/xhr-capture-2026-10-29.json). 헤더 이름만 있고 토큰, 쿠키, proof, turnstile 값은 제거되어 있습니다.
페르소나 chatgpt-paid, 기본 모델 gpt-6. 안드로이드 Chrome 155 (adb CDP)에서 기록했습니다.

| 계약 (레지스트리 id) | 호출 | 용도 | 상태 |
|---|---|---|---|
| `history.conversation.read` | `GET /backend-api/conversations/{id}` (Bearer) | 결과 메시지 조회 | 등록, 읽기 |
| `image.conversation.init` | `POST /backend-api/conversation/init` | 이미지 한도 조회 (`limits_progress`의 `image_gen`) | 등록, 읽기 |
| `image.file.download` | `GET /backend-api/files/download/{file_id}?conversation_id=…&inline=false` → `download_url` | 파일 메타와 다운로드 URL | 등록, 읽기 |
| (등록 안 함) | `POST /backend-api/f/conversation` (text/event-stream) | 전송 | 재생하지 않음 |
| (등록 안 함) | `POST /backend-api/f/conversation/prepare`, `POST /backend-api/sentinel/chat-requirements/prepare` · `finalize` | 전송 준비 | 재생하지 않음 |

### 읽기 계약 상세

- **대화 조회**: 응답의 `messages` 배열 또는 `mapping` 트리에서 작성자 `role: "tool"`, `name`이 `t2uay3k.`로 시작하고 `status: "finished_successfully"`인 메시지를 찾습니다.
  그 `content.parts` 안의 `content_type: "image_asset_pointer"` 항목이 이미지입니다. 포인터는 `sediment://file_<32hex>`, `mime_type`, `width`, `height`, `size_bytes`, `metadata.dalle.gen_id`를 가집니다.
  대화 id는 전송 후 URL `/c/<id>`에서 얻습니다. 찾는 코드는 `lib/chatgpt-web-image.mjs`의 `findGeneratedImages`입니다.
- **파일 다운로드**: 메타 응답 `{status: "success", download_url, file_size_bytes, …}`. `download_url`은 `https://chatgpt.com/backend-api/estuary/content?id=…&sig=…` 형태이며 `image/png` 바이트를 줍니다.
- **한도 조회**: 요청 본문은 `{conversation_id: null, conversation_origin: null, gizmo_id: null, requested_default_model: null, system_hints: null, timezone: "Asia/Seoul", timezone_offset_min: -540}`.
  응답의 `limits_progress`에서 `feature_name: "image_gen"` 항목(`remaining`, `reset_after`)을 씁니다. 관찰값: 남은 1000 (2026-10-29 기준).

### 캡처와 실제 호출의 차이 (검증 필요)

- 캡처의 조회 호출에는 쿼리 `num_turns`, `include_has_versions`가 있었지만 값은 기록되지 않았습니다. 레지스트리와 스크립트는 쿼리 없이 호출합니다. 실기기 실행에서 응답에 메시지가 들어 있는지 확인해야 합니다.
- 파일 다운로드 캡처에는 `download_intent`, `include_library_file_state`도 있었습니다. 레지스트리에는 `conversation_id`, `inline`만 둡니다.
- 두 항목 모두 값이 기록되지 않아 추측하지 않았습니다.

## 왜 전송만 UI인가

전송 호출에는 세 가지 서버 검증이 필요합니다.

1. `POST /backend-api/sentinel/chat-requirements/prepare` (본문 `{p}`)가 `prepare_token`, `turnstile`, `proofofwork`, `so: {required: true, collector_dx, snapshot_dx}`를 돌려줍니다. 이후 `finalize`가 `token`을 줍니다 (`expire_after: 540`).
2. `POST /backend-api/f/conversation/prepare`가 `conduit_token`을 줍니다.
3. 전송 헤더에는 `OpenAI-Sentinel-Chat-Requirements-Token`, `OpenAI-Sentinel-Proof-Token`, `OpenAI-Sentinel-Turnstile-Token`, `x-conduit-token`, `OAI-Device-Id`, `Authorization`이 필요합니다.

즉 작업 증명(proof-of-work), Cloudflare Turnstile 챌린지 토큰, 브라우저 텔레메트리 수집기(collector/snapshot)를 풀어야 합니다.
이것은 봇 검사 우회에 해당하므로 재생하지 않습니다. 이 저장소의 [anti-bot 경계](anti-bot-boundaries.md)와 SOURCE_README의 "challenge, CAPTCHA, token-solving 흐름 금지" 규칙이 적용됩니다.
따라서 전송은 실제 브라우저 UI에서 클릭과 입력으로 수행하고, 토큰은 브라우저가 스스로 만들도록 둡니다. 전송 본문 형태는 문서용으로만 기록합니다.
읽기 계약 3개는 이 보호 장치를 요구하지 않으며, 페이지의 세션 토큰을 페이지 안에서만 사용합니다.

## 사용 예 추가

```sh
# 남은 이미지 한도 (아무것도 보내지 않음)
node scripts/chatgpt-image.mjs --quota
```

출력 예: `{"imageGen":{"remaining":1000,"resetAfter":"…"}}`.
이미지 결과 JSON에는 `fileId`(끝 6자리만), `width`, `height`, `sizeBytes`, `via`(`contract` 또는 `dom`)가 추가됩니다.
`via: "dom"`은 조회 계약이 30초 동안 결과를 못 찾았을 때 쓰는 대체 경로입니다.

## 실측 확인 (2026-10-29, 폰 Chrome 155)

- `--probe`: 로그인·입력창 확인 OK. `--quota`: `image_gen` remaining 1000, 매일 00:00 UTC 초기화.
- 기존 대화 2건에서 `conversations/{id}` → `findGeneratedImages` → `files/download` → `download_url` 원본 수신. 크기가 화면 blob과 바이트 단위로 일치(2,045,620 / 1,042,248 bytes). 쿼리 없이 호출해도 `messages`가 옴.
- 전체 실행 1회: 화면 전송 → 계약 폴링 → 다운로드, `via:"contract"`, 1254×1254 PNG 1,068,288 bytes, 약 70초.
