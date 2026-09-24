export class TrendSourceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'TrendSourceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function retryDelay(response, attempt) {
  const raw = response?.headers?.get?.('retry-after');
  const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  if (seconds !== null) return Math.min(seconds * 1000, 5000);
  return Math.min(300 * 2 ** attempt, 2000);
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function fetchText(url, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 15000,
  attempts = 2,
  fetchImpl = globalThis.fetch,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      return { response, text };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
    }
  }
  throw new TrendSourceError('TRANSPORT', 'Trend source request failed after bounded retries', {
    cause: String(lastError?.name || 'unknown').slice(0, 80),
  });
}

export function assertStatus(response, expected = 200) {
  if (response.status !== expected) {
    throw new TrendSourceError('HTTP_STATUS', `Trend source returned HTTP ${response.status}`, {
      httpStatus: response.status,
    });
  }
}
