// node se-replace.mjs <targetId> <orderFile> <imgDir> : replace every externally hosted SmartEditor image with an uploaded local file (교체)
import fs from 'node:fs';
import path from 'node:path';
const [id, orderFile, imgDir] = process.argv.slice(2);
const files = fs.readFileSync(orderFile, 'utf8').split(/\r?\n/).filter(Boolean);
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const t = list.find((v) => v.id === id);
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); let chooser = null;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.fileChooserOpened') chooser = m.params; if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
await send('Page.enable');
const dismiss = () => ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === '확인' && b.closest('[class*=popup]')); if (b) b.click(); return !!b; })()`);
await dismiss();
const out = [];
for (let i = 0; i < files.length; i++) {
  const src = await ev(`document.querySelectorAll('.se-component.se-image')[${i}].querySelector('img').src`);
  if (/pstatic\.net/.test(src)) { out.push(`${i}:skip`); continue; }
  const pt = await ev(`(() => { const c = document.querySelectorAll('.se-component.se-image')[${i}]; c.scrollIntoView({ block: 'center' }); const b = c.querySelector('img').getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 3)]; })()`);
  await sleep(400); await click(pt); await sleep(700);
  const btn = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && /교체/.test(b.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  if (!btn) { out.push(`${i}:nobtn`); continue; }
  chooser = null; await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await click(btn); for (let k = 0; k < 40 && !chooser; k++) await sleep(100);
  if (chooser) await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [path.join(imgDir, files[i])] });
  await send('Page.setInterceptFileChooserDialog', { enabled: false });
  let ok = false;
  for (let k = 0; k < 40 && !ok; k++) { await sleep(500); ok = /pstatic\.net/.test(await ev(`document.querySelectorAll('.se-component.se-image')[${i}].querySelector('img').src`)); if (await dismiss()) break; }
  out.push(`${i}:${chooser ? (ok ? 'ok' : 'fail') : 'nochooser'}`);
}
console.log(out.join(' '));
ws.close();
