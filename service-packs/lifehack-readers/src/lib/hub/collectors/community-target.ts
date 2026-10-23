// Merchant product link inside a community deal post (owner 2026-10-11: "커뮤에서 나온 인기상품들도 파트너스 링크 걸수있는거면
// 걸어라"). 뽐뿌 wraps the shared shop link as https://s.ppomppu.co.kr?idno=…&target=<base64 url>&encode=on; we decode it
// so the PC linker can attach our own partner link for the SAME product (쿠팡 파트너스, 브랜드 커넥트, 링크프라이스).

/** Decoded https merchant URL from a 뽐뿌 post page, or null. */
export function ppomppuTargetUrl(html: string): string | null {
  for (const m of html.matchAll(/s\.ppomppu\.co\.kr\/?\?[^"'\s>]*?target=([A-Za-z0-9+/=_-]+)/g)) {
    try {
      const raw = Buffer.from(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
      const url = new URL(raw);
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol !== 'https:' || /(^|\.)ppomppu\.co\.kr$/.test(url.hostname)) continue;
      return url.href;
    } catch {
      // not a URL; try the next link
    }
  }
  return null;
}

/** Last failure seen by fetchPpomppuTarget (HTTP status or error name), for the collector run log. */
export let lastPpomppuTargetFailure: string | null = null;

/** Fetch a post page (charset-aware: 뽐뿌 is EUC-KR) and return its decoded merchant link. */
export async function fetchPpomppuTarget(postUrl: string, fetchImpl: typeof fetch, userAgent: string): Promise<string | null> {
  try {
    const res = await fetchImpl(postUrl, { headers: { 'User-Agent': userAgent, 'Accept-Language': 'ko-KR' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) { lastPpomppuTargetFailure = `HTTP ${res.status}`; return null; }
    const buf = await res.arrayBuffer();
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
    const charset = (res.headers.get('content-type') ?? '').match(/charset=([\w-]+)/i)?.[1] ?? head.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
    let html: string;
    try { html = new TextDecoder(charset).decode(buf); } catch { html = new TextDecoder('utf-8').decode(buf); }
    const found = ppomppuTargetUrl(html);
    if (!found) lastPpomppuTargetFailure = `no target link (${html.length} chars)`;
    return found;
  } catch (error) {
    lastPpomppuTargetFailure = error instanceof Error ? error.name + ': ' + error.message.slice(0, 80) : 'fetch error';
    return null;
  }
}
