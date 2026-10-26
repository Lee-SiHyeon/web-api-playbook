// Threads / X post through their own web composer in the logged-in automation Canary (CDP 9333); own tab, closed at the end.
// 2026-10-23 (kwak Macau): the HTTP clients (sns-threads, sns-X) have no verified media publish, so promo posts with media go
// through the web UI here. Media goes straight into the composer's <input type=file> (DOM.setFileInputFiles), no chooser.
//   node scripts/sns-web-post.mjs threads|x <text.txt> [media1,media2] [--dry] [--shots=<dir>] [--schedule=<time>]
// --schedule accepts offset ISO or Node-local time (the browser offset must match for local input).
// Only a confirmed numeric date/time is submitted. Schedule submission remains unconfirmed until
// the account's Scheduled list is read back; it is never labeled published or automatically retried.
// --dry stops before submission. Uncertain results preserve the task tab for reconciliation.
import fs from 'node:fs';
import path from 'node:path';
import { parseScheduleTime, applySchedule, xReadLine, thCheckLine } from '../lib/sns-schedule.mjs';
import { submitOnce, verifyOwnPostReadback } from '../lib/sns-submit.mjs';

const CDP = process.env.SNS_CDP || 'http://127.0.0.1:9333';
const [site, textFile, mediaArg, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries([mediaArg, ...rest].filter((a) => a && a.startsWith('--')).map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const media = mediaArg && !mediaArg.startsWith('--') ? mediaArg.split(',').map((f) => path.resolve(f)) : [];
if (!['threads', 'x'].includes(site) || !textFile) { console.error('usage: sns-web-post.mjs threads|x <text.txt> [media,...] [--dry] [--shots=dir]'); process.exit(2); }
const text = fs.readFileSync(textFile, 'utf8').replace(/\r/g, '').trim();
const when = opt.schedule ? parseScheduleTime(opt.schedule) : null; // validated before any browser work
const shots = opt.shots || path.join(path.dirname(path.resolve(textFile)), `${site}-shots`); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = {
  threads: { url: 'https://www.threads.com/', // the feed's "새로운 소식을 공유해보세요" line does not open the dialog; the left nav "새로운 스레드" does
    open: `[...document.querySelectorAll('a, [role=button], [role=link]')].find((x) => /^(새로운 스레드|Create)$/.test((x.innerText || x.getAttribute('aria-label') || '').trim()) && x.getBoundingClientRect().width)`,
    editor: '[role=dialog] [contenteditable=true]', file: '[role=dialog] input[type=file]', post: /^(게시|Post|예약|Schedule)$/, /* 예약: the same button once a schedule is set */ scope: '[role=dialog]' },
  x: { url: 'https://x.com/compose/post', open: null, editor: '[data-testid="tweetTextarea_0"]', file: 'input[data-testid="fileInput"], input[type=file]', post: null, postSel: '[data-testid="tweetButton"]', scope: 'body' },
}[site];

const t = await (await fetch(`${CDP}/json/new?${SITE.url}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64')); };
const clickAt = async ([x, y]) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const center = (expr) => ev(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const out = { site, submissionAttempted: false, outcomeUnknown: false, needsReconciliation: false, ...(when ? { scheduled: false, scheduleRequestedFor: when.toISOString() } : {}) };
const scheduleIO = { sleep, click: clickAt, key: value => send('Input.insertText', { text: value }),
  selectAll: async () => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); },
  call: (fn, ...args) => ev(`(${fn})(...${JSON.stringify(args)})`) };
try {
  // Threads collapses its left menu to unlabeled icons below ~1400 px (the create icon has no aria-label): keep it wide
  await send('Emulation.setDeviceMetricsOverride', { width: site === 'threads' ? 1600 : 1300, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.bringToFront'); await send('DOM.enable');
  await sleep(9000);
  if (SITE.open) { let o = null; for (let i = 0; i < 20 && !o; i++) { o = await center(SITE.open); if (!o) await sleep(1000); } if (!o) { out.debug = await ev(`location.href + ' | ' + document.body.innerText.replace(/\s+/g, ' ').slice(0, 160)`); throw new Error('NO_COMPOSER_OPEN'); } await clickAt(o); await sleep(2500); }
  const ed = await center(`document.querySelector(${JSON.stringify(SITE.editor)})`); if (!ed) throw new Error('NO_EDITOR');
  await clickAt(ed); await sleep(500);
  // newlines: Shift+Enter keeps the composer open on both sites
  for (const [i, line] of text.split('\n').entries()) {
    if (i) for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    if (line) await send('Input.insertText', { text: line });
  }
  await sleep(1200);
  if (media.length) {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: SITE.file });
    if (!q.result?.nodeId) throw new Error('NO_FILE_INPUT');
    await send('DOM.setFileInputFiles', { files: media, nodeId: q.result.nodeId });
    await sleep(6000);
    // wait for upload/processing (video): the post button turns enabled
    for (let i = 0; i < 120; i++) {
      const ready = await ev(SITE.postSel ? `(() => { const b = document.querySelector(${JSON.stringify(SITE.postSel)}); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`
        : `(() => { const b = [...document.querySelectorAll(${JSON.stringify(SITE.scope + ' [role=button]')})].find((x) => ${SITE.post}.test((x.innerText || '').trim())); return !!b && b.getAttribute('aria-disabled') !== 'true'; })()`);
      // X: the upload ring lives inside [data-testid=attachments]; the composer's character counters are role=progressbar too
      // (always present), so a page-wide progressbar check never cleared and the loop always ran its full 6 minutes (2026-10-26)
      const busy = await ev(`(() => { const a = document.querySelector('[data-testid="attachments"]') || document.querySelector(${JSON.stringify(SITE.scope)});
        return !!a?.querySelector('[role=progressbar], [data-testid="progressBar"]') || /업로드 중|Uploading|처리 중|Processing/.test(a?.innerText || ''); })()`);
      if (ready && !busy) break;
      await sleep(3000);
    }
  }
  // X: text ending in a #hashtag leaves the hashtag typeahead open, and its transparent full-viewport mask sits over Post,
  // so every click (CDP and OS) only dismissed the dropdown: the cause of every COMPOSER_STILL_OPEN (CDP-observed 2026-10-26;
  // with the mask gone, one CDP click sends CreateTweet with the video media_id). The listbox can already be gone while its
  // empty mask stays, so don't key on the listbox: always type a trailing space (it closes the typeahead and removes the mask),
  // after the media upload so a late typeahead re-render cannot bring it back.
  if (site === 'x') {
    await send('Input.insertText', { text: ' ' });
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (await ev(`(() => { const b = document.querySelector(${JSON.stringify(SITE.postSel)}); if (!b) return false; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && b.contains(e); })()`)) break;
    }
  }
  if (when) {
    parseScheduleTime(when.getTime()); // media preparation may have consumed the minimum lead time
    const selected = await applySchedule(site, when, scheduleIO);
    out.scheduleConfirmationLine = selected.line;
    out.schedulePrepared = true;
  }
  out.typed = await ev(`(document.querySelector(${JSON.stringify(SITE.editor)})?.innerText || '').length`);
  await shot(`${site}-1-filled`);
  if (opt.dry) {
    out.dry = true;
    if (SITE.postSel) out.postOnTop = await ev(`(() => { const b = document.querySelector(${JSON.stringify(SITE.postSel)}); if (!b) return false; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && b.contains(e); })()`);
  }
  else {
    const pb = await center(SITE.postSel ? `document.querySelector(${JSON.stringify(SITE.postSel)})` : `[...document.querySelectorAll(${JSON.stringify(SITE.scope + ' [role=button]')})].filter((x) => ${SITE.post}.test((x.innerText || '').trim())).pop()`);
    if (!pb) throw new Error('NO_POST_BUTTON');
    const postExpr = SITE.postSel ? `document.querySelector(${JSON.stringify(SITE.postSel)})` : `[...document.querySelectorAll(${JSON.stringify(SITE.scope + ' [role=button]')})].filter((x) => ${SITE.post}.test((x.innerText || '').trim())).pop()`;
    const activeAccount = `(() => { const a = [...document.querySelectorAll('a[href^="/@"], a[data-testid="AppTabBar_Profile_Link"]')].find((x) => /프로필|Profile/.test(x.getAttribute('aria-label') || x.innerText || '') || x.dataset.testid === 'AppTabBar_Profile_Link'); return a ? a.getAttribute('href').replace(/^\\//, '') : null; })()`;
    const accountBeforeClick = await ev(activeAccount);
    if (!accountBeforeClick) {
      throw new Error('POST_ACCOUNT_UNVERIFIED');
    }
    const expectedTextLiteral = JSON.stringify(text);
    const candidatesExpr = site === 'x'
      ? `(() => [...document.querySelectorAll('article')].flatMap(article => {
          const body = [...article.querySelectorAll('[data-testid="tweetText"]')].map(x => x.innerText).filter(Boolean).join('\\n');
          const links = [...new Set([...article.querySelectorAll('a[href*="/status/"]')].map(x => x.href).filter(Boolean))];
          const time = article.querySelector('time[datetime]')?.getAttribute('datetime') || null;
          return links.map(url => ({ url, text: body, createdAt: time }));
        }))()`
      : `(() => [...document.querySelectorAll('article,[role="article"]')].flatMap(article => {
          const body = [...article.querySelectorAll('[dir="auto"]')].map(x => x.innerText)
            .find(x => typeof x === 'string' && x.trim() === ${expectedTextLiteral});
          if (!body) return [];
          const links = [...new Set([...article.querySelectorAll('a[href*="/post/"]')].map(x => x.href).filter(Boolean))];
          const time = article.querySelector('time[datetime]')?.getAttribute('datetime') || null;
          return links.map(url => ({ url, text: body, createdAt: time }));
        }))()`;
    // Snapshot visible own-post URLs before sending. The new readback excludes
    // these so an older identical post cannot be mistaken for this submission.
    const beforeCandidates = when ? [] : await ev(candidatesExpr);
    if (!Array.isArray(beforeCandidates) || beforeCandidates.length > 500) {
      out.outcome = 'not_submitted';
      throw new Error('POST_READBACK_BASELINE_UNAVAILABLE');
    }
    const beforeUrls = beforeCandidates.map(row => row?.url).filter(url => typeof url === 'string');
    const attemptedAt = Date.now();
    const outcome = await submitOnce({
      state: out,
      preflight: async () => {
        if (when) {
          parseScheduleTime(when.getTime());
          const label = await ev(`(${postExpr})?.innerText?.trim()`);
          if (!/^(Schedule|예약)$/.test(label || '')) return { ok: false, reason: 'SCHEDULE_BUTTON_NOT_READY' };
          const confirmed = site === 'x'
            ? await scheduleIO.call(xReadLine) === when.getTime()
            : (await scheduleIO.call(thCheckLine, when.getTime()))?.ok === true;
          if (!confirmed) return { ok: false, reason: 'SCHEDULE_SELECTION_CHANGED' };
        }
        const onTop = await ev(`(() => { const b = ${postExpr}; if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && b.contains(e); })()`);
        if (onTop) return true;
        out.cover = await ev(`(() => { const b = ${postExpr}; if (!b) return null; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e ? e.tagName + ' ' + (e.parentElement?.innerText || '').slice(0, 80) : null; })()`);
        return { ok: false, reason: 'POST_BUTTON_COVERED' };
      },
      submit: async () => clickAt(pb), // exactly one submit action; ambiguous CDP results are never replayed
      readback: async () => {
        // No verified Scheduled-list reader is available here. Keep the intent
        // unresolved rather than mistaking a closed composer for persistence.
        if (when) return { outcome: 'outcome_unknown', reason: 'SCHEDULE_QUEUE_READBACK_REQUIRED' };
        const open = site === 'x'
          ? await ev(`location.pathname.startsWith('/compose/') || !!document.querySelector('[role=dialog] ${SITE.editor}')`)
          : await ev(`!!document.querySelector(${JSON.stringify(SITE.editor)})`);
        if (open) return { outcome: 'outcome_unknown', reason: 'COMPOSER_STILL_OPEN' };
        // Threads continues video processing after the dialog closes. Keep waiting for
        // a post row instead of treating the closed dialog as a successful publish.
        if (site === 'threads' && /게시 중|Posting/.test(await ev('document.body.innerText'))) {
          return { outcome: 'outcome_unknown', reason: 'THREADS_POST_PROCESSING' };
        }
        const visiblePosts = await ev(candidatesExpr);
        return verifyOwnPostReadback({ site, account: accountBeforeClick, expectedText: text,
          attemptedAt, checkedAt: Date.now(), beforeUrls,
          candidates: Array.isArray(visiblePosts) ? visiblePosts : [] });
      },
      wait: async () => sleep(site === 'threads' ? 3000 : 2000),
      maxPolls: when ? 1 : site === 'threads' ? 80 : 45,
    });
    out.outcome = outcome.outcome;
    out.submissionAttempted = outcome.submissionAttempted === true;
    if (when) out.scheduleSubmissionAttempted = out.submissionAttempted;
    out.needsReconciliation = outcome.needsReconciliation === true;
    if (outcome.outcome === 'verified') {
      out.posted = true;
      out.account = site === 'threads' ? `@${outcome.account}` : outcome.account;
      out.url = outcome.url;
      out.postReadback = { status: 'exact_own_post_verified', checkedAt: new Date().toISOString(),
        textMatched: true, createdAt: outcome.createdAt };
      await shot(`${site}-2-posted-verified`);
    } else if (outcome.outcome === 'rejected') {
      out.posted = false; out.submissionAttempted = true;
      throw new Error(outcome.reason || 'POST_REJECTED');
    } else if (outcome.outcome === 'not_submitted') {
      out.posted = false; out.submissionAttempted = false;
      out.outcomeUnknown = false; out.needsReconciliation = false;
      throw new Error(outcome.reason || 'POST_PREFLIGHT_REJECTED');
    } else {
      out.posted = false; out.outcomeUnknown = true; out.needsReconciliation = true;
      out.reconciliationReason = when ? 'SCHEDULE_QUEUE_READBACK_REQUIRED' : outcome.reason || 'POST_READBACK_NOT_FOUND';
      await shot(`${site}-2-outcome-unknown`);
      throw new Error(when ? 'SCHEDULE_OUTCOME_UNKNOWN' : 'POST_OUTCOME_UNKNOWN');
    }

  }
} catch (e) { out.error = e.message; await shot(`${site}-error`).catch(() => {}); process.exitCode = 1; }
finally { const preserve = opt.keep || out.needsReconciliation === true; if (preserve) out.tab = t.id; console.log(JSON.stringify(out)); ws.close(); if (!preserve) await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
