// Blogger new post in the logged-in automation Canary (CDP 9333); own tab, closed at the end. 2026-10-23.
//   node scripts/blogger-post.mjs <blogId> <title.txt> <body.html> <labels.txt> [--upload=<a.jpg,b.jpg,...>] [--publish] [--shots=<dir>]
// --upload: local images uploaded through the editor (이미지 삽입 → 컴퓨터에서 업로드, intercepted chooser) so they get Blogger-hosted
//   URLs; in body.html write their src as "UPLOAD:<file basename>" and the script swaps in the hosted URL. Used for the table
//   images (owner 2026-10-23: tables as images) that have no other public host.
// Body: HTML view, CodeMirror.setValue(html) (persisted on Blogger, unlike Tistory). Without --publish the post stays a draft.
// Readback: /feeds/posts/default?alt=json on the blog (post URL, image count).
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.BLOGGER_CDP || 'http://127.0.0.1:9333';
const [blogId, titleFile, bodyFile, labelsFile, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
if (!blogId || !bodyFile) { console.error('usage: blogger-post.mjs <blogId> <title.txt> <body.html> <labels.txt> [--upload=a,b] [--publish] [--shots=dir]'); process.exit(2); }
const shots = opt.shots || path.join(path.dirname(path.resolve(bodyFile)), 'blogger-shots'); fs.mkdirSync(shots, { recursive: true });
const title = fs.readFileSync(titleFile, 'utf8').trim(); let body = fs.readFileSync(bodyFile, 'utf8');
const labels = labelsFile && fs.existsSync(labelsFile) ? fs.readFileSync(labelsFile, 'utf8').trim() : '';
const uploads = opt.upload ? String(opt.upload).split(',').map((f) => path.resolve(f.trim())).filter(Boolean) : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = await (await fetch(`${CDP}/json/new?https://www.blogger.com/blog/posts/${blogId}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); const events = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } else if (m.method) events.push(m); };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64')); };
const clickAt = async ([x, y]) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const pointOf = (sel, re) => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.getBoundingClientRect().width && ${re ? `${re}.test((x.innerText || x.getAttribute('aria-label') || '').trim())` : 'true'})[0]; if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const cmValue = () => ev(`(() => { const c = document.querySelector('.CodeMirror'); return c ? c.CodeMirror.getValue() : null; })()`);
const out = {};
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.bringToFront'); await send('Page.enable'); await send('DOM.enable');
  await sleep(9000);
  const np = await pointOf('[role=button], a, button', '/(새 글|New post)$/'); if (!np) throw new Error('NO_NEW_POST');
  await clickAt(np); await sleep(9000);
  out.editUrl = await ev('location.href');
  // HTML view (CodeMirror); toggle once if the compose view is showing
  if (!(await ev(`!!document.querySelector('.CodeMirror')`))) { const sw = await pointOf('[aria-label="보기 전환"]'); if (sw) { await clickAt(sw); await sleep(1200); const h = await pointOf('[role=menuitem], [role=option]', '/HTML 보기/'); if (h) await clickAt(h); await sleep(2000); } }
  if (!(await ev(`!!document.querySelector('.CodeMirror')`))) throw new Error('NO_HTML_VIEW');
  // uploads: one chooser per file, read the new <img src> after each insert
  if (uploads.length) {
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    out.uploaded = {};
    for (const f of uploads) {
      const before = await cmValue();
      const ins = await pointOf('[aria-label="이미지 삽입"]'); if (!ins) throw new Error('NO_INSERT_IMAGE');
      await clickAt(ins); await sleep(1500);
      const up = await pointOf('[role=menuitem], [role=option]', '/컴퓨터에서 업로드/'); if (!up) throw new Error('NO_UPLOAD_ITEM');
      await clickAt(up); await sleep(4000);
      // the "이미지 추가" picker is a cross-origin iframe (its 찾아보기 chooser never reaches this page's interception):
      // drop the file onto its drop zone instead (Input.dispatchDragEvent with DragData.files)
      const zone = await ev(`(() => { const f = [...document.querySelectorAll('iframe')].filter((x) => x.getBoundingClientRect().width > 300).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]; if (!f) return null; const r = f.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      if (!zone) { await shot('upload-nopicker'); throw new Error('NO_PICKER'); }
      const data = { items: [], files: [f], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) { await send('Input.dispatchDragEvent', { type, x: zone[0], y: zone[1], data }); await sleep(400); }
      // HTML view asks for a layout (레이아웃 선택): 원본 크기, then 확인
      let after = before;
      for (let i = 0; i < 90 && after === before; i++) {
        await sleep(1000);
        if (await ev(`/레이아웃 선택/.test(document.body.innerText)`)) {
          const orig = await pointOf('[role=dialog] label, [role=dialog] [role=radio], [role=dialog] *', '/^원본 크기$/'); if (orig) await clickAt(orig); await sleep(400);
          const okb = await pointOf('[role=dialog] [role=button], [role=dialog] button', '/^확인$/'); if (okb) await clickAt(okb); await sleep(1500);
        }
        after = await cmValue();
      }
      const srcs = [...(after || '').matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
      const prev = new Set([...(before || '').matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]));
      const url = srcs.find((s) => !prev.has(s));
      if (!url) { await shot('upload-nourl'); throw new Error('UPLOAD_NO_URL ' + path.basename(f)); }
      out.uploaded[path.basename(f)] = url;
    }
    for (const [b, url] of Object.entries(out.uploaded)) body = body.split(`UPLOAD:${b}`).join(url);
  }
  const left = [...body.matchAll(/UPLOAD:([^"'\s>]+)/g)].map((m) => m[1]); if (left.length) throw new Error('UNRESOLVED_UPLOADS ' + left.join(','));
  await ev(`(() => { document.querySelector('.CodeMirror').CodeMirror.setValue(${JSON.stringify(body)}); return true; })()`);
  await sleep(1500);
  out.bodyChars = (await cmValue()).length;
  // title + labels
  const ti = await pointOf('input[aria-label="제목"], [aria-label="제목"] input, input[placeholder="제목"]'); if (!ti) throw new Error('NO_TITLE');
  await clickAt(ti); await send('Input.insertText', { text: title });
  if (labels) {
    const lb = await pointOf('[aria-label="쉼표로 라벨을 구분하세요."], textarea[aria-label*="라벨"], input[aria-label*="라벨"]');
    if (lb) { await clickAt(lb); await send('Input.insertText', { text: labels }); out.labels = true; }
  }
  await sleep(2000); await shot('blogger-1-filled');
  if (opt.publish) {
    // the label suggestion list ('일치하는 추천 없음') stays open and swallows the 게시 click: click a neutral spot first
    await clickAt([600, 250]); await sleep(600);
    const pub = await pointOf('[aria-label="게시"], [role=button]', '/^게시$/'); if (!pub) throw new Error('NO_PUBLISH');
    await clickAt(pub); await sleep(3000);
    const ok = await pointOf('[role=dialog] [role=button], [role=alertdialog] [role=button], button', '/^(확인|게시)$/');
    if (ok) await clickAt(ok);
    await sleep(8000); await shot('blogger-2-published');
    const host = await ev(`(() => { const a = [...document.querySelectorAll('a[href*=".blogspot.com"]')][0]; return a ? new URL(a.href).host : null; })()`);
    out.published = true;
    if (host) {
      const feed = await (await fetch(`https://${host}/feeds/posts/default?alt=json&max-results=3`)).json().catch(() => null);
      const e = feed?.feed?.entry?.find((x) => x.title?.$t === title);
      if (e) { out.url = e.link.find((l) => l.rel === 'alternate')?.href; out.images = ((e.content?.$t || '').match(/<img/g) || []).length; }
    }
  }
} catch (e) { out.error = e.message; await shot('blogger-error').catch(() => {}); process.exitCode = 1; }
finally { console.log(JSON.stringify(out)); ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
