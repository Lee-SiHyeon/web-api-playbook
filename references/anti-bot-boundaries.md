# 봇 차단 감지

확인일: 2026-10-14. 해외 몰은 Akamai Bot Manager, HUMAN(PerimeterX), Cloudflare, DataDome, Alibaba baxia/x5sec 같은 차단 계층을 쓴다. 이 문서는 차단 페이지를 알아보는 신호와 기록 형식을 정리한다.

헬퍼: `lib/commerce/backoff.mjs`의 `classifyResponse` / `CHALLENGE_MARKERS`.

기존 CPS 증거 규칙과 같다. HTTP 403/418/429, 확인된 챌린지, origin 이탈 리다이렉트는 리더를 멈춘다.

## 기록

- `classifyResponse`로 분류하고 벤더·이유를 영수증에 남긴다 (쿠키·토큰·전체 HTML 비밀 제외).
- 해당 체크리스트 capability를 `blocked`로 두고 사유를 적는다.
- [공식 API 우선](overseas-official-api-first.md) 경로가 있으면 함께 검토한다.

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
