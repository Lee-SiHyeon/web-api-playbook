# Google Flow Music (Lyria 3.5) 사용법·요금·약관 관측 — 2026-10-20

대상: https://www.flowmusic.app/ (Google Flow Music, Lyria 3.5 음악 모델, Veo 뮤직비디오)
계정: shyeon0528@gmail.com (Google 로그인 완료, 요금제는 FREE 유지)

## 1. 로그인·동의 흐름

- 쿠키 배너 "동의함" → "Log in" → "Continue with Google" → Google 계정 선택 → OAuth 동의 화면.
- OAuth 동의: 기본 프로필/이메일만 허용. "Google One 멤버십 및 혜택" 범위는 선택 항목이라 체크하지 않음.
- 앱 진입 후 "Privacy Notice" 모달이 뜨며 "Agree"가 필수 (비동의 시 "Log out"만 가능).
- 상단 배너 "Grant access to your Google One subscription..." 는 클릭하지 않음.

## 2. 요금제·크레딧 (앱 /pricing 페이지 원문 기준)

| 플랜 | 월 요금 | 크레딧 | 동시 생성 |
|---|---|---|---|
| Free | $0 | 일일 top-up 크레딧 (양은 표시되지 않음) | 2 |
| Starter | $6 (연간 25% 할인 표기) | 3,000 Credits/월 (~600곡) + 일일 top-up | 8 |
| Plus | $18 | 10,000 Credits/월 (~2,000곡) + 일일 top-up | 12 |
| Member | $48 | 30,000 Credits/월 (~6,000곡) + 일일 top-up | 16 |

- "Need more? Get Credits" — "Only available on paid plans while your subscription is active." (추가 크레딧 구매는 유료 플랜 전용. 결제 미진행.)
- 곡당 크레딧 소모: 표기 환산 기준 약 5 크레딧/곡 (3,000 ÷ 600, 파생 계산. 공식 단가 표기 아님).
- 플랜 기능 행 (표): Lyria Models, Producer, Projects, Downloads (mp3, wav, m4a), Stem downloads, Publishing, Image and Video generation, Progress, Member access 등.
- 테스트 시점 잔액: 생성 전에는 잔액 숫자가 보이지 않았고, 1곡 생성 후 하단 다이아 아이콘 옆에 `0`이 표시됨. 즉 무료 범위의 일일 크레딧을 소진한 상태. 추가 생성은 유료 전환 필요로 판단하고 중단.

## 3. 생성 모드·UI

- 시작 화면: "New session" → Producer 채팅 ("Ask Producer...") + 스타터 3종 (Brainstorm lyrics / Create a song together / Remix my music).
- Compose 패널 (우측, 아이콘 "Toggle compose panel"):
  - Lyrics: 가사 입력 + `Instrumental` 토글 (켜면 가사 없음, 보컬 없음).
  - Sound: 스타일/악기/분위기 설명 텍스트 + `Advanced` 토글.
  - Details: 제목(선택), 이미지 업로드/프롬프트 이미지.
  - Generate 버튼.
- 길이·BPM·장르를 별도 필드로 지정하는 UI는 Compose에서 확인되지 않음. 자연어 프롬프트에 포함하는 방식.
- 트랙 "More options" 메뉴: Remix, Details, Download, Share..., Add to..., Split stems, Report, Delete.
- Download 하위 메뉴: Download video, Get stems, M4A, MP3, WAV.
- 테스트 결과: 프롬프트에 "60 seconds"를 넣었으나 실제 길이는 66.56초 (ffprobe 기준, UI 표시 1:07). 정확히 60초로 떨어지지 않음 — 루프용으로 쓰려면 후편집 필요.

## 4. 테스트 곡

- 프롬프트: "Bright upbeat lo-fi acoustic travel vlog background music, Paris summer morning, light accordion and acoustic guitar, no vocals, 60 seconds, loopable" (Instrumental ON, 가사 없음)
- 다운로드: Download → MP3 (브라우저 다운로드, 탭 세션 쿠키 사용)
- 저장: `G:\내 드라이브\shorts-factory\kwak-paris\longform\bgm\flowmusic-lyria-paris-lofi-test-60s.mp3`
- ffprobe: format mp3, duration 66.56 s, size 1,337,526 bytes, audio mp3 48 kHz stereo 128 kbps (format bit_rate 160,760), 커버용 mjpeg 스트림 1개 포함.

## 5. 약관·상업적 이용 관련 원문/관측

원문 인용 (앱 내 Privacy Notice, EN, /pricing 및 세션 화면 공통):
- "By default, Google stores your generated outputs, including songs, videos and Spaces, until you delete them."
- "Google uses this data, consistent with our Privacy Policy, to provide, improve, and develop Google products and services and machine learning technologies."
- "To help with quality and improve our products, human reviewers read, annotate, and process a sample of your data."
- "Some Google Flow Music subscription tiers require payment. Google Flow Music is available as a Google AI plan benefit as well as through Google Flow Music only subscriptions."

Google 일반 약관 (policies.google.com/terms) — WebFetch 경유 요약이므로 원문 대조 필요:
- Google "won't claim ownership over that content" (생성 콘텐츠 소유권은 Google에 없다는 취지).
- "Your content remains yours," 사용자 IP 권리 유지.
- Google에 부여되는 라이선스는 "worldwide," "non-exclusive," "royalty-free", 서비스 운영·개선 목적.

Generative AI 사용 정책 (policies.google.com/terms/generative-ai/use-policy):
- 권리 침해 금지: "Violates the rights of others, including privacy and intellectual property rights."
- 생성물 출처 허위 표기 금지: "Misrepresenting the provenance of generated content by claiming it was created solely by a human, in order to deceive."

상업적 이용·YouTube 수익화·Content ID:
- 확인한 앱 내 페이지(Privacy Notice, /pricing, 세션 화면) 어디에도 "commercial", "YouTube", "Content ID", "monetization", "license" 관련 명시 문구는 찾지 못함.
- 앱의 FAQ/약관 페이지(/faq, /terms 등)는 SPA 라우팅으로 홈으로 리다이렉트되어 접근 불가.
- 2차 자료 (third-party blog, 신뢰도 낮음): 유료 플랜(Starter/Plus/Member)에 상업적 이용 권리가 명시된다는 주장, 무료 플랜은 불명확하다는 주장. 공식 원문 아님.
- 결론: 무료 플랜 생성곡의 상업적 이용 가능 여부는 공식 문구로 확인하지 못함. 유튜브 수익화/Content ID 등록에 쓰기 전에 Google Flow Music의 공식 Terms·Help 페이지를 직접 확인 필요.
- 참고: Google Privacy Notice는 생성물을 기본 저장하고, 서비스 개선을 위해 사람 리뷰어가 샘플을 읽을 수 있다고 명시.

## 6. 관측 엔드포인트 (브라우저 네트워크 관측)

네트워크 레코더를 생성 직전에 시작했으나 백그라운드 프로세스가 중단되어 요청 본문/응답 전체는 저장되지 않음. 아래는 탭의 Resource Timing으로 확인한 URL 경로 (요청 본문 필드는 미검증).

Base: `https://www.flowmusic.app`

- `GET /__api/billing/subscription`, `GET /__api/billing/credits` — 플랜·크레딧 조회 (페이지 로드 시 호출)
- `GET /__api/producer/access-granted`, `POST /__api/producer/onboard` — Producer 접근/온보딩
- `GET /__api/conversations`, `GET /__api/messages/{conversationId}/stream?last_id=` — Producer 채팅 스트림
- `POST /__api/producer/tool-call` — Producer가 음악 생성 등 도구를 호출하는 경로로 추정 (미검증)
- `POST /__api/clips` — 곡(clip) 생성으로 추정 (Generate 클릭 후 등장, 본문 필드 미검증)
- `GET /__api/audio-create-song-status/{clipId}` — 생성 진행률 폴링 (테스트 시 0% → 완료까지 반복 호출된 것으로 관측)
- `GET /__api/clips/user/{userId}`, `GET /__api/clips` — 생성곡 목록
- `GET /__api/personalize/level|scores|actions|stats` — 진행도(포인트) 관련
- 결과 미디어: `https://storage.googleapis.com/producer-app-public/assets/{uuid}.jpg|.mp4` (커버/뮤직비디오 자산). 오디오 URL은 DOM에 `<audio>`로 노출되지 않아 특정 못 함.
- 분석: `ph.flowmusic.app` (PostHog 계열), `api.honeycomb.io` 트레이스.

인증: API 호출은 쿠키만으로는 401 (`{"detail":"Unauthorized"}`), 앱이 별도 토큰을 붙이는 것으로 보임. 토큰 값은 기록하지 않음.

## 7. 미완료·주의

- 요청 본문(POST /__api/clips 필드, tool-call 스키마)과 오디오 원본 URL은 이번 세션에서 확정하지 못함.
- 무료 플랜 상업적 이용 조항은 공식 원문 미확인.
- 생성 곡 길이는 프롬프트의 "60 seconds"와 다르게 66.56초로 나옴.
