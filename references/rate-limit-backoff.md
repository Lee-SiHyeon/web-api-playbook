# 요청 간격·백오프·일일 한도

확인일: 2026-10-14. 안전한 **읽기**에만 제한된 재시도를 쓴다. 쓰기·발행·결제에는 쓰지 않는다. 구현: `lib/commerce/backoff.mjs` (`normalizeHeaders`, `parseRetryAfter`, `computeBackoffDelay`, `createRateGate`, `withBoundedRetry`, `classifyResponse`).

## 규칙

1. **챌린지·401·403·418·451은 재시도하지 않는다.** `classifyResponse`가 `stop`이면 즉시 종료 ([anti-bot-boundaries.md](anti-bot-boundaries.md)).
2. **429 / 502 / 503 / 504만** `maxAttempts`(기본 3)까지 재시도한다. 응답 헤더·본문에 챌린지 마커가 있으면 상태와 관계없이 중단한다.
3. **Retry-After**가 있으면 초/HTTP-date를 파싱해 대기 하한으로 쓰고, 그래도 `maxMs`(기본 120s)를 넘기지 않는다. `Headers` 객체와 `Retry-After` 대소문자는 `normalizeHeaders`가 처리한다.
4. 대기는 **full-jitter** 지수 백오프: `random() * min(maxMs, baseMs * 2^attempt)`.
5. origin(또는 계정)마다 **최소 간격**과 **일일 횟수**를 `createRateGate`로 강제한다. **매 실제 HTTP 시도마다** `reserve()`를 호출한다(재시도 포함). 기본 예: `minIntervalMs=5000`, `dailyLimit=500` — 서비스 문서 한도가 있으면 그 값을 쓴다.
6. 한도·챌린지로 멈춘 뒤에는 같은 버스트를 자동으로 다시 돌리지 않는다. Typecast `UNUSUAL_ACTIVITY_DETECTED`처럼 계정 정지로 이어질 수 있다.

## 사용 예

```js
import { createRateGate, withBoundedRetry } from '../lib/commerce/backoff.mjs';

const gate = createRateGate({ minIntervalMs: 10_000, dailyLimit: 200 });

const result = await withBoundedRetry(
  async () => {
    // Reserve inside the callback so every attempt (including retries) is paced.
    for (;;) {
      const slot = gate.reserve();
      if (slot.allowed) break;
      if (slot.reason === 'daily_limit') throw new Error('daily_limit');
      await new Promise((r) => setTimeout(r, slot.waitMs));
    }
    const response = await doSafeGet(); // your GET that returns status/headers/bodySample/value
    return {
      status: response.status,
      headers: response.headers, // Headers or plain object
      bodySample: response.bodySample,
      value: response,
    };
  },
  { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
);
```

## `commerceJsonRequest`와 같이 쓰기

기존 `lib/commerce/http.mjs`의 `commerceJsonRequest`는 429에서 **예외**(`CommerceHttpError`, code `*_THROTTLED`)를 던지고, 성공 시 `{ payload, request }`를 반환한다. 이를 `withBoundedRetry`에 **그대로** 넣으면 `status`가 없어 오분류된다. 감싸려면 어댑터가 필요하다:

```js
async function asRetryable(run) {
  try {
    const { payload, request } = await run();
    return { status: request.httpStatus ?? 200, headers: {}, bodySample: '', value: payload };
  } catch (error) {
    if (error?.name === 'CommerceHttpError') {
      const status = error.receipt?.httpStatus
        ?? (String(error.code).endsWith('_THROTTLED') ? 429 : 0);
      return { status, headers: {}, bodySample: '', value: null };
    }
    throw error;
  }
}
```

HTTP 헬퍼 자체를 조용히 재시도하도록 바꾸지 않는다.

## Amazon / AliExpress 참고

- Creators API rate 개념: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/api-rates (계정·리소스별 한도는 콘솔/오류 본문으로 확인).
- AliExpress Affiliate는 앱 쿼터와 429 응답을 어댑터가 `ALIEXPRESS_AFFILIATE_THROTTLED`로 올린다. 쿼터 숫자는 앱마다 다르며 여기서 고정하지 않는다.
