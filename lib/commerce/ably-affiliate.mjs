// Ably creator share-link issuance (공유 리워드) through the already logged-in Canary session (CDP).
// Observed 2026-10-20 on mobile.a-bly.com (site bundle + live replay). See references/commerce-ably.md.
//
// Contract (site bundle): POST https://api.a-bly.com/api/v2/affiliate/links/ {goods_sno} -> {link, app_link}.
//   - The site calls this path only when members/me.affiliate_information.is_link_campaign_affiliator is true.
//   - Headers the site sends: Authorization "JWT <ably-jwt-token cookie>", X-Device-Id (localStorage device-id),
//     X-Web-Type "Web", X-Device-Type "PCWeb", X-App-Version "0.1.0". Path needs the trailing slash.
//   - Tracking: landing URL "/goods/<sno>?uid=<uid>" (web link) and the airbridge app link (applink.a-bly.com/<code>)
//     that 302-redirects to the same goods URL with the same uid.
//
// Boundary: no credentials are read or written. Requests run inside a temporary tab of the automation Canary,
// opened and closed by this module, so the JWT stays in the page and never reaches stdout or disk.
// Every issuance is reserved and finished in the write journal (service "ably"), so a sno is not issued twice
// unless a reissue reason is given.

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WriteJournal } from '../write-journal.mjs';

export const ABLY_CDP_DEFAULT = 'http://127.0.0.1:9333';
export const ABLY_LINK_OPERATION = 'affiliate.link_create';
const JOURNAL_SERVICE = 'ably';
const APP_LINK_HOST = 'applink.a-bly.com';
const WEB_ORIGIN = 'https://m.a-bly.com';
const READY_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

const makeError = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const fail = (code, extra = {}) => { throw makeError(code, extra); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function affiliateJournalRoot() {
  return path.join(os.homedir(), '.config', 'xhr-to-api-only', 'write-journals');
}

function journalFor(root) {
  return new WriteJournal({ root, service: JOURNAL_SERVICE });
}

/** Prior records for this sno (any state), read from the service directory. */
async function priorRecords(root, sno) {
  const dir = path.join(root, JOURNAL_SERVICE);
  let names;
  try { names = await readdir(dir); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (record?.safeRecord?.operation === ABLY_LINK_OPERATION && record.safeRecord.goodsSno === sno) out.push(record);
    } catch { /* unreadable record: ignored here, journal integrity is the journal's concern */ }
  }
  return out;
}

function normalizeSno(value) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,11}$/.test(text)) fail('ABLY_SNO_INVALID');
  return Number(text);
}

// ---- page-side functions (serialized with toString and evaluated inside the Ably tab) ----

async function pageCheck({ sno }) {
  const cookie = (document.cookie.match(/(?:^|; )ably-jwt-token=([^;]*)/) || [])[1];
  if (!cookie) return { error: 'ABLY_SESSION_MISSING' };
  const headers = { Authorization: `JWT ${cookie}`, 'X-Device-Type': 'PCWeb', 'X-App-Version': '0.1.0', 'X-Web-Type': 'Web', 'X-Device-Id': localStorage.getItem('device-id') || '' };
  const api = 'https://api.a-bly.com';
  const me = await fetch(`${api}/api/v2/members/me/`, { headers });
  const meJson = await me.json().catch(() => null);
  const goods = await fetch(`${api}/api/v2/affiliate/goods/${sno}/`, { headers });
  const goodsJson = await goods.json().catch(() => null);
  return {
    member: { status: me.status, isLinkCampaignAffiliator: meJson?.affiliate_information?.is_link_campaign_affiliator ?? null },
    goods: { status: goods.status, isAffiliateMember: goodsJson?.is_affiliate_member ?? null, isCampaignMember: goodsJson?.is_campaign_member ?? null, expectedReward: goodsJson?.expected_reward ?? null },
  };
}

async function pagePost({ sno }) {
  const cookie = (document.cookie.match(/(?:^|; )ably-jwt-token=([^;]*)/) || [])[1];
  if (!cookie) return { error: 'ABLY_SESSION_MISSING' };
  const headers = { 'Content-Type': 'application/json', Authorization: `JWT ${cookie}`, 'X-Device-Type': 'PCWeb', 'X-App-Version': '0.1.0', 'X-Web-Type': 'Web', 'X-Device-Id': localStorage.getItem('device-id') || '' };
  try {
    const response = await fetch('https://api.a-bly.com/api/v2/affiliate/links/', { method: 'POST', headers, body: JSON.stringify({ goods_sno: sno }) });
    const body = await response.json().catch(() => null);
    return { status: response.status, link: body?.link ?? null, app_link: body?.app_link ?? null };
  } catch {
    return { error: 'ABLY_POST_NETWORK_FAILED' };
  }
}

// ---- minimal CDP client (Node global WebSocket) ----

function openSocket(url, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(makeError(code)), READY_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(makeError(code)); };
  });
}

function rpc(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(makeError('ABLY_CDP_TIMEOUT')); }, CALL_TIMEOUT_MS);
        pending.set(id, message => { clearTimeout(timer); resolve(message); });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function evaluate(page, expression) {
  const message = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (message.result?.exceptionDetails) fail('ABLY_PAGE_EVAL_FAILED');
  return message.result?.result?.value;
}

async function openSession(cdpBase) {
  let version;
  try { version = await (await fetch(`${cdpBase}/json/version`)).json(); } catch { throw fail('ABLY_CDP_UNAVAILABLE'); }
  const browserSocket = await openSocket(version.webSocketDebuggerUrl, 'ABLY_CDP_UNAVAILABLE');
  const browser = rpc(browserSocket);
  const created = await browser.send('Target.createTarget', { url: `${WEB_ORIGIN}/my` });
  const targetId = created.result?.targetId;
  if (!targetId) { browserSocket.close(); throw fail('ABLY_CDP_TARGET_FAILED'); }
  let pageSocket = null;
  const close = async () => {
    try { await browser.send('Target.closeTarget', { targetId }); } catch { /* best effort */ }
    try { pageSocket?.close(); } catch { /* best effort */ }
    try { browserSocket.close(); } catch { /* best effort */ }
  };
  try {
    const list = await (await fetch(`${cdpBase}/json/list`)).json();
    const target = list.find(item => item.id === targetId);
    if (!target?.webSocketDebuggerUrl) throw fail('ABLY_CDP_TARGET_FAILED');
    pageSocket = await openSocket(target.webSocketDebuggerUrl, 'ABLY_CDP_TARGET_FAILED');
    const page = rpc(pageSocket);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const state = await evaluate(page, 'document.readyState + " " + location.host');
      if (/^complete (mobile|m)\.a-bly\.com$/.test(String(state))) break;
      if (Date.now() > deadline) throw fail('ABLY_PAGE_NOT_READY');
      await sleep(500);
    }
    return {
      call: (fn, arg) => evaluate(page, `(${fn.toString()})(${JSON.stringify(arg)})`),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function verifyAppLink(appLink, sno, uid) {
  const url = new URL(appLink);
  if (url.protocol !== 'https:' || url.hostname !== APP_LINK_HOST) return { checked: false, reason: 'APP_LINK_HOST_UNEXPECTED' };
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location') || '';
  let target;
  try { target = new URL(location); } catch { return { checked: true, status: response.status, goodsPath: false, uidMatches: false }; }
  return {
    checked: true,
    status: response.status,
    goodsPath: target.pathname === `/goods/${sno}`,
    uidMatches: target.searchParams.get('uid') === uid,
    host: target.hostname,
  };
}

/**
 * Issue (or check) a creator share link for one goods sno.
 * checkOnly: reads membership and goods flags only, no write.
 * reissueReason: required to issue a sno that already has an issued record.
 */
export async function issueAffiliateLink({ sno: rawSno, cdp = ABLY_CDP_DEFAULT, checkOnly = false, reissueReason = null, journalRoot = affiliateJournalRoot() } = {}) {
  const sno = normalizeSno(rawSno);
  if (reissueReason !== null && (typeof reissueReason !== 'string' || reissueReason.length > 200)) fail('ABLY_REISSUE_REASON_INVALID');
  const prior = await priorRecords(journalRoot, sno);
  const issued = prior.filter(record => record.state === 'issued');
  const session = await openSession(cdp);
  try {
    const check = await session.call(pageCheck, { sno });
    if (check?.error) fail(check.error);
    const base = { sno, member: check.member, goods: check.goods, priorIssued: issued.length };
    if (checkOnly) return { ...base, mode: 'check-only', writesSubmitted: 0 };
    if (check.member.isLinkCampaignAffiliator !== true) fail('ABLY_CAMPAIGN_NOT_JOINED', base);
    if (issued.length > 0 && !reissueReason) fail('ABLY_AFFILIATE_ALREADY_ISSUED', { sno, priorIssued: issued.length });

    const journal = journalFor(journalRoot);
    const attempt = prior.length + 1;
    const key = journal.key(ABLY_LINK_OPERATION, { goodsSno: sno }, { attempt });
    await journal.reserve(key, {
      operation: ABLY_LINK_OPERATION, goodsSno: sno, attempt, endpoint: 'POST /api/v2/affiliate/links/',
      reason: reissueReason ?? 'initial issue after campaign join',
    });

    let post;
    try {
      post = await session.call(pagePost, { sno });
    } catch (error) {
      await journal.finish(key, 'unknown_post_result', { note: 'page call failed after POST may have been sent' });
      throw fail('ABLY_AFFILIATE_POST_UNKNOWN', { sno });
    }
    if (post?.error || post?.status !== 201 || !post.link || !post.app_link) {
      await journal.finish(key, post?.error ? 'unknown_post_result' : 'failed', { status: post?.status ?? null });
      fail(post?.error ?? (post?.status ? `ABLY_AFFILIATE_HTTP_${post.status}` : 'ABLY_LINK_RESPONSE_INVALID'), { sno });
    }
    const webUrl = new URL(post.link, WEB_ORIGIN);
    const uid = webUrl.searchParams.get('uid');
    if (!uid || webUrl.pathname !== `/goods/${sno}`) {
      await journal.finish(key, 'failed', { note: 'web link without uid or unexpected path' });
      fail('ABLY_LINK_RESPONSE_INVALID', { sno });
    }
    const appLinkCode = new URL(post.app_link).pathname.replace(/^\//, '');
    const redirect = await verifyAppLink(post.app_link, sno, uid);
    await journal.finish(key, 'issued', {
      status: post.status, uid, appLinkCode, webLinkPath: `/goods/${sno}`, redirectUidVerified: redirect.uidMatches === true,
    });
    return {
      ...base, mode: 'issued', writesSubmitted: 1, attempt,
      link: { web: `${WEB_ORIGIN}/goods/${sno}?uid=${uid}`, uid, app: post.app_link },
      redirect,
    };
  } finally {
    await session.close();
  }
}
