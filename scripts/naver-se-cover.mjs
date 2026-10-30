// Naver blog 대표이미지 (owner 2026-10-30 "네이버 블로그 글들 메인이미지 왜없음?"): posts pasted from Shorts had only text/table/YouTube,
// so the blog list and search showed no thumbnail. This uploads a local cover image as the FIRST body component through the editor's
// own 사진 button (file chooser intercepted over CDP, so the image is hosted on pstatic like a manual upload) and marks it 대표.
//   node scripts/naver-se-cover.mjs <blogId> <logNo> <cover.jpg> [--confirm]   existing post: opens /postupdate, inserts, 발행 = 수정 저장
//   node scripts/naver-se-cover.mjs <blogId> current <cover.jpg>                 the open /postwrite tab (after naver-se-paste draft)
// Prints {ok, images, firstIsImage, published}. naver-se-paste publish --confirm refuses a post without an uploaded image.
const CDP = process.env.NAVER_SE_CDP || 'http://127.0.0.1:9333';
const [blogId, logNo, img, ...flags] = process.argv.slice(2);
if (!blogId || !logNo || !img) { console.log('usage: naver-se-cover.mjs <blogId> <logNo|current> <cover.jpg> [--confirm]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const path = (await import('node:path')).default;
const file = path.resolve(img).replace(/\//g, '\\');
let t;
if (logNo === 'current') t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith(`https://blog.naver.com/${blogId}/post`) && /\/post(write|update)/.test(x.url));
else t = await (await fetch(`${CDP}/json/new?https://blog.naver.com/${blogId}/postupdate?logNo=${logNo}`, { method: 'PUT' })).json();
if (!t) { console.log(JSON.stringify({ ok: false, code: 'NO_EDITOR_TAB' })); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); let chooser = null;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.fileChooserOpened') chooser = m.params; if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const key = async (k, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
const center = (sel) => ev(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [Math.round(b.x + Math.min(30, b.width / 2)), Math.round(b.y + b.height / 2)]; })()`);
const stats = () => ev(`(() => { const c = [...document.querySelectorAll('.se-component')].filter(c => !c.classList.contains('se-documentTitle'));
  const imgs = [...document.querySelectorAll('.se-component.se-image img')].map(i => i.src);
  return { images: imgs.filter(s => /pstatic\\.net/.test(s)).length, firstIsImage: !!c[0] && c[0].classList.contains('se-image') }; })()`);
const out = { ok: false };
try {
  await send('Page.enable'); await send('Page.setInterceptFileChooserDialog', { enabled: true });
  for (let k = 0; k < 60 && !(await ev(`!!document.querySelector('.se-documentTitle')`)); k++) await sleep(500);
  await sleep(2500);
  // "작성 중인 글이 있습니다" on an existing post → 취소 keeps the published version as the base
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === '취소' && b.closest('[class*=popup]')); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  const before = await stats();
  if (before.images) { Object.assign(out, { ok: true, skipped: 'already has an uploaded image (대표 OK)', ...before }); }
  else {
    // caret at the very start of the body: click the first body paragraph, Ctrl+Home
    await click(await center(`document.querySelector('.se-component:not(.se-documentTitle) .se-text-paragraph')`)); await sleep(300);
    await key('Home', 'Home', 36, 2); await sleep(300);
    chooser = null;
    await click(await center(`[...document.querySelectorAll('button')].find(b => b.offsetParent && /^사진/.test(b.innerText.trim()))`));
    for (let k = 0; k < 20 && !chooser; k++) await sleep(250);
    if (!chooser) throw Object.assign(new Error('NO_FILE_CHOOSER'), { code: 'NO_FILE_CHOOSER' });
    await send('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser.backendNodeId });
    for (let k = 0; k < 60; k++) { await sleep(500); if ((await stats()).images > before.images) break; }
    await sleep(1500);
    // the editor drops the upload below the caret's paragraph; move it to the top if needed (component toolbar ↑ isn't stable, so cut/insert):
    let s = await stats();
    if (!s.firstIsImage) {
      // put the empty-or-first paragraph after the image by moving the image component node order via the editor's drag API is brittle;
      // instead remove the first text paragraph's content above it only when that paragraph is empty
      const movedUp = await ev(`(() => { const c = [...document.querySelectorAll('.se-component')].filter(c => !c.classList.contains('se-documentTitle'));
        return c[0] && c[0].classList.contains('se-text') && !c[0].innerText.trim() ? 'empty-first' : c.findIndex(x => x.classList.contains('se-image')); })()`);
      out.imageIndex = movedUp;
    }
    Object.assign(out, s, { inserted: s.images > before.images });
    out.ok = out.inserted;
  }
  if (flags.includes('--confirm') && out.ok && (!out.skipped || logNo === 'current')) {
    await click(await center(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim().startsWith('발행'))`)); await sleep(2000);
    await click(await center(`[...document.querySelectorAll('button')].filter(b => b.offsetParent && b.innerText.trim() === '발행').pop()`)); await sleep(6000);
    out.published = true; out.url = await ev('location.href');
  }
} catch (e) { Object.assign(out, { ok: false, code: e.code || 'ERROR', message: e.message }); }
out.targetId = t.id; console.log(JSON.stringify(out));
ws.close();
