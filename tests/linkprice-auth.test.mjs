import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { ScopedSession } from '../lib/scoped-session.mjs';
import { createLinkpriceAuth, parseLinkpriceBody, linkpriceClickUrl } from '../lib/web-auth/linkprice.mjs';

// Contracts observed 2026-09-24/25 on api.linkprice.com: JSON/NDJSON bodies with a text/html MIME,
// expired tokens as HTTP 200 {error_code, error_message:"Token is expired"}, refresh as {tkn} or {code,msg}.
const NOW = Date.parse('2026-09-25T01:00:00Z');
const jwt = exp => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'sig'].join('.');
const html = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value),
  { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });

async function harness(t, { state, pending, routes }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linkprice-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ProtectedStore({ provider: 'memory', directory: dir });
  store.write('linkprice-login', JSON.stringify({ version: 1, username: 'owner1', password: 'pw-value' }));
  if (state) store.write('linkprice-state', JSON.stringify(state));
  if (pending) store.write('linkprice-pending', JSON.stringify(pending));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
    const auth = new Headers(init.headers).get('authorization');
    calls.push({ route, orm: body?.orm_key ?? null, auth });
    return routes({ route, body, auth });
  };
  return { store, calls, auth: createLinkpriceAuth({ store, fetchImpl, now: () => NOW }) };
}
const storedState = token => {
  const API = 'https://api.linkprice.com';
  const session = new ScopedSession({ allowedOrigins: [API], cookieOrigins: [API], defaultHeaders: { accept: 'application/json' },
    headersByOrigin: { [API]: { origin: 'https://ac.linkprice.net', referer: 'https://ac.linkprice.net/', 'content-type': 'application/json',
      authorization: 'Bearer ' + token, 'x-csrf-token': 'csrf-1' } }, timeoutMs: 15000, maxResponseBytes: 4 * 1024 * 1024, maxRedirects: 0 });
  return { version: 1, username: 'owner1', verified: true, expiresAt: new Date(NOW + 3600e3).toISOString(), session: session.toJSON() };
};

test('NDJSON bodies parse to an object for one row and an array for many', () => {
  assert.deepEqual(parseLinkpriceBody('{"a":1}\n'), { a: 1 });
  assert.deepEqual(parseLinkpriceBody('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.equal(parseLinkpriceBody('  \n'), null);
  assert.throws(() => parseLinkpriceBody('<html>'));
});

test('click URLs follow the web app getClickUrl format and reject bad input', () => {
  assert.equal(linkpriceClickUrl({ merchantId: 'gmarket', affiliateId: 'A100708014', targetUrl: 'https://item.gmarket.co.kr/Item?goodscode=1' }),
    'https://click.linkprice.com/click.php?m=gmarket&a=A100708014&l=9999&l_cd1=3&l_cd2=0&tu=https%3A%2F%2Fitem.gmarket.co.kr%2FItem%3Fgoodscode%3D1');
  assert.throws(() => linkpriceClickUrl({ merchantId: 'g market', affiliateId: 'A100708014', targetUrl: 'https://x.example' }), /LINK_INPUT_INVALID/);
  assert.throws(() => linkpriceClickUrl({ merchantId: 'gmarket', affiliateId: 'A100708014', targetUrl: 'javascript:alert(1)' }), /LINK_TARGET_INVALID/);
});

test('an expired token answered as HTTP 200 triggers token refresh, not a schema failure', async t => {
  const fresh = jwt(Math.floor(NOW / 1000) + 3600);
  const h = await harness(t, { state: storedState('old-token'), routes: ({ route, body, auth }) => {
    if (route === '/svc/token/refresh') return html({ tkn: fresh });
    if (body?.orm_key === 'dc_lpop/taccount/v1/GetAccount') return auth === 'Bearer old-token'
      ? html({ error_code: 401, error_message: 'Token is expired' }) : html('{"account_id":"owner1"}\n');
    return html({}, 500);
  } });
  const result = await h.auth.ensure();
  assert.equal(result.renewal, 'token_refresh'); assert.equal(result.ownerVerified, true);
  assert.equal(h.calls.filter(c => c.route === '/svc/login').length, 0);
  assert.equal(JSON.parse(h.store.read('linkprice-state')).session.headersByOrigin['https://api.linkprice.com'].authorization, 'Bearer ' + fresh);
  assert.equal(JSON.parse(h.store.read('linkprice-state')).session.headersByOrigin['https://api.linkprice.com']['x-csrf-token'], 'csrf-1');
});

test('a refused refresh (3-month limit) falls back to password login', async t => {
  const fresh = jwt(Math.floor(NOW / 1000) + 3600);
  const h = await harness(t, { state: { ...storedState('old-token'), expiresAt: new Date(NOW - 1000).toISOString() }, routes: ({ route, body, auth }) => {
    if (route === '/svc/token/refresh') return html({ code: 401, msg: '3 months have passed since the initial token issuance date.' });
    if (route === '/svc/login') return html({ success: true, token: fresh, csrf: 'csrf-2', name: 'x' });
    if (body?.orm_key === 'dc_lpop/taccount/v1/GetAccount') return auth === 'Bearer ' + fresh ? html({ account_id: 'owner1' }) : html({ error_code: 401, error_message: 'Token is expired' });
    return html({}, 500);
  } });
  const result = await h.auth.ensure();
  assert.equal(result.renewal, 'password_login'); assert.equal(result.reason, 'expiry_hint');
  assert.deepEqual(h.calls.map(c => c.route), ['/svc/token/refresh', '/svc/login', '/svc/query']);
  assert.equal(JSON.parse(h.store.read('linkprice-pending')).phase, 'complete');
});

test('an earlier ambiguous login no longer blocks a new login and stays on record', async t => {
  const fresh = jwt(Math.floor(NOW / 1000) + 3600);
  const h = await harness(t, { pending: { version: 1, phase: 'login_outcome_unknown', startedAt: '2026-09-24T00:00:00Z', code: 'AUTH_OUTCOME_UNKNOWN' },
    routes: ({ route }) => route === '/svc/login' ? html({ success: true, token: fresh, csrf: 'c' }) : html({ account_id: 'owner1' }) });
  assert.equal(h.auth.status().pendingPhase, 'login_outcome_unknown');
  const pendingWrites = [];
  const write = h.store.write.bind(h.store);
  h.store.write = (name, value) => { if (name === 'linkprice-pending') pendingWrites.push(JSON.parse(value)); return write(name, value); };
  const result = await h.auth.ensure();
  assert.equal(result.renewal, 'password_login');
  assert.equal(pendingWrites[0].previousAttempt.startedAt, '2026-09-24T00:00:00Z');
  assert.equal(h.auth.status().pendingPhase, 'complete');
});

test('other application errors stay distinct from re-authentication', async t => {
  const h = await harness(t, { state: storedState('ok-token'), routes: ({ body }) =>
    body?.orm_key === 'dc_lpop/taccount/v1/GetAccount' ? html({ error_code: 500, error_message: 'Internal DB error' }) : html({}, 500) });
  await assert.rejects(h.auth.health(), /AUTH_APPLICATION_ERROR/);
});

test('merchants are projected; subscriptions map ErrNoRows to NONE and APR to linkable; links need APR', async t => {
  const h = await harness(t, { state: storedState('ok-token'), routes: ({ body }) => {
    const k = body?.orm_key;
    if (k === 'dc_lpop/taccount/v1/GetAccount') return html({ account_id: 'owner1' });
    if (k === 'dc_lpop/taffiliate/v1/GetAffiliates') return html('{"affiliate_id":"A100708014","site_url":"https://blog.naver.com/aicandoanything"}\n');
    if (k === 'dc_lpop/tmerchant/v1/GetMerchants') return html('{"merchant_id":"gmarket","site_name":"G마켓","approval_type":"AUT","notice":"long text","w_com_info":"x"}\n{"merchant_id":"11st","site_name":"11번가","approval_type":"MAN"}\n');
    if (k === 'dc_lpop/tsubscript/v1/GetSubscript') return body.input.mer_id === 'gmarket'
      ? html({ subs_status: 'APR', mer_id: 'gmarket' }) : html({ error_code: 404, error_message: 'ErrNoRows' });
    return html({}, 500);
  } });
  const m = await h.auth.merchants({ kind: 'cps' });
  assert.deepEqual(m.merchants.map(x => x.merchant_id), ['gmarket', '11st']);
  assert.equal('notice' in m.merchants[0], false);
  const s = await h.auth.subscriptions(['gmarket', '11st']);
  assert.deepEqual(s.subscriptions.map(x => [x.merchantId, x.status, x.linkable]), [['gmarket', 'APR', true], ['11st', 'NONE', false]]);
  const link = await h.auth.link({ merchantId: 'gmarket', targetUrl: 'https://www.gmarket.co.kr/' });
  assert.match(link.url, /^https:\/\/click\.linkprice\.com\/click\.php\?m=gmarket&a=A100708014&l=9999/);
  await assert.rejects(h.auth.link({ merchantId: '11st', targetUrl: 'https://www.11st.co.kr/' }), /MERCHANT_NOT_APPROVED/);
});

test('apply sends one Create per AUT merchant, skips manual and existing, and never resends with a journal record', async t => {
  const subs = new Map([['lotteon', 'APR']]);
  const h = await harness(t, { state: storedState('ok-token'), routes: ({ body }) => {
    const k = body?.orm_key;
    if (k === 'dc_lpop/taccount/v1/GetAccount') return html({ account_id: 'owner1' });
    if (k === 'dc_lpop/taffiliate/v1/GetAffiliates') return html('{"affiliate_id":"A100708014","site_url":"https://blog.naver.com/aicandoanything"}\n{"affiliate_id":"A100799999","site_url":"https://i-never-stop-study.tistory.com"}\n');
    if (k === 'dc_lpop/tmerchant/v1/GetMerchant') return html({ approval_type: body.input.mer_id === '11st' ? 'MAN' : 'AUT' });
    if (k === 'dc_lpop/tsubscript/v1/GetSubscript') return subs.has(body.input.mer_id + body.input.aff_id) || subs.has(body.input.mer_id)
      ? html({ subs_status: subs.get(body.input.mer_id + body.input.aff_id) ?? subs.get(body.input.mer_id) }) : html({ error_code: 404, error_message: 'ErrNoRows' });
    if (k === 'dc_lpop/tsubscript/v1/Create') { subs.set(body.input.merchant_id + body.input.affiliate_id, body.input.subs_status); return html({ last_inserted_id: 7 }); }
    return html({}, 500);
  } });
  await assert.rejects(h.auth.apply({ merchantIds: ['gmarket'] }), /AFFILIATE_AMBIGUOUS/);
  const r = await h.auth.apply({ merchantIds: ['gmarket', '11st', 'lotteon'], affiliateId: 'A100799999' });
  assert.deepEqual(r.results.map(x => [x.merchantId, x.outcome, x.status]), [['gmarket', 'written', 'APR'], ['11st', 'skipped_manual_approval', 'NONE'], ['lotteon', 'existing', 'APR']]);
  const creates = () => h.calls.filter(c => c.orm === 'dc_lpop/tsubscript/v1/Create').length;
  assert.equal(creates(), 1);
  subs.delete('gmarketA100799999'); // pretend the row vanished: the journal must stop a second Create
  const again = await h.auth.apply({ merchantIds: ['gmarket'], affiliateId: 'A100799999' });
  assert.equal(again.results[0].outcome, 'previous_attempt_not_found'); assert.equal(creates(), 1);
});

test('addSite registers a website once and reports an existing one without writing', async t => {
  let tistory = false;
  const h = await harness(t, { state: storedState('ok-token'), routes: ({ body }) => {
    const k = body?.orm_key;
    if (k === 'dc_lpop/taccount/v1/GetAccount') return html({ account_id: 'owner1' });
    if (k === 'dc_lpop/taffiliate/v1/GetAffiliates') return html('{"affiliate_id":"A100708014","site_url":"https://blog.naver.com/aicandoanything"}\n' +
      (tistory ? '{"affiliate_id":"A100799999","site_url":"https://i-never-stop-study.tistory.com"}\n' : ''));
    if (k === 'dc_lpop/taffiliate/v1/Create') {
      assert.equal(body.input.site_type, 'W'); assert.equal(body.input.account_id, 'owner1'); assert.equal(body.input.kc_category1, '912');
      tistory = true; return html({ last_inserted_id: 9 });
    }
    return html({}, 500);
  } });
  const site = { siteName: '아네스의 공부일지', siteUrl: 'https://i-never-stop-study.tistory.com/', category1: '912', category2: '914', siteDesc: 'AI 활용과 여행·쇼핑 특가 정보를 정리하는 블로그' };
  const first = await h.auth.addSite(site);
  assert.deepEqual([first.outcome, first.affiliateId], ['written', 'A100799999']);
  const second = await h.auth.addSite(site);
  assert.equal(second.outcome, 'existing');
  assert.equal(h.calls.filter(c => c.orm === 'dc_lpop/taffiliate/v1/Create').length, 1);
  await assert.rejects(h.auth.addSite({ ...site, category1: 'x' }), /SITE_INPUT_INVALID/);
});
