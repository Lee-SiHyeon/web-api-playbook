# 봇 차단 경계: 감지하고 멈춘다

확인일: 2026-10-14. 해외 몰은 Akamai Bot Manager, HUMAN(PerimeterX), Cloudflare, DataDome, Alibaba baxia/x5sec 같은 차단 계층을 쓴다. 이 저장소의 원칙은 **차단을 감지하면 기록하고 그 실행을 끝낸다**이다. 우회·풀이·위조는 범위 밖이다.

헬퍼: `lib/commerce/backoff.mjs`의 `classifyResponse` / `CHALLENGE_MARKERS`.

## 금지 (예외 없음)

- CAPTCHA·슬라이더·reCAPTCHA·hCaptcha·Turnstile를 풀거나 외부 풀이 서비스에 넘기기
- TLS/JA3·캔버스·WebGL 지문 위조, 헤드리스 탐지 회피 팩
- 차단 이후 주거용(residential)·모바일 프록시로 IP를 바꿔 재시도하기 ([region-egress-proxy.md](region-egress-proxy.md))
- AliExpress mtop `sign`, `x5sec`/punish 쿠키, Temu anti-content, Akamai sensor, PerimeterX·DataDome 쿠키를 역공학하거나 재현하기
- 캡처한 불투명 브라우저 입력을 엔진 없는 고정 계약처럼 재생하기

기존 CPS 증거 규칙과 같다. HTTP 403/418/429, 확인된 챌린지, origin 이탈 리다이렉트는 리더를 멈춘다.

## 허용

- `classifyResponse`로 분류하고 벤더·이유를 영수증에 남긴다 (쿠키·토큰·전체 HTML 비밀 제외).
- 해당 체크리스트 capability를 `blocked`로 두고 사유를 적는다.
- [공식 API 우선](overseas-official-api-first.md) 경로로 전환한다.

## 감지 마커 (비완전, 휴리스틱)

| 벤더 | 신호 예 |
|---|---|
| Cloudflare | `cf-chl-*`, `challenges.cloudflare.com`, `Just a moment...` |
| Akamai | `_abck`, `bm_sz`, `ak_bmsc`, `Reference #…` |
| PerimeterX / HUMAN | `_px*`, `px-captcha`, `perimeterx` |
| DataDome | `datadome`, `captcha-delivery.com` |
| AliExpress | `x5sec`, `/punish?`, `_____tmd_____`, baxia |
| reCAPTCHA / hCaptcha | `google.com/recaptcha`, `hcaptcha.com` |
| Amazon | `/errors/validateCaptcha` |

거짓 음성은 403/418/451에서 여전히 멈춘다. 상품 본문에 문자열이 겹쳐 멈추는 거짓 양성은 허용하며, 허용 목록을 넓히려면 날짜가 찍힌 라이브 영수증이 필요하다.

## 상태 코드

| 상태 | 동작 |
|---|---|
| 401 | 중단 — 인증 거부. 허용된 갱신 경로를 한 번만 시도한 뒤 `reauth_required` ([session-refresh-sanctioned.md](session-refresh-sanctioned.md)) |
| 403 / 418 / 451 | 중단 — 공식 API 오류 스키마로 달리 확인되지 않으면 챌린지/권한으로 본다 |
| 429 / 502 / 503 / 504 | 제한된 백오프로 재시도 ([rate-limit-backoff.md](rate-limit-backoff.md)) |
| 200이지만 챌린지 본문 | 중단 — 카탈로그 JSON으로 파싱하지 않는다 |

## 영수증 최소 필드

```json
{
  "schema": "web-api-challenge-stop-v1",
  "origin": "https://example.com",
  "path": "/search",
  "httpStatus": 403,
  "vendor": "cloudflare",
  "reason": "challenge_detected",
  "browserUsed": false,
  "observedAt": "2026-10-14T00:00:00.000Z"
}
```

쿠키 값, `x5secdata`, sensor payload, Authorization 헤더는 영수증에 넣지 않는다.
