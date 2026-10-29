// ChatGPT web (chatgpt.com) image generation through the logged-in browser over CDP. Observed 2026-10-29.
//   node scripts/chatgpt-image.mjs <out.png> --prompt="..." [--target=phone|pc] [--cdp=http://127.0.0.1:PORT] [--timeout=300] [--probe] [--keep-tab]
//   node scripts/chatgpt-image.mjs --quota [--target=phone|pc] [--cdp=http://127.0.0.1:PORT]
//   --target=phone (default): runs `adb forward tcp:9471 localabstract:chrome_devtools_remote`; CDP = http://127.0.0.1:9471.
//   --target=pc: CDP = http://127.0.0.1:9333 (the PC automation Canary). The phone is never forwarded onto 9333.
//   --cdp overrides the endpoint; with --cdp the adb forward is skipped.
//   --probe: print {url, loggedIn, composer} and exit. Does not send anything.
//   --quota: print {imageGen: {remaining, resetAfter}} from POST /backend-api/conversation/init. Sends nothing.
// Tabs: --target=pc opens its own tab on https://chatgpt.com/ and closes it at the end (--keep-tab leaves it open).
//   --target=phone (no --cdp) reuses an open chatgpt.com tab, or starts Chrome via adb if there is none, navigates it to
//   https://chatgpt.com/ for a fresh chat, and leaves it open. The phone's Chrome refuses PUT /json/new. Other tabs are never touched.
// Login is done by the owner on the device. This script does not log in, export cookies, or print tokens.
//
// Sending stays in the page UI. The send call needs sentinel proof-of-work, a Turnstile token and a browser collector,
//   which this script does not produce (see references/chatgpt-web-image-2026-10-29.md, "왜 전송만 UI인가").
// Flow: a real CDP mouse click focuses the composer (focus() and execCommand do not work without user activation on the phone),
//   Input.insertText types the prompt, a real CDP click presses send. Then:
//   1. URL becomes /c/<id>. Poll GET /backend-api/conversations/<id> every 5 s, run inside the page with the page's own session
//      token, until a finished image-tool message carries an image_asset_pointer (contract path).
//   2. Download inside the page: GET /backend-api/files/download/<file_id> -> download_url -> bytes -> data URL.
//   DOM fallback: if the contract shows nothing for 30 s after a complete generated <img> appears, that <img> blob: URL is used.
// Output: one JSON line on stdout {out, bytes, mime, width, height, sizeBytes, fileId (redacted), via, conversationPath}.
// Exit codes: 0 ok, 2 usage, 3 NOT_LOGGED_IN, 4 generation / timeout / other failure.
// The XHR contracts for conversation read, file download and conversation/init are in service-packs/chatgpt/contracts/registry.json.
// The send itself is not replayed (service-packs/chatgpt/discovery/xhr-capture-2026-10-29.json records its shape only).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, conversationIdFromPath, decodeDataUrl, findGeneratedImages, imageGenLimit, parseArgs, redactFileId, selectImageCandidate,
} from '../lib/chatgpt-web-image.mjs';

const CHATGPT_URL = 'https://chatgpt.com/';
const PHONE_FORWARD_PORT = 9471;
const CONTRACT_FALLBACK_MS = 30000;
const POLL_MS = 5000;
const INIT_BODY = { conversation_id: null, conversation_origin: null, gizmo_id: null, requested_default_model: null, system_hints: null, timezone: 'Asia/Seoul', timezone_offset_min: -540 };
const USAGE = 'usage: chatgpt-image.mjs <out.png> --prompt="..." [--target=phone|pc] [--cdp=http://127.0.0.1:PORT] [--timeout=300] [--probe] [--keep-tab]\n       chatgpt-image.mjs --quota [--target=phone|pc] [--cdp=http://127.0.0.1:PORT]';
const log = (m) => process.stderr.write(`[chatgpt-image] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ScriptError extends Error {
  constructor(code, message, exitCode = 4) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const COMPOSER = `document.querySelector('form [contenteditable="true"]')`;
const SEND_SELECTORS = ['[data-testid="send-button"]', '#composer-submit-button', 'form button[aria-label="보내기"]', 'form button[aria-label*="Send"]'];
// First matching selector wins; returns the center point only when the button is enabled.
const SEND_POINT = `(() => { for (const s of ${JSON.stringify(SEND_SELECTORS)}) { const b = document.querySelector(s); if (!b) continue; if (b.disabled || b.getAttribute('aria-disabled') === 'true') return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } return null; })()`;
const COMPOSER_POINT = `(() => { const e = ${COMPOSER}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
const STATE = `({ url: location.href, ready: document.readyState === 'complete', loggedIn: !document.querySelector('[data-testid="login-button"]'), composer: !!${COMPOSER} })`;
const IMAGE_CANDIDATES = `[...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 512).map((i) => ({ src: i.currentSrc || i.src, alt: i.alt || '', w: i.naturalWidth, h: i.naturalHeight, complete: i.complete, previewParent: !!i.closest('[data-testid="generated-image-preview"]') }))`;
const BUSY = `!!document.querySelector('[data-testid="stop-button"], button[aria-label*="중지"], button[aria-label*="Stop"]')`;
const LAST_ASSISTANT_TEXT = `(() => { const a = [...document.querySelectorAll('[data-message-author-role="assistant"]')]; return a.length ? a[a.length - 1].innerText : ''; })()`;

// ---- in-page HTTP. Every request runs inside the chatgpt.com page; the session token is read there and never returned. ----
const SESSION_TOKEN = `const token = (await (await fetch('/api/auth/session', { credentials: 'include' })).json()).accessToken; if (!token) throw new Error('NO_SESSION');`;
const BLOB_TO_DATA_URL = `(b) => new Promise((resolve, reject) => { const f = new FileReader(); f.onload = () => resolve(f.result); f.onerror = () => reject(f.error); f.readAsDataURL(b); })`;

// Returns the parsed JSON body of a same-origin backend-api call.
function pageJsonExpr(pathname, { method = 'GET', body } = {}) {
  const init = `{ method: ${JSON.stringify(method)}, credentials: 'include', headers: { accept: 'application/json', authorization: 'Bearer ' + token${body === undefined ? '' : ", 'content-type': 'application/json'"} }${body === undefined ? '' : `, body: ${JSON.stringify(JSON.stringify(body))}`} }`;
  return `(async () => { ${SESSION_TOKEN} const r = await fetch(${JSON.stringify(pathname)}, ${init}); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })()`;
}

// Resolves a file id to its download_url inside the page, fetches the bytes, and returns a data URL.
function downloadFileExpr(fileId, conversationId) {
  const meta = `/backend-api/files/download/${encodeURIComponent(fileId)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`;
  return `(async () => { ${SESSION_TOKEN} const m = await (await fetch(${JSON.stringify(meta)}, { credentials: 'include', headers: { accept: 'application/json', authorization: 'Bearer ' + token } })).json(); if (m.status !== 'success' || !m.download_url) throw new Error('download status ' + m.status); const r = await fetch(m.download_url, { credentials: 'include' }); if (!r.ok) throw new Error('HTTP ' + r.status); return (${BLOB_TO_DATA_URL})(await r.blob()); })()`;
}

// Downloads the DOM-picked image from inside the page (blob: URL) and returns the data URL.
function readImageExpr(src) {
  return `fetch(${JSON.stringify(src)}).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then((${BLOB_TO_DATA_URL}))`;
}

// Minimal CDP client over the global WebSocket.
async function openCdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new ScriptError('CDP_CONNECT_FAILED', 'WebSocket connect failed'));
  });
  let seq = 0;
  const pending = new Map();
  const listeners = new Map(); // CDP event name -> one-shot resolvers
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method && listeners.has(m.method)) {
      for (const notify of listeners.get(m.method)) notify(m.params);
      listeners.delete(m.method);
    }
  };
  // Resolves on the next occurrence of a CDP event, or rejects after timeoutMs.
  const nextEvent = (method, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScriptError('CDP_TIMEOUT', `no ${method} within ${timeoutMs / 1000} s`)), timeoutMs);
    const list = listeners.get(method) || [];
    list.push((params) => { clearTimeout(timer); resolve(params); });
    listeners.set(method, list);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new ScriptError('CDP_TIMEOUT', `CDP timeout: ${method}`)); }, 60000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) {
      const d = m.result.exceptionDetails;
      const text = (d.exception?.description || d.text || '').slice(0, 200);
      if (/NO_SESSION/.test(text)) throw new ScriptError('NOT_LOGGED_IN', 'no ChatGPT session in the page (login is not automated)', 3);
      throw new ScriptError('JS_ERROR', `JS: ${text}`);
    }
    return m.result?.result?.value;
  };
  return { send, ev, nextEvent, close: () => ws.close() };
}

// Real mouse click at the center of the point returned by `pointExpr`. Returns false when there is no point.
async function clickPoint(cdp, pointExpr) {
  const p = await cdp.ev(pointExpr);
  if (!p) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  return true;
}

// Polls fn until it returns a truthy value or the time runs out. Returns the value, or null.
async function waitValue(fn, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(500);
  }
}

async function listChatgptTabs(cdpBase) {
  const list = await (await fetch(`${cdpBase}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith(CHATGPT_URL));
}

// Reuses an open chatgpt.com tab; if there is none, starts Chrome on the phone and waits up to 20 s for one.
async function acquirePhoneTab(cdpBase) {
  const existing = await listChatgptTabs(cdpBase);
  if (existing.length) return existing[0];
  const r = spawnSync('adb', ['shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main', '-a', 'android.intent.action.VIEW', '-d', CHATGPT_URL], { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new ScriptError('ADB_START_FAILED', (r.stderr || r.error?.message || '').trim());
  log('no chatgpt.com tab on the phone; started Chrome and waiting for one');
  const until = Date.now() + 20000;
  for (;;) {
    const tabs = await listChatgptTabs(cdpBase).catch(() => []);
    if (tabs.length) return tabs[0];
    if (Date.now() > until) throw new ScriptError('NO_PHONE_TAB', 'no chatgpt.com tab on the phone after 20 s');
    await sleep(500);
  }
}
// Each phone run starts a fresh chat: navigate, then wait for the new document load event (30 s).
// A same-document navigation (no loaderId) fires no load event, so nothing is awaited. generate() polls for the composer after this.
async function navigateFresh(cdp) {
  await cdp.send('Page.enable');
  const loaded = cdp.nextEvent('Page.loadEventFired', 30000);
  const r = await cdp.send('Page.navigate', { url: CHATGPT_URL });
  if (r.result?.errorText) throw new ScriptError('NAVIGATE_FAILED', r.result.errorText);
  if (r.result?.loaderId) await loaded;
  else loaded.catch(() => {});
}

async function waitForComposer(cdp) {
  const until = Date.now() + 30000;
  for (;;) {
    const state = await cdp.ev(STATE);
    if ((state.ready && state.composer) || Date.now() > until) return state;
    await sleep(500);
  }
}

async function quota(cdp) {
  const state = await waitForComposer(cdp);
  if (!state.loggedIn || !state.composer) throw new ScriptError('NOT_LOGGED_IN', 'log in on the device first (login is not automated)', 3);
  const init = await cdp.ev(pageJsonExpr('/backend-api/conversation/init', { method: 'POST', body: INIT_BODY }));
  console.log(JSON.stringify({ imageGen: imageGenLimit(init) }));
  return 0;
}

async function generate(cdp, opts) {
  const state = await waitForComposer(cdp);
  if (opts.probe) {
    console.log(JSON.stringify({ url: state.url, loggedIn: state.loggedIn, composer: state.composer }));
    return 0;
  }
  if (!state.loggedIn || !state.composer) throw new ScriptError('NOT_LOGGED_IN', 'log in on the device first (login is not automated)', 3);

  const before = (await cdp.ev(IMAGE_CANDIDATES)).map((c) => c.src);
  if (!(await clickPoint(cdp, COMPOSER_POINT))) throw new ScriptError('TYPE_FAILED', 'composer not found');
  await sleep(600);
  if (!(await cdp.ev(`document.activeElement === ${COMPOSER}`))) throw new ScriptError('TYPE_FAILED', 'composer did not take focus from the CDP click');
  await cdp.send('Input.insertText', { text: opts.prompt });
  await sleep(1200);
  if (!((await cdp.ev(`(${COMPOSER})?.innerText.trim().length || 0`)) > 0)) throw new ScriptError('TYPE_FAILED', 'composer is still empty after insertText');

  // the send button appears only once the composer has text
  if (!(await waitValue(() => cdp.ev(SEND_POINT), 10000)) || !(await clickPoint(cdp, SEND_POINT))) {
    throw new ScriptError('SEND_BUTTON_NOT_FOUND', 'send button missing or disabled');
  }
  log('sent; waiting for the image (usually 60-75 s)');

  const deadline = Date.now() + opts.timeoutSec * 1000;
  let conversationId = null;
  let contractError = null;
  let image = null; // contract path: {fileId, width, height, sizeBytes}
  let domPick = null; // DOM fallback: {src, w, h}
  let domSince = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    conversationId = conversationId || conversationIdFromPath(await cdp.ev('location.pathname'));
    if (conversationId) {
      try {
        const found = findGeneratedImages(await cdp.ev(pageJsonExpr(`/backend-api/conversations/${encodeURIComponent(conversationId)}`)));
        if (found.length) {
          image = found[found.length - 1];
          break;
        }
      } catch (e) {
        if (!(e instanceof ScriptError) || e.exitCode === 3) throw e;
        if (contractError !== e.message) log(`contract poll: ${e.message}`);
        contractError = e.message;
      }
    }
    const candidates = await cdp.ev(IMAGE_CANDIDATES);
    const busy = await cdp.ev(BUSY);
    const pick = busy ? null : selectImageCandidate(candidates.filter((c) => c.complete), before);
    if (pick) {
      domPick = pick;
      domSince = domSince ?? Date.now();
      if (Date.now() - domSince >= CONTRACT_FALLBACK_MS) break;
    } else {
      domSince = null;
    }
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  let dataUrl;
  let via;
  let meta;
  if (image) {
    via = 'contract';
    dataUrl = await cdp.ev(downloadFileExpr(image.fileId, conversationId));
    meta = { width: image.width, height: image.height, sizeBytes: image.sizeBytes, fileId: redactFileId(image.fileId) };
  } else if (domPick) {
    via = 'dom';
    dataUrl = await cdp.ev(readImageExpr(domPick.src));
    meta = { width: domPick.w, height: domPick.h, sizeBytes: null, fileId: null };
  } else {
    const last = String((await cdp.ev(LAST_ASSISTANT_TEXT)) || '').slice(0, 200);
    throw new ScriptError('NO_IMAGE', `no generated image before the timeout${contractError ? ` (last contract error: ${contractError})` : ''}; last assistant text: ${last}`);
  }

  const { mime, bytes } = decodeDataUrl(dataUrl);
  if (!mime.startsWith('image/')) throw new ScriptError('DOWNLOAD_FAILED', `unexpected mime ${mime}`);
  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bytes);
  const conversationPath = await cdp.ev('location.pathname');
  console.log(JSON.stringify({ out: outPath, bytes: bytes.length, mime, ...meta, via, conversationPath }));
  return 0;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }

  if (opts.target === 'phone' && !opts.cdpOverride) {
    const r = spawnSync('adb', ['forward', `tcp:${PHONE_FORWARD_PORT}`, 'localabstract:chrome_devtools_remote'], { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      log(`ADB_FORWARD_FAILED: ${(r.stderr || r.error?.message || '').trim()}`);
      return 4;
    }
  }

  // Phone (no --cdp override): PUT /json/new is refused by the phone's Chrome, so an existing chatgpt.com tab is reused and left open.
  // PC and --cdp overrides: the script opens its own tab and closes it at the end.
  const reusePhoneTab = opts.target === 'phone' && !opts.cdpOverride;
  let created = null;
  let cdp = null;
  let code = 0;
  try {
    let target;
    if (reusePhoneTab) {
      target = await acquirePhoneTab(opts.cdp);
    } else {
      created = await (await fetch(`${opts.cdp}/json/new?${encodeURIComponent(CHATGPT_URL)}`, { method: 'PUT' })).json();
      target = created;
    }
    // the host reported by the browser can differ from the endpoint we reached (adb forward), so keep the endpoint's host
    const wsUrl = new URL(target.webSocketDebuggerUrl);
    wsUrl.host = new URL(opts.cdp).host;
    cdp = await openCdp(wsUrl.toString());
    if (opts.quota) {
      code = await quota(cdp);
    } else {
      if (reusePhoneTab && !opts.probe) await navigateFresh(cdp);
      code = await generate(cdp, opts);
    }
  } catch (e) {
    if (e instanceof ScriptError) {
      log(`${e.code}: ${e.message}`);
      code = e.exitCode;
    } else {
      log(`UNEXPECTED: ${e.message}`);
      code = 4;
    }
  } finally {
    cdp?.close();
    if (created && !opts.keepTab) await fetch(`${opts.cdp}/json/close/${created.id}`).catch(() => {});
  }
  return code;
}

process.exitCode = await main();
