// CUA CDP adapter. No browser launch, UI clicks, signing emulation or HTTP publication.
// Import this module into the active cua_repl runtime and pass its documented tab capability.
const ORIGIN = 'https://www.tiktok.com';
const OWNER = 'lifehack__aibal';
const POST = '/tiktok/web/project/post/v1/';
const OWNER_LIST = '/tiktok/creator/manage/item_list/v1/';
const AUTH = '/api/v1/video/upload/auth/';
const BLOCKED_PATHS = [POST, '/tiktok/post/edit/v1/', '/api/v1/draft/create_update/',
  '/tiktok_creator/editor_tool/api/v1/post_draft/editor_save', '/tiktok_creator/editor_tool/api/v1/post_draft/save',
  '/api/v1/web/project/create/', '/api/v1/web/project/update/config/'];
const METHODS = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const POST_HEADERS = new Set(['accept', 'content-type', 'origin', 'referer', 'user-agent',
  'tt-ticket-guard-client-data', 'tt-ticket-guard-iteration-version', 'tt-ticket-guard-public-key',
  'tt-ticket-guard-version', 'tt-ticket-guard-web-version']);
const READ_HEADERS = new Set(['accept', 'content-type', 'origin', 'referer', 'user-agent',
  'agw-js-conv', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'tt-csrf-token']);

function scopedPath(value) {
  try { const url = new URL(value); return url.origin === ORIGIN ? url.pathname : null; } catch { return null; }
}

export class TikTokCapture {
  constructor(cdp) {
    this.cdp = cdp;
    this.requests = new Map();
    this.responses = new Map();
    this.failures = new Map();
    this.proven = false;
    this.closed = false;
  }

  async start({ blockWrites = true } = {}) {
    if (this.cursor !== undefined || this.closed) fail('TIKTOK_CAPTURE_ALREADY_STARTED');
    await this.cdp.send('Network.enable', {});
    if (blockWrites) await this.cdp.send('Network.setBlockedURLs', { urls: BLOCKED_PATHS.map(p => ORIGIN + p + '*') });
    this.cursor = (await this.cdp.readEvents({ methods: METHODS, limit: 1000 })).cursor;
    if (blockWrites) {
      // Read-only GET, omitted credentials. It must be cancelled locally before leaving Chrome.
      await this.cdp.send('Runtime.evaluate', { expression:
        "fetch('/tiktok/web/project/post/v1/',{method:'GET',credentials:'omit'}).then(()=>false,()=>true)",
      awaitPromise: true, returnByValue: true });
      await this.poll();
      this.proven = [...this.requests].some(([id, e]) => e.request.method === 'GET'
        && scopedPath(e.request.url) === POST && this.failures.get(id)?.blockedReason === 'inspector'
        && !this.responses.has(id));
      if (!this.proven) fail('TIKTOK_WRITE_BLOCK_NOT_PROVEN');
    }
    return { ready: true, writesBlocked: this.proven };
  }

  async poll({ timeoutMs = 0 } = {}) {
    if (this.closed) fail('TIKTOK_CAPTURE_CLOSED');
    for (let page = 0; page < 32; page++) {
      const result = await this.cdp.readEvents({ afterSequence: this.cursor, methods: METHODS, limit: 1000, timeoutMs });
      this.cursor = result.cursor;
      if (result.truncated) fail('TIKTOK_CAPTURE_TRUNCATED');
      for (const event of result.events) {
        const p = event.params;
        if (event.method === 'Network.requestWillBeSent' && [POST, OWNER_LIST, AUTH].includes(scopedPath(p?.request?.url))) {
          this.requests.set(p.requestId, p);
          for (const [key, value] of Object.entries(p.request.headers || {})) if (key.toLowerCase() === 'user-agent') this.userAgent = value;
        } else if (event.method === 'Network.responseReceived' && this.requests.has(p?.requestId)) {
          this.responses.set(p.requestId, p.response);
        } else if (event.method === 'Network.loadingFailed' && this.requests.has(p?.requestId)) {
          this.failures.set(p.requestId, p);
        }
      }
      if (!result.hasMore) return { relevantRequests: this.requests.size, writeBlockProven: this.proven };
      timeoutMs = 0;
    }
    fail('TIKTOK_CAPTURE_OVERFLOW');
  }

  envelope(kind = 'post') {
    const path = kind === 'post' ? POST : kind === 'owner-list' ? OWNER_LIST : null;
    if (!path) fail('TIKTOK_CAPTURE_KIND_INVALID');
    const candidates = [...this.requests.values()].filter(e => e.request.method === 'POST' && scopedPath(e.request.url) === path);
    const entry = candidates.at(-1);
    if (!entry) fail('TIKTOK_CAPTURE_REQUEST_MISSING');
    const age = Date.now() - entry.wallTime * 1000;
    if (!Number.isFinite(age) || age < -5000 || age > 120000) fail('TIKTOK_CAPTURE_STALE');
    const response = this.responses.get(entry.requestId);
    const failure = this.failures.get(entry.requestId);
    if (kind === 'post' && (!this.proven || response || failure?.blockedReason !== 'inspector'
      || candidates.some(e => this.responses.has(e.requestId) || this.failures.get(e.requestId)?.blockedReason !== 'inspector'))) fail('TIKTOK_BROWSER_WRITE_NOT_BLOCKED');
    if (kind === 'owner-list' && response?.status !== 200) fail('TIKTOK_OWNER_READ_RESPONSE_MISSING');
    const allowed = kind === 'post' ? POST_HEADERS : READ_HEADERS;
    const headers = {};
    for (const [rawName, value] of Object.entries(entry.request.headers || {})) {
      const name = rawName.toLowerCase();
      if (allowed.has(name)) headers[name] = value;
    }
    // Origin is implicit in Chrome's observed same-origin request; never fabricate a UA.
    headers.origin = ORIGIN;
    if (!headers['user-agent'] && this.userAgent) headers['user-agent'] = this.userAgent;
    if (!headers['user-agent']) fail('TIKTOK_OBSERVED_USER_AGENT_MISSING');
    return { version: 1, ownerHandle: OWNER, origin: ORIGIN,
      observedAt: new Date(entry.wallTime * 1000).toISOString(), helperClosed: this.closed,
      ...(kind === 'post' ? { browserWriteBlocked: true, blockedReason: 'inspector', responseReceived: false }
        : { responseStatus: response.status }),
      request: { method: 'POST', url: entry.request.url, headers, body: entry.request.postData } };
  }

  async closeAndSeal(tab, browser, kind = 'post') {
    await this.poll();
    const result = this.envelope(kind);
    await tab.close();
    if ((await browser.tabs.list()).some(t => String(t.id) === String(tab.id))) fail('TIKTOK_HELPER_NOT_CLOSED');
    this.closed = true;
    result.helperClosed = true;
    this.clear();
    return result; // Contains credentials. Pass only through stdin to the DPAPI handoff, never print.
  }

  clear() {
    this.requests.clear(); this.responses.clear(); this.failures.clear(); this.userAgent = undefined;
  }
}
