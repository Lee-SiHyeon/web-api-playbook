// Naver blog draft through SmartEditor ONE's own paste path, in the logged-in automation Canary (CDP 9333).
// Browser-assisted on purpose: the hybrid HTTP publisher is restricted to editing existing posts, and the editor
// converts pasted HTML into its own components (quotation, table, horizontalLine, image), so a paste gives a real
// SmartEditor document without reproducing its document model by hand.
//
//   node scripts/naver-se-paste.mjs login                          -> types the DPAPI Naver identity into nid login (never printed)
//   node scripts/naver-se-paste.mjs draft <blogId> <title.txt> <body.html> [--keep-draft]
//        opens /<blogId>/postwrite, discards (or keeps) the autosaved draft, types the title, Enter, pastes body.html,
//        saves the draft and prints the component/image/link counts. Does NOT publish.
//   node scripts/naver-se-paste.mjs publish <blogId> --category=<name> --tags=<a,b,c> [--confirm]
//        opens the publish panel on the current editor tab, picks the category, enters tags; clicks 발행 only with --confirm.
//
// Observed 2026-10-19 (blog aicandoanything). See references/naver-smarteditor-paste.md for the style matrix.
//  - Paste = a synthetic ClipboardEvent('paste') with a DataTransfer (text/html + text/plain) on the focused element;
//    the editor handles it (defaultPrevented=true) and builds components.
//  - Title first, then Enter: the Enter moves focus into the body. Clicking the body placeholder after a long title
//    can land in the title and the whole body becomes the title.
//  - Write title/body files as UTF-8 from Node or Python; text piped through the Windows console (cp949) arrives garbled.
//  - Remote <img src="https://..."> is accepted on paste (lazy svg placeholders until scrolled).
//  - The "작성 중인 글이 있습니다" dialog appears when an autosaved draft exists: 취소 = start fresh, 확인 = continue it.
//  - Category: click the dropdown, then click the <label> of the item (clicking the text span did not stick).
//  - Tags: one tag per insertText + Enter, max 30.
//  - Sub-categories are listed as "ㄴ 태국" (accessible name "하위 카테고리 태국"); --category matches the bare name.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CDP = process.env.NAVER_SE_CDP || 'http://127.0.0.1:9333';
const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const args = rest.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab(url, reuse) {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  let t = reuse ? list.find((x) => x.type === 'page' && reuse(x.url)) : null;
  if (!t) t = await (await fetch(`${CDP}/json/new?${url}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let n = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'EVAL'); return m.result?.result?.value; };
  const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
  const type = (text) => send('Input.insertText', { text });
  const waitFor = async (expr, ms = 20000) => { for (let k = 0; k < ms / 300; k++) { if (await ev(expr).catch(() => false)) return true; await sleep(300); } throw new Error('TIMEOUT ' + expr.slice(0, 80)); };
  return { t, ws, send, ev, click, key, type, waitFor, close: () => ws.close() };
}
const centerOf = (sel) => `(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [Math.round(b.x + Math.min(40, b.width / 2)), Math.round(b.y + b.height / 2)]; })()`;

try {
  if (cmd === 'login') {
    const idMod = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '../service-packs/naver/apps/naver-blog-api/scripts/naver-login-identity.mjs');
    const { loadNaverLoginIdentity } = await import(pathToFileURL(idMod).href);
    const T = await tab('https://nid.naver.com/nidlogin.login?mode=form');
    await T.waitFor(`!!document.querySelector('#id') && !!document.querySelector('#pw')`);
    const ident = await loadNaverLoginIdentity();
    for (const [sel, val] of [['#id', ident.id ?? ident.username ?? ident.loginId], ['#pw', ident.password ?? ident.pw]]) {
      await T.ev(`(() => { const e = document.querySelector('${sel}'); e.focus(); e.value = ''; return 1; })()`);
      for (const ch of val) { await T.type(ch); await sleep(40 + Math.random() * 60); }
    }
    const btn = await T.ev(centerOf(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === '로그인')`));
    await T.click(...btn); await sleep(6000);
    const state = await T.ev(`({ url: location.href.slice(0, 80), captcha: !!document.querySelector('#captcha, #captchaimg, [id*=captcha] img') })`);
    console.log(JSON.stringify({ ok: !/nidlogin/.test(state.url), ...state, note: state.captcha ? 'captcha shown: read the image in a screenshot and answer it in the page' : undefined }));
    T.close();
  } else if (cmd === 'draft') {
    const [blogId, titleFile, bodyFile] = args;
    const title = fs.readFileSync(titleFile, 'utf8').trim(); const html = fs.readFileSync(bodyFile, 'utf8');
    const T = await tab(`https://blog.naver.com/${blogId}/postwrite`);
    await T.waitFor(`!!document.querySelector('.se-documentTitle')`, 30000); await sleep(2000);
    const pick = opt['keep-draft'] ? '확인' : '취소';
    await T.ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === '${pick}' && b.closest('[class*=popup]')); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
    const tp = await T.ev(centerOf(`document.querySelector('.se-documentTitle .se-text-paragraph')`));
    await T.click(...tp); await sleep(300); await T.type(title); await sleep(300); await T.key('Enter', 'Enter', 13); await sleep(700);
    const pasted = await T.ev(`(() => { const html = ${JSON.stringify(html)};
      const plain = html.replace(/<br\\s*\\/?>/g, '\\n').replace(/<\\/(p|h2|h3|li|tr)>/g, '\\n').replace(/<[^>]+>/g, '');
      let el = document.activeElement; if (el && el.tagName === 'IFRAME') el = el.contentDocument.activeElement || el.contentDocument.body;
      const dt = new DataTransfer(); dt.setData('text/html', html); dt.setData('text/plain', plain);
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; })()`);
    await sleep(8000);
    const stats = await T.ev(`({ title: document.querySelector('.se-documentTitle').innerText.trim().slice(0, 80),
      components: [...document.querySelectorAll('.se-component')].map(c => c.className.split(' ')[1]).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}),
      images: [...document.querySelectorAll('.se-component img')].length, links: document.querySelectorAll('.se-component a').length })`);
    const save = await T.ev(centerOf(`[...document.querySelectorAll('button')].find(b => b.offsetParent && /^저장/.test(b.innerText.trim()))`));
    if (save) { await T.click(...save); await sleep(2500); }
    console.log(JSON.stringify({ ok: pasted && stats.title === title.slice(0, 80), pasteHandled: pasted, ...stats, draftSaved: !!save, targetId: T.t.id }));
    T.close();
  } else if (cmd === 'publish') {
    const [blogId] = args;
    const T = await tab('about:blank', (u) => u.startsWith(`https://blog.naver.com/${blogId}/postwrite`));
    const pub = await T.ev(centerOf(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim().startsWith('발행'))`));
    await T.click(...pub); await sleep(2000);
    if (opt.category) {
      const dd = await T.ev(centerOf(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.closest('[class*=publish]') && /카테고리|category/i.test(b.getAttribute('aria-label') || b.className))`));
      if (dd) { await T.click(...dd); await sleep(1000); }
      const ok = await T.ev(`(() => { const want = ${JSON.stringify(opt.category)}; const norm = (t) => t.split(String.fromCharCode(10)).pop().replace('ㄴ', '').trim(); const c = [...document.querySelectorAll('label, span, li, button')].filter(e => e.offsetParent && norm(e.innerText.trim()) === want);
        c.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length); const t = c[0]; if (!t) return false; (t.closest('label') || t).click(); return true; })()`);
      if (!ok) throw new Error('CATEGORY_NOT_FOUND');
    }
    if (opt.tags) {
      await T.ev(`(() => { const i = [...document.querySelectorAll('input')].find(e => /태그/.test(e.placeholder || '')); i.focus(); return 1; })()`);
      for (const tag of String(opt.tags).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30)) { await T.type(tag); await T.key('Enter', 'Enter', 13); await sleep(150); }
    }
    let url = null;
    if (opt.confirm) {
      const go = await T.ev(centerOf(`[...document.querySelectorAll('button')].filter(b => b.offsetParent && b.innerText.trim() === '발행').pop()`));
      await T.click(...go); await sleep(6000); url = await T.ev('location.href');
    }
    console.log(JSON.stringify({ ok: true, published: !!opt.confirm, url }));
    T.close();
  } else {
    console.error('usage: naver-se-paste.mjs login | draft <blogId> <title.txt> <body.html> [--keep-draft] | publish <blogId> --category= --tags= [--confirm]');
    process.exitCode = 2;
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exitCode = 2;
}
