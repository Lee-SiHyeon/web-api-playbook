import { createHash } from 'node:crypto';
import { loadWebAuth } from '../../../affiliate-api-hub/adapters/web-auth-provider.mjs';
import { loadXSession } from '../../scripts/session-vault.mjs';
import { createXClient, decodeXTimeline } from './x-xhr.mjs';

// Prefer the existing scoped DPAPI provider. A rejected session never becomes an
// anonymous retry. Returning null means that no stored provider was available.
export async function fetchXPost(input, { fetchImpl = globalThis.fetch, provider, session, createClient = createXClient } = {}) {
  async function read(credentials, http) {
    const client = await createClient({ fetchImpl: http, session: credentials });
    try {
      await client.profile(input.handle); // Exact author and explicitly public profile.
      const detail = await client.detail(input.id);
      const item = decodeXTimeline(detail.instructions, input.handle).items.find(row => row.id === input.id);
      if (!item || !item.publishedAt) throw Object.assign(new Error('X_EXACT_POST_UNAVAILABLE'), { code: 'X_EXACT_POST_UNAVAILABLE' });
      const { text, ...publicItem } = item;
      const receipt = detail.receipt;
      return { status: 'collected', items: [{ ...publicItem,
        bodySha256: createHash('sha256').update(text).digest('hex'), bodyLength: text.length,
        bodyTruncated: text.length > 1500, contentCoverage: 'full_text', sourceKind: 'public_social_post',
        publishedAtText: item.publishedAt, publishedAtPrecision: 'second', evidenceLevel: 'graphql_json' }],
      receipt: { sourceUrl: item.url, collectionMethod: 'authenticated_graphql',
        httpStatus: receipt.httpStatus, httpStatuses: client.receipts.map(row => row.httpStatus),
        responseSha256: receipt.sha256, responseBytes: receipt.bytes, observedItems: 1,
        responseBodyRead: true, postContentValidated: true, readerReturnedContent: true,
        browserUsed: false, credentialsUsed: true, credentialProvider: 'windows_dpapi_current_user',
        executionMode: 'pure_http', liveReplay: true, contentCoverage: 'full_text',
        contractEvidence: receipt.contractEvidence } };
    } finally { client.close(); }
  }
  if (session) return read(session, fetchImpl);
  if (provider === undefined && fetchImpl === globalThis.fetch) {
    try { provider = await loadWebAuth('x'); }
    catch (error) { if (error.message !== 'WEB_AUTH_PLAYBOOK_NOT_INSTALLED') throw error; }
  }
  if (provider?.status().sessionStored) return provider.withSession(credentials => read(credentials, credentials.fetchImpl));
  if (fetchImpl === globalThis.fetch) {
    const stored = await loadXSession();
    if (stored) return read(stored, fetchImpl);
  }
  return null;
}
