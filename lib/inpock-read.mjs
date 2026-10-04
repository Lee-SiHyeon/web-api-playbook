import { createInpockAuth } from './web-auth/inpock.mjs';
import { WebAuthError } from './web-auth/myrealtrip.mjs';

const API = 'https://link-rest.inpock.co.kr';
const fail = (code, receipt) => { throw new WebAuthError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cursor = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);

// Only named GET operations actually observed in the authenticated admin UI.
export function createInpockReadClient({ auth = createInpockAuth(), now = Date.now } = {}) {
  async function get(session, route, safePath) {
    let response;
    try { response = await session.request(API + route); }
    catch (error) {
      fail('INPOCK_TRANSPORT_FAILED', { causeCode: /^SCOPED_SESSION_[A-Z_]+$/.test(error.code || '') ? error.code : 'TRANSPORT_ERROR' });
    }
    const mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
    const receipt = { method: 'GET', origin: API, path: safePath, httpStatus: response.status,
      mime: mime ?? null, responseBytes: Buffer.byteLength(response.raw), checkedAt: new Date(now()).toISOString(), browserUsed: false };
    if (response.status === 401) fail('REAUTH_REQUIRED', receipt);
    if (response.status === 403) fail('AUTH_FORBIDDEN', receipt);
    if (response.status === 429) fail('AUTH_THROTTLED', receipt);
    if (response.status !== 200 || mime !== 'application/json') fail('INPOCK_RESPONSE_INVALID', receipt);
    let data;
    try { data = JSON.parse(response.raw); } catch { fail('INPOCK_RESPONSE_INVALID', receipt); }
    return { data, receipt };
  }
  return {
    listBlocks: async ({ maxPages = 5 } = {}) => {
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) fail('INPOCK_PAGE_BUDGET_INVALID');
      return auth.withSession(async (session, owner) => {
      const blocks = [], receipts = [], seen = new Set();
      let next = null, hasMore = true;
      for (let page = 0; page < maxPages && hasMore; page++) {
        const route = '/v2/blocks' + (next ? '?' + new URLSearchParams({ cursor: next }) : '');
        const { data, receipt } = await get(session, route, '/v2/blocks');
        if (!object(data) || !Array.isArray(data.blocks) || data.blocks.some(b => !object(b)) ||
            typeof data.has_next !== 'boolean' || (data.has_next && !cursor(data.next_cursor)) ||
            (!data.has_next && data.next_cursor !== null && data.next_cursor !== undefined && !cursor(data.next_cursor))) {
          fail('INPOCK_BLOCKS_SCHEMA_INVALID', receipt);
        }
        blocks.push(...data.blocks);
        receipts.push({ ...receipt, operation: 'blocks', recordCount: data.blocks.length, hasNext: data.has_next });
        hasMore = data.has_next;
        if (hasMore) {
          if (seen.has(data.next_cursor)) fail('INPOCK_PAGINATION_LOOP', receipt);
          seen.add(data.next_cursor);
          next = data.next_cursor;
        }
      }
      return { authenticated: owner.authenticated, ownerVerified: owner.ownerVerified, browserUsed: false,
        blocks, recordCount: blocks.length, complete: !hasMore, pages: receipts.length,
        stopReason: hasMore ? 'page_budget' : 'server_end', receipts };
      });
    },
    publicProfile: () => auth.withSession(async (session, owner, actor) => {
      const name = owner.user.username;
      const { data, receipt } = await get(session, '/v2/users/' + encodeURIComponent(name) + '/public', '/v2/users/:username/public');
      if (!object(data) || !object(data.user) || data.user.username !== name ||
          !Number.isSafeInteger(data.user.user_id) || data.user.user_id <= 0 || data.user.user_id !== actor?.id ||
          !Array.isArray(data.blocks) || data.blocks.some(b => !object(b))) {
        fail('INPOCK_PUBLIC_SCHEMA_INVALID', receipt);
      }
      return { authenticated: owner.authenticated, ownerVerified: true, browserUsed: false,
        profile: data.user, blocks: data.blocks, recordCount: data.blocks.length,
        receipt: { ...receipt, operation: 'public-profile', ownerMatched: true, recordCount: data.blocks.length } };
    }),
    miniStats: () => auth.withSession(async (session, owner) => {
      const route = '/stats/mini?' + new URLSearchParams({ username: owner.user.username });
      const { data, receipt } = await get(session, route, '/stats/mini');
      const fields = ['today', 'accumulated', 'realtime', 'subscribers'];
      if (!object(data) || !object(data.results) || fields.some(k => !Number.isSafeInteger(data.results[k]) || data.results[k] < 0) ||
          typeof data.updated_at !== 'string') fail('INPOCK_STATS_SCHEMA_INVALID', receipt);
      return { authenticated: owner.authenticated, ownerVerified: true, browserUsed: false,
        stats: Object.fromEntries(fields.map(k => [k, data.results[k]])), updatedAt: data.updated_at,
        receipt: { ...receipt, operation: 'mini-stats', fieldsReturned: fields } };
    }),
  };
}
