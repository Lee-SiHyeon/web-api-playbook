// Post to a channel's community tab (게시물) from the channel page (2026-10-28, owner "ㅇㅇ 만들어" after the community research:
// faceless Shorts refs have no posts tab; the one news ref that posts (핫이슈ON 루나Ai) does image + one-line opinion every 1-2 days).
//   node scripts/youtube-community-post.mjs <channelId> <text.txt> [--poll="A|B|C"] [--image=<path>] [--shots=<dir>] [--dry]
// --poll  -> 텍스트 설문조사 with 2-5 options (≤65 chars each); --image -> 이미지 (one picture); neither -> text-only post.
// --dry   fills the form, screenshots it and clicks 취소 (nothing is posted).
// The active YouTube identity must own the channel (switch in Studio first, like youtube-studio.mjs ensureChannel); the script
// refuses when the page shows no creation box. Own Canary tab, closed at the end. Prints {ok, posted, text, poll, image}.
import fs from 'node:fs';
import path from 'node:path';
const [chId, file, ...flags] = process.argv.slice(2);
if (!chId || !file) { console.error('usage: youtube-community-post.mjs <channelId> <text.txt> [--poll="A|B"] [--image=path] [--shots=dir] [--dry]'); process.exit(2); }
const opt = Object.fromEntries(flags.filter((f) => f.includes('=')).map((f) => { const i = f.indexOf('='); return [f.slice(2, i), f.slice(i + 1)]; }));
const DRY = flags.includes('--dry');
const text = fs.readFileSync(file, 'utf8').trim();
const poll = opt.poll ? opt.poll.split('|').map((s) => s.trim()).filter(Boolean) : null;
if (poll && (poll.length < 2 || poll.length > 5 || poll.some((o) => [...o].length > 65))) { console.error('poll needs 2-5 options, ≤65 chars'); process.exit(2); }
const image = opt.image ? path.resolve(opt.image) : null;
const shotDir = opt.shots ?? null;
const CDP = 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = await (await fetch(CDP + '/json/new?' + `https://www.youtube.com/channel/${chId}/posts`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;
const shot = async (n) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, n + '.png'), Buffer.from(s.result.data, 'base64')); };
const clickBtn = (re) => ev(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].filter(x=>x.offsetParent).find(x=>${re}.test((x.innerText||x.getAttribute('aria-label')||'').trim()));if(!b)return false;b.click();return true})()`);
const out = { ok: false, posted: false, text, poll, image };
try {
  await send('Page.enable'); await send('DOM.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(7000);
  if (!(await ev(`!!document.querySelector('#contenteditable-root') || [...document.querySelectorAll('button,[role=button]')].some(b=>/텍스트 설문조사/.test(b.innerText||''))`))) throw new Error('NO_CREATION_BOX (wrong channel active?)');
  if (poll && !(await clickBtn('/^텍스트 설문조사$/'))) throw new Error('NO_POLL_BUTTON');
  if (image && !poll) {
    if (!(await clickBtn('/^이미지$/'))) throw new Error('NO_IMAGE_BUTTON'); await sleep(1500);
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
    const nodeId = q.result?.nodeIds?.at(-1); if (!nodeId) throw new Error('NO_FILE_INPUT');
    await send('DOM.setFileInputFiles', { nodeId, files: [image] }); await sleep(6000);
  }
  await sleep(1500);
  if (!(await ev(`(()=>{const e=[...document.querySelectorAll('#contenteditable-root')].find(x=>x.offsetParent);if(!e)return false;e.focus();return true})()`))) throw new Error('NO_EDITOR');
  for (const [i, line] of text.split(/\r?\n/).entries()) { if (i) await ev(`document.execCommand('insertLineBreak')`); if (line) await send('Input.insertText', { text: line }); }
  if (poll) {
    for (let i = 2; i < poll.length; i++) { await clickBtn('/^다른 옵션 추가$/'); await sleep(500); }
    for (const [i, o] of poll.entries()) {
      const ok = await ev(`(()=>{const ins=[...document.querySelectorAll('input')].filter(x=>x.offsetParent&&!/검색/.test(x.placeholder||'')&&!x.closest('#center'));const e=ins[${i}];if(!e)return false;e.focus();e.select&&e.select();return true})()`);
      if (!ok) throw new Error('NO_POLL_OPTION_' + i);
      await send('Input.insertText', { text: o }); await sleep(300);
    }
  }
  await sleep(1000); await shot('1-filled');
  if (DRY) { await clickBtn('/^취소$/'); await sleep(1500); await clickBtn('/^(삭제|취소|게시물 삭제)$/'); out.ok = true; out.dry = true; }
  else {
    const before = await ev(`document.querySelectorAll('ytd-backstage-post-thread-renderer, ytd-post-renderer').length`);
    if (!(await clickBtn('/^게시$/'))) throw new Error('NO_POST_BUTTON');
    let after = before; for (let k = 0; k < 20 && after <= before; k++) { await sleep(1000); after = await ev(`document.querySelectorAll('ytd-backstage-post-thread-renderer, ytd-post-renderer').length`); }
    await shot('2-posted');
    const first = await ev(`(document.querySelector('ytd-backstage-post-thread-renderer #content-text, ytd-post-renderer #content-text')?.innerText||'').trim()`);
    out.posted = after > before && first.startsWith(text.split(/\r?\n/)[0].slice(0, 15)); out.first = first.slice(0, 80); out.ok = out.posted;
    if (!out.ok) throw new Error('NOT_VISIBLE_AFTER_POST');
  }
} catch (e) { out.error = e.message; process.exitCode = 2; await shot('9-error').catch(() => {}); }
finally { console.log(JSON.stringify(out)); ws.close(); await fetch(CDP + '/json/close/' + t.id).catch(() => {}); }
