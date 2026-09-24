import { ApiError } from '../../scripts/client.mjs';
import { HeadlessAuth } from './headless-auth.mjs';
import { ADMIN_ROOT, PUBLIC_ROOT, resourceId, metadata, classifyRead, discoverHTML, scanSource, fetchDocument } from './editor-contracts.mjs';

// Single lifecycle: normal login -> independently verified memory handoff ->
// browser shutdown -> existing HTTP contracts. No background process or disk auth.
export class ApiWorkflow {
  #session = null;
  #auth;
  #fetchImpl;
  #observed = new Map();
  #bodies = new Map();
  #receipts = [];
  #sourceScans = [];
  #verification = null;
  #browserWarmup = null;
  #state = 'not_started';
  #attemptedOperations = 0;
  constructor({ auth = new HeadlessAuth(), fetchImpl = globalThis.fetch } = {}) {
    this.#auth = auth; this.#fetchImpl = fetchImpl;
    for (const url of [ADMIN_ROOT, PUBLIC_ROOT]) this.#observed.set(resourceId(url), { id: resourceId(url), url, kind: 'link' });
  }
  async prepare() {
    if (this.#session) return this.status();
    return this.#auth.open();
  }
  async login(credentials) {
    if (this.#session) throw new ApiError('ALREADY_AUTHENTICATED', 'Use the existing HTTP session');
    const result = await this.#auth.login(credentials);
    this.#state = result.classification || result.stage;
    if (result.classification !== 'session_issued_unverified') return result;
    return this.enableHTTP();
  }
  async enableHTTP() {
    if (this.#session) return this.status();
    try {
      const { session, verification, warmupEvidence = null } = await this.#auth.handoffHTTP({ fetchImpl: this.#fetchImpl });
      this.#session = session; this.#verification = verification; this.#browserWarmup = warmupEvidence; this.#state = 'http_ready';
      return { ...this.status(), verification, warmupEvidence };
    } catch (error) {
      this.#state = 'handoff_failed';
      throw error;
    }
  }
  #requireSession() {
    if (!this.#session || this.#state !== 'http_ready') throw new ApiError('AUTH_MISSING', 'A verified HTTP session is required');
    return this.#session;
  }
  #blockAuthentication() {
    this.#session?.clear(); this.#session = null; this.#bodies.clear();
    this.#state = 'blocked_auth_or_permission';
  }
  async api(input) {
    const session = this.#requireSession();
    this.#consumeOperation();
    try {
      const { evidence } = await session.api(input);
      const receipt = { ...evidence, source: 'independent_HTTP', browserUsedForRequest: false };
      this.#receipts.push(receipt);
      return receipt;
    } catch (error) {
      if (['AUTH_MISSING', 'AUTH', 'FORBIDDEN', 'REDIRECT', 'MIME'].includes(error.code)
        || (error.code === 'APPLICATION' && [401, 403].includes(error.details?.applicationStatus))) this.#blockAuthentication();
      throw error;
    }
  }
  observeRead({ url, kind = 'link' } = {}) {
    this.#requireSession();
    if (typeof url !== 'string' || !url || !['link', 'frame', 'script'].includes(kind)) {
      throw new ApiError('INPUT', 'Supply one classified read URL and kind');
    }
    const classification = classifyRead(url, kind);
    if (!classification) throw new ApiError('UNREVIEWED', 'The URL is not an approved read document');
    const id = resourceId(new URL(url).href);
    const entry = { id, url: new URL(url).href, kind, classification };
    if (!this.#observed.has(id) && this.#observed.size >= 2000) {
      throw new ApiError('BUDGET', 'Observed-document budget reached; frontier is retained');
    }
    this.#observed.set(id, entry);
    return { ...metadata(entry.url), kind, classification };
  }
  async inspect({ id = resourceId(ADMIN_ROOT) } = {}) {
    const session = this.#requireSession();
    const target = this.#observed.get(id);
    if (!target) throw new ApiError('UNOBSERVED', 'Choose a previously observed read document by id');
    this.#consumeOperation();
    let result;
    try {
      result = await fetchDocument(target.url, { kind: target.kind, session,
        fetchImpl: target.kind === 'script' ? this.#fetchImpl : session.fetch.bind(session) });
    } catch (error) {
      if (error.code === 'AUTH_MISSING') this.#blockAuthentication();
      throw error;
    }
    const { receipt, body } = result;
    this.#receipts.push(receipt);
    if (body === null) {
      if (target.kind !== 'script' && ['blocked_auth', 'blocked_auth_or_permission', 'blocked_redirect'].includes(receipt.state)) this.#blockAuthentication();
      return receipt;
    }
    // Retain bounded source text in RAM only; evicted pages stay in the frontier.
    this.#bodies.delete(id); this.#bodies.set(id, body);
    while ([...this.#bodies.values()].reduce((n, text) => n + Buffer.byteLength(text), 0) > 24 * 1024 * 1024) {
      this.#bodies.delete(this.#bodies.keys().next().value);
    }
    if (receipt.mime !== 'text/html') return receipt;
    const discovery = discoverHTML(body, target.url);
    for (const entry of discovery.executable) {
      if (!this.#observed.has(entry.id) && this.#observed.size >= 2000) throw new ApiError('BUDGET', 'Observed-document budget reached; frontier is retained');
      this.#observed.set(entry.id, entry);
    }
    return { ...receipt, links: discovery.links, formFieldNames: discovery.formFieldNames };
  }
  scan({ id, terms } = {}) {
    this.#requireSession();
    if (this.#sourceScans.length >= 100) throw new ApiError('BUDGET', 'Source scan budget reached');
    if (!this.#bodies.has(id)) throw new ApiError('UNOBSERVED', 'Inspect a document before scanning its source');
    const result = scanSource(this.#bodies.get(id), this.#observed.get(id).url, terms);
    this.#sourceScans.push(result);
    return result; // Source strings are not promoted to executable requests.
  }
  frontier() {
    return [...this.#observed.values()].map(entry => ({ ...metadata(entry.url), kind: entry.kind, sourceInMemory: this.#bodies.has(entry.id) }));
  }
  evidence() {
    return structuredClone({ verification: this.#verification, browserWarmup: this.#browserWarmup,
      receipts: this.#receipts, sourceScans: this.#sourceScans,
      browserUsedForAPI: false, writeRequests: 0, credentialsPersisted: false, ...this.status() });
  }
  status() {
    return { state: this.#state, authenticatedHTTP: this.#state === 'http_ready',
      sessionInMemory: Boolean(this.#session), browserOpen: Boolean(this.#auth.browser),
      apiOnly: Boolean(this.#session) && !this.#auth.browser, httpReceipts: this.#receipts.length,
      observedDocuments: this.#observed.size, attemptedOperations: this.#attemptedOperations, writeRequests: 0 };
  }
  #consumeOperation() {
    if (this.#attemptedOperations >= 100) throw new ApiError('BUDGET', 'This lifecycle has reached its bounded operation budget');
    this.#attemptedOperations++;
  }
  authStatus() { return this.#auth.status(); }
  verifyHTTP() { return this.enableHTTP(); }
  closeBrowser() { return this.#auth.closeBrowser(); }
  async close() {
    this.#session?.clear(); this.#session = null; this.#bodies.clear();
    this.#browserWarmup = null; await this.#auth.close(); this.#state = 'closed';
    return { browserClosed: true, sessionCleared: true };
  }
}
