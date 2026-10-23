import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { loadNaverCookies } from '../../naver-blog-api/scripts/session-vault.mjs';
import { SessionClient } from '../../naver-blog-api/scripts/session-client.mjs';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';

const OWNER_BLOG_ID = 'aicandoanything';
const ADMIN_ORIGIN = 'https://admin.blog.naver.com';
const BLOG_ORIGIN = 'https://blog.naver.com';
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_INVITE_PAGES = 100;
const CONTRACT_EVIDENCE = 'authenticated_first_party_html_and_current_js';
const FORM_FIELDS = new Set(['blogId', 'groupId', 'targetBlogId', 'groupIdSelector', 'newGroup', 'groupName', 'groupOpen', 'message', 'trackingCode']);
const MUTUAL_BODY_FIELDS = Object.freeze(['blogId', 'groupId', 'groupIdSelector', 'message', 'targetBlogId']);

function fail(code) { throw Object.assign(new Error(code), { code }); }

async function withNaverSessionLock(operation) {
  try {
    return await withSessionLock(operation, { lockPath: path.join(os.homedir(), '.config', 'affiliate-content-operations', 'naver-social.lock') });
  } catch (error) {
    if (error.code === 'TISTORY_SESSION_BUSY') fail('NAVER_SESSION_BUSY');
    throw error;
  }
}

function normalizeInput(input) {
  const operation = input?.operation;
  const target = typeof input?.target === 'string' ? input.target.trim() : '';
  if (!['neighbor', 'request'].includes(operation)) fail('NAVER_ACTION_INVALID');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(target)) fail('NAVER_TARGET_INVALID');
  if (input.groupId !== undefined && (typeof input.groupId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(input.groupId))) {
    fail('NAVER_GROUP_INVALID');
  }
  if (input.message !== undefined && typeof input.message !== 'string') fail('NAVER_MESSAGE_INVALID');
  return { operation, target, groupId: input.groupId, message: input.message };
}

function ownerFingerprint() {
  return createHash('sha256').update(`naver\0${OWNER_BLOG_ID}`).digest('hex').slice(0, 16);
}

async function openOwnerSession(options = {}) {
  const saved = await loadNaverCookies({ env: {} });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const client = new SessionClient({
    cookies: saved.cookies,
    fetchImpl,
    ownerBlogId: OWNER_BLOG_ID,
    defaultHeaders: saved.userAgent ? { 'user-agent': saved.userAgent } : {},
  });
  let owner;
  try { owner = await client.verifyRoot(); }
  catch { client.clear(); fail('NAVER_OWNER_VERIFY_FAILED'); }
  if (!owner.verified || !owner.actorMatched || !owner.adminShell) {
    client.clear();
    fail('NAVER_OWNER_VERIFY_FAILED');
  }
  return { client, saved, fetchImpl, owner };
}

async function readBoundedHtml(response) {
  const type = response.headers.get('content-type') || '';
  if (!/^text\/html(?:;|$)/i.test(type) || !response.body) fail('NAVER_READ_SCHEMA_CHANGED');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        fail('NAVER_READ_SIZE_LIMIT');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code) throw error;
    fail('NAVER_READ_FAILED');
  }
  return { html: Buffer.concat(chunks, bytes).toString('utf8'), bytes };
}

async function readBoundedResponseText(response) {
  if (!response?.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel().catch(() => {});
        return '';
      }
      chunks.push(Buffer.from(value));
    }
  } catch { return ''; }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function getHtml(context, rawUrl, referer) {
  let current;
  try { current = new URL(rawUrl); } catch { fail('NAVER_REQUEST_SCOPE'); }
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (![ADMIN_ORIGIN, BLOG_ORIGIN].includes(current.origin) || current.username || current.password || current.hash) fail('NAVER_REQUEST_SCOPE');
    let response;
    try {
      response = await context.client.fetch(current.href, {
        headers: { accept: 'text/html,application/xhtml+xml', ...(referer ? { referer } : {}) },
        signal: AbortSignal.timeout(20000),
      });
    } catch { fail('NAVER_READ_FAILED'); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 4) fail('NAVER_READ_REDIRECT_LIMIT');
      try { current = new URL(location, current); } catch { fail('NAVER_REQUEST_SCOPE'); }
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      fail(response.status === 401 || response.status === 403 ? 'NAVER_REAUTH_REQUIRED' : 'NAVER_READ_FAILED');
    }
    return { ...(await readBoundedHtml(response)), status: response.status, path: current.pathname, url: current.href };
  }
  fail('NAVER_READ_REDIRECT_LIMIT');
}

function documentFrom(html) {
  try { return new JSDOM(html).window.document; }
  catch { fail('NAVER_READ_SCHEMA_CHANGED'); }
}

function safeText(node) { return (node?.textContent || '').replace(/\s+/g, ' ').trim(); }

function targetReference(value, target) {
  if (typeof value !== 'string' || !value) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[/?&=_'"(])${escaped}(?:$|[/?&#_'"),])`, 'i').test(value);
}

function rowReferencesTarget(row, target) {
  if (!row || /^(FORM|SCRIPT|STYLE|INPUT|TEXTAREA|SELECT)$/.test(row.tagName)) return false;
  const values = [...row.attributes].map(attr => attr.value);
  for (const node of row.querySelectorAll('[href],[onclick],[data-blog-id],[data-blogid],[value]')) {
    for (const attr of node.attributes) values.push(attr.value);
  }
  return values.some(value => targetReference(value, target));
}

function candidateRows(document, target) {
  const rows = [...document.querySelectorAll('tr, li')].filter(row => rowReferencesTarget(row, target));
  const unique = [...new Set(rows)];
  // Nested list/table wrappers can produce duplicate semantic matches. Keep the innermost row.
  return unique.filter(row => !unique.some(other => other !== row && row.contains(other)));
}

function emptyBuddySearch(document, target) {
  const queryFields = [...document.querySelectorAll('input[name="searchText"]')];
  const queryMatches = queryFields.length > 0 && queryFields.every(field => field.value === target);
  const text = safeText(document.body);
  return queryMatches && text.includes(`'${target}'에 대한 검색 결과`)
    && /검색\s*결과\s*\(\s*0\s*건\s*\)/.test(text);
}

function emptySentInvitePage(document) {
  const emptyRows = [...document.querySelectorAll('td.none, .nodata, .no_data, .noData, .empty_list')].map(safeText);
  return emptyRows.some(text => /진행\s*중인\s*이웃신청이\s*없습니다/.test(text));
}

function classifyNeighborList(page, target) {
  const document = documentFrom(page.html);
  const rows = candidateRows(document, target);
  if (rows.length > 1) fail('NAVER_RELATIONSHIP_AMBIGUOUS');
  if (rows.length === 1) {
    // The observed list has a dedicated td.type (mutual uses span.both).
    // A request link elsewhere in the row is not evidence of a mutual relationship.
    const label = safeText(rows[0].querySelector('td.type'));
    if (!['이웃', '서로이웃'].includes(label)) fail('NAVER_RELATIONSHIP_SCHEMA_CHANGED');
    const mutual = label === '서로이웃';
    return { found: true, mutual, relation: mutual ? 'mutual' : 'neighbor' };
  }
  if (emptyBuddySearch(document, target)) return { found: false, mutual: false, relation: 'none' };
  fail('NAVER_RELATIONSHIP_UNVERIFIED');
}

function pageTargets(document) {
  const values = new Set();
  for (const node of document.querySelectorAll('[onclick],a[href]')) {
    const text = node.getAttribute('onclick') || node.getAttribute('href') || '';
    for (const match of text.matchAll(/goPage\s*\(\s*(\d+)\s*\)|currentPage=(\d+)/gi)) {
      const n = Number(match[1] || match[2]);
      if (Number.isSafeInteger(n) && n >= 1 && n <= MAX_INVITE_PAGES) values.add(n);
    }
  }
  return [...values].sort((a, b) => a - b);
}

function explicitLastPage(document) {
  const scripts = [...document.scripts].map(script => script.textContent || '').join('\n');
  for (const expression of [/(?:totalPage|totalPages|nTotalPage)\s*[:=]\s*["']?(\d+)/i, /pageCount\s*[:=]\s*["']?(\d+)/i]) {
    const value = Number(expression.exec(scripts)?.[1]);
    if (Number.isSafeInteger(value) && value >= 1 && value <= MAX_INVITE_PAGES) return value;
  }
  return null;
}

async function readSentInvites(context, target) {
  let pageNumber = 1;
  let finalPage = null;
  let pagesRead = 0;
  while (pageNumber <= MAX_INVITE_PAGES) {
    const url = new URL('/BuddyInviteSentManage.naver', ADMIN_ORIGIN);
    url.searchParams.set('blogId', OWNER_BLOG_ID);
    url.searchParams.set('currentPage', String(pageNumber));
    const page = await getHtml(context, url.href, `${ADMIN_ORIGIN}/BuddyInviteSentManage.naver?blogId=${OWNER_BLOG_ID}`);
    let landed;
    try { landed = new URL(page.url); } catch { fail('NAVER_INVITE_LIST_INCOMPLETE'); }
    if (landed.origin !== ADMIN_ORIGIN || landed.pathname !== '/BuddyInviteSentManage.naver'
      || landed.searchParams.get('blogId') !== OWNER_BLOG_ID
      || landed.searchParams.get('currentPage') !== String(pageNumber)) fail('NAVER_INVITE_LIST_INCOMPLETE');
    const document = documentFrom(page.html);
    const rows = [...document.querySelectorAll('tr, li')];
    for (const row of rows) {
      if (rowReferencesTarget(row, target)) return { pending: true, pagesRead: pagesRead + 1 };
    }
    pagesRead++;
    const last = explicitLastPage(document);
    if (last != null) finalPage = last;
    const future = pageTargets(document).filter(value => value > pageNumber);
    if (finalPage != null && pageNumber >= finalPage) break;
    if (future.includes(pageNumber + 1)) pageNumber++;
    else if (future.length) pageNumber = Math.min(...future);
    else if (pagesRead === 1 && emptySentInvitePage(document)) { finalPage = 1; break; }
    else if (finalPage != null && pageNumber < finalPage) pageNumber++;
    else fail('NAVER_INVITE_LIST_INCOMPLETE');
  }
  if (pagesRead >= MAX_INVITE_PAGES && (finalPage == null || pageNumber < finalPage)) fail('NAVER_INVITE_LIST_INCOMPLETE');
  return { pending: false, pagesRead };
}

async function readRelation(context, target) {
  const url = new URL('/BuddyListManage.naver', ADMIN_ORIGIN);
  url.searchParams.set('blogId', OWNER_BLOG_ID);
  url.searchParams.set('searchText', target);
  const page = await getHtml(context, url.href, `${ADMIN_ORIGIN}/BuddyListManage.naver?blogId=${OWNER_BLOG_ID}`);
  let landed;
  try { landed = new URL(page.url); } catch { fail('NAVER_RELATIONSHIP_UNVERIFIED'); }
  if (landed.origin !== ADMIN_ORIGIN || landed.pathname !== '/BuddyListManage.naver'
    || landed.searchParams.get('blogId') !== OWNER_BLOG_ID || landed.searchParams.get('searchText') !== target) {
    fail('NAVER_RELATIONSHIP_FILTER_NOT_PRESERVED');
  }
  const relation = classifyNeighborList(page, target);
  const sent = await readSentInvites(context, target);
  return {
    state: { neighbor: relation.found, mutual: relation.mutual, pending: sent.pending,
      relation: relation.relation },
    receipts: [
      { method: 'GET', path: '/BuddyListManage.naver', source: 'authenticated_buddy_list_search', httpStatus: page.status, bytes: page.bytes },
      { method: 'GET', path: '/BuddyInviteSentManage.naver', source: 'authenticated_sent_invite_pages', httpStatus: 200, pagesRead: sent.pagesRead },
    ],
  };
}

function successfulControls(form) {
  const result = [];
  for (const element of [...form.elements]) {
    if (!element.name || element.disabled) continue;
    const name = element.name;
    if (!FORM_FIELDS.has(name)) fail('NAVER_FORM_SCHEMA_CHANGED');
    const tag = element.tagName;
    const type = String(element.type || '').toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
    if (['checkbox', 'radio'].includes(type) && !element.checked) continue;
    if (tag === 'SELECT') {
      for (const option of element.selectedOptions) if (!option.disabled) result.push([name, option.value]);
    } else result.push([name, element.value ?? '']);
  }
  return result;
}

async function readActionForm(context, spec) {
  const mutual = spec.operation === 'request';
  const path = mutual ? '/BothBuddyMultiAddForm.naver' : '/BuddyMultiAddForm.naver';
  const postPath = mutual ? '/BothBuddyMultiAdd.naver' : '/BuddyMultiAdd.naver';
  const url = new URL(path, ADMIN_ORIGIN);
  url.searchParams.set('blogId', OWNER_BLOG_ID);
  url.searchParams.set('targetBlogId', spec.target);
  const page = await getHtml(context, url.href, `${ADMIN_ORIGIN}/BuddyMeManage.naver?blogId=${OWNER_BLOG_ID}`);
  const document = documentFrom(page.html);
  const form = [...document.forms].find(item => {
    const action = item.getAttribute('action') || '';
    try { return new URL(action, ADMIN_ORIGIN).origin === ADMIN_ORIGIN
      && new URL(action, ADMIN_ORIGIN).pathname === postPath; }
    catch { return false; }
  });
  if (!form || form.method.toLowerCase() !== 'post') fail('NAVER_FORM_SCHEMA_CHANGED');
  const fields = successfulControls(form);
  const controls = new Map(fields.map(([name, value]) => [name, value]));
  if (controls.get('blogId') !== OWNER_BLOG_ID || controls.get('targetBlogId') !== spec.target) fail('NAVER_FORM_IDENTITY_MISMATCH');
  const groupSelect = [...form.elements].find(element => element.tagName === 'SELECT' && element.name === 'groupIdSelector');
  if (!groupSelect) fail('NAVER_GROUPS_UNAVAILABLE');
  const selectable = [...groupSelect.options].filter(option => !option.disabled && option.value && option.value !== '0');
  const chosen = spec.groupId
    ? selectable.find(option => option.value === spec.groupId)
    : selectable.find(option => option.selected) || selectable[0];
  if (spec.groupId && !chosen) fail('NAVER_GROUP_INVALID');
  if (!chosen) fail('NAVER_GROUPS_UNAVAILABLE');
  controls.set('groupIdSelector', chosen.value);
  controls.set('groupId', chosen.value);
  controls.delete('newGroup');
  controls.delete('groupName');
  controls.delete('groupOpen');
  if (mutual && typeof spec.message === 'string' && spec.message.trim()
    && spec.message.length <= 400 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(spec.message)) {
    controls.set('message', spec.message);
  } else if (!mutual) {
    controls.delete('message');
  }
  const body = new URLSearchParams();
  for (const [name, value] of controls) body.append(name, value);
  const action = new URL(form.getAttribute('action'), ADMIN_ORIGIN);
  if (action.origin !== ADMIN_ORIGIN || action.pathname !== postPath) fail('NAVER_FORM_SCHEMA_CHANGED');
  const bodyFields = [...new Set([...body.keys()])].sort();
  if (!bodyFields.includes('blogId') || !bodyFields.includes('targetBlogId') || !bodyFields.includes('groupId')) fail('NAVER_FORM_SCHEMA_CHANGED');
  if (mutual && !bodyFields.includes('message')) fail('NAVER_FORM_SCHEMA_CHANGED');
  return { body, action, bodyFields, groupId: chosen.value, page };
}

function actionPlan(spec, relation, context, form) {
  const noOp = spec.operation === 'neighbor'
    ? relation.state.neighbor
    : relation.state.mutual || relation.state.pending;
  const path = spec.operation === 'request' ? '/BothBuddyMultiAdd.naver'
    : spec.groupId ? '/BuddyMultiAdd.naver' : '/BuddyAddAsync.naver';
  const bodyFields = spec.operation === 'neighbor' && !spec.groupId ? ['blogId']
    : form?.bodyFields || (spec.operation === 'request' ? MUTUAL_BODY_FIELDS : ['blogId', 'groupId', 'groupIdSelector', 'targetBlogId']);
  return {
    service: 'naver', operation: spec.operation, target: spec.target, normalizedTarget: spec.target,
    ownerFingerprint: ownerFingerprint(), ready: true, needsAction: !noOp, noOp,
    ...(noOp ? { reason: relation.state.mutual ? 'already_mutual' : relation.state.pending ? 'request_pending' : 'already_neighbor' } : {}),
    currentState: relation.state,
    request: { method: 'POST', path, operation: path.slice(1).replace('.naver', ''), bodyFields },
    auth: { ownerVerified: true, authenticated: true, provider: context.saved.provider, freshContext: true,
      credentialStore: 'naver-blog-session', credentialProtection: 'Windows DPAPI CurrentUser', credentialOrigins: [ADMIN_ORIGIN, BLOG_ORIGIN], browserUsed: false },
    captured: false, contractEvidence: CONTRACT_EVIDENCE, client_exists: true, remnant_free: true,
    credential_propagated: true, credential_propagated_for_write: false, live_replay: false,
    browserUsed: false, executionMode: 'pure_http', mutationCount: 0,
    readReceipt: { method: 'GET', path: '/BuddyListManage.naver', source: 'authenticated_owner_buddy_and_invite_read', httpStatus: 200,
      bytes: relation.receipts[0].bytes, ownerVerified: true, live_replay: true, browserUsed: false },
  };
}

async function buildContext(input, options = {}) {
  const spec = normalizeInput(input);
  if (spec.target.toLowerCase() === OWNER_BLOG_ID.toLowerCase()) fail('NAVER_SELF_ACTION_BLOCKED');
  const context = await openOwnerSession(options);
  try {
    const relation = await readRelation(context, spec.target);
    let form = null;
    const preflightNoOp = spec.operation === 'neighbor' ? relation.state.neighbor : relation.state.mutual || relation.state.pending;
    if (!preflightNoOp && (spec.operation === 'request' || spec.groupId)) form = await readActionForm(context, spec);
    const metadata = actionPlan(spec, relation, context, form);
    if (spec.operation === 'neighbor' && !metadata.noOp && relation.state.pending) {
      metadata.ready = false; metadata.code = 'NAVER_INVITE_PENDING';
    }
    if (spec.operation === 'request' && !metadata.noOp && (!spec.message || !spec.message.trim())) {
      metadata.ready = false; metadata.code = 'NAVER_MUTUAL_MESSAGE_REQUIRED';
    }
    if (spec.operation === 'request' && !metadata.noOp && typeof spec.message === 'string'
      && (spec.message.length > 400 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(spec.message))) {
      metadata.ready = false; metadata.code = 'NAVER_MUTUAL_MESSAGE_INVALID';
    }
    return { spec, context, relation, form, metadata };
  } catch (error) { context.client.clear(); throw error; }
}

export async function prepareNaverAction(input, options = {}) {
  return withNaverSessionLock(async () => {
    const built = await buildContext(input, options);
    try { return built.metadata; }
    finally { built.context.client.clear(); }
  });
}

function preparePost(context, plan, body) {
  const url = new URL(plan.request.path, plan.request.path === '/BuddyAddAsync.naver' ? BLOG_ORIGIN : ADMIN_ORIGIN);
  const headers = new Headers({
    accept: plan.request.path === '/BuddyAddAsync.naver' ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,application/xhtml+xml',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin: url.origin,
    referer: plan.request.path === '/BuddyAddAsync.naver' ? `${BLOG_ORIGIN}/PostList.naver?blogId=${encodeURIComponent(plan.target)}`
      : `${ADMIN_ORIGIN}${plan.operation === 'request' ? '/BothBuddyMultiAddForm.naver' : '/BuddyMultiAddForm.naver'}?blogId=${OWNER_BLOG_ID}&targetBlogId=${encodeURIComponent(plan.target)}`,
    cookie: context.client.cookieFor(url.href),
  });
  if (plan.request.path === '/BuddyAddAsync.naver') headers.set('x-requested-with', 'XMLHttpRequest');
  return { url, init: { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) } };
}

async function dispatchPost(context, request) {
  try {
    return await context.fetchImpl(request.url.href, request.init);
  } catch {
    return null;
  }
}

function parseNormalResponse(response, raw) {
  if (!response || response.status < 200 || response.status >= 300) return false;
  const type = response.headers.get('content-type') || '';
  if (!/json/i.test(type)) return false;
  try { return JSON.parse(raw)?.isSuccess === true; } catch { return false; }
}

async function readBack(input, options = {}) {
  const next = await buildContext(input, options);
  return { metadata: next.metadata, relation: next.relation, client: next.context.client, fetchImpl: next.context.fetchImpl };
}

export async function executeNaverAction(input, options = {}) {
  return withNaverSessionLock(() => execute(input, options));
}

async function execute(input, options) {
  const built = await buildContext(input, options);
  const { spec, context, form, metadata } = built;
  try {
    if (!metadata.ready) return { ...metadata, status: 'blocked', success: false, mutationCount: 0, writeSent: false };
    if (metadata.noOp) return { ...metadata, status: 'no_op', success: true, readbackVerified: true, needs_reconciliation: false,
      mutationCount: 0, afterState: metadata.currentState };
    if (typeof options.beforeWrite !== 'function') fail('SOCIAL_JOURNAL_REQUIRED');
    if (spec.operation === 'request' && !form) fail('NAVER_FORM_SCHEMA_CHANGED');
    const body = spec.operation === 'neighbor' && !spec.groupId
      ? new URLSearchParams({ blogId: spec.target }) : form.body;
    const responsePlan = { ...metadata, request: { ...metadata.request } };
    const post = preparePost(context, responsePlan, body);
    const journal = await options.beforeWrite(metadata);
    if (journal === false) fail('SOCIAL_JOURNAL_REJECTED');
    const response = await dispatchPost(context, post);
    let responseText = '';
    let responseReceived = Boolean(response);
    if (response) {
      responseText = await readBoundedResponseText(response);
      try {
        const writeOrigin = responsePlan.request.path === '/BuddyAddAsync.naver' ? BLOG_ORIGIN : ADMIN_ORIGIN;
        context.client.acceptResponse(response, new URL(responsePlan.request.path, writeOrigin).href);
      } catch { /* readback remains authoritative */ }
      try { await context.client.persistVerifiedSession(); } catch { /* readback remains authoritative */ }
    }
    let readback = null;
    try { readback = await readBack(input, options); } catch { readback = null; }
    const desired = readback && (spec.operation === 'neighbor'
      ? readback.relation.state.neighbor
      : readback.relation.state.mutual || readback.relation.state.pending);
    if (readback?.client) readback.client.clear();
    const responseVerified = responsePlan.request.path === '/BuddyAddAsync.naver'
      && parseNormalResponse(response, responseText);
    if (desired) {
      return { ...metadata, status: 'succeeded', success: true, needs_reconciliation: false, mutationCount: 1,
        readbackVerified: true, credential_propagated_for_write: responseVerified, responseVerified,
        reconciledAfterAmbiguousResponse: !responseVerified, live_replay: true,
        currentState: readback.relation.state, afterState: readback.relation.state,
        write: { httpStatus: response?.status ?? null, mime: response?.headers.get('content-type')?.split(';')[0] || null,
          responseReceived },
        readReceipt: { method: 'GET', path: '/BuddyListManage.naver', source: 'independent_buddy_and_invite_readback', httpStatus: 200,
          ownerVerified: true, live_replay: true } };
    }
    return { ...metadata, status: 'outcome_unknown', success: false, needs_reconciliation: true, mutationCount: 1,
      readbackVerified: false, live_replay: false, writeSent: true, responseVerified, reconciledAfterAmbiguousResponse: !responseVerified,
      write: { httpStatus: response?.status ?? null, responseReceived },
      ...(readback ? { currentState: readback.relation.state } : {}) };
  } finally { context.client.clear(); }
}
