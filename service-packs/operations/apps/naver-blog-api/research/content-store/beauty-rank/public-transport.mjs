import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const CAPTURE_DIR = 'C:/Users/User/AppData/Local/Temp/beauty-rank-captures';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function challengeSignals(body) {
  return ['cf-chl-', 'challenge-platform', 'Just a moment...', 'verify you are human', 'Access Denied', 'unusual traffic', '/sorry/', '자동입력 방지', '로봇이 아닙니다'].filter(s => body.toLowerCase().includes(s.toLowerCase()));
}

/** Anonymous, GET-only transport. No cookie jar, auth headers or credential provider. */
export function createPublicTransport({ source, hosts, captureDir = CAPTURE_DIR, budget = 40, intervalMs = 2100 } = {}) {
  if (!source || !hosts?.length) throw new Error('source and explicit hosts required');
  const last = new Map(), blocked = new Set(), receipts = [];
  let count = 0;
  async function get(input, label = 'document') {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password) throw new Error('PUBLIC_ORIGIN_NOT_ALLOWED');
    if (blocked.has(url.hostname)) throw new Error('CHALLENGE_BLOCKED_STOP');
    if (count >= budget) throw new Error('SOURCE_REQUEST_BUDGET_EXHAUSTED');
    await delay(Math.max(0, (last.get(url.hostname) ?? 0) + intervalMs - Date.now()));
    last.set(url.hostname, Date.now()); count++;
    const capturedAt = new Date().toISOString();
    let response;
    try {
      response = await fetch(url, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      const receipt = { source, requestNumber: count, url: url.href, method: 'GET', capturedAt, verdict: 'transport_failed', error: error.cause?.code ?? error.name };
      receipts.push(receipt); return { ...receipt, body: '' };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
    let body;
    try { body = new TextDecoder(charset).decode(bytes); } catch { body = new TextDecoder('utf-8').decode(bytes); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '-');
    const rawPath = join(captureDir, `${source}-${String(count).padStart(2, '0')}-${safeLabel}-${sha256.slice(0, 12)}.${contentType.includes('json') ? 'json' : 'html'}`);
    await mkdir(captureDir, { recursive: true });
    await writeFile(rawPath, bytes);
    const signals = challengeSignals(body);
    const verdict = signals.length ? 'challenge_blocked' : response.status >= 400 ? 'http_rejected' : response.status >= 300 ? 'redirect_observed' : 'received';
    if (signals.length || [403, 418, 429].includes(response.status)) blocked.add(url.hostname);
    const receipt = { source, requestNumber: count, url: url.href, method: 'GET', requestHeaderNames: ['accept'], status: response.status, contentType, charset, capturedAt, bytes: bytes.length, sha256, rawPath, verdict, challengeSignals: signals };
    // Record only the redirect URL, never response headers/cookies.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirect = new URL(location, url);
        receipt.redirectUrl = redirect.origin + redirect.pathname;
        receipt.redirectQueryKeys = [...redirect.searchParams.keys()];
      }
    }
    receipts.push(receipt);
    return { ...receipt, body };
  }
  return { get, receipts, get count() { return count; } };
}
