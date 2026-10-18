// node se-imglink.mjs <targetId> <idx=url> ... : set the SmartEditor image link on image components; then turn the AI mark on for every image
const [id, ...pairs] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const t = list.find((v) => v.id === id);
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
const select = async (i) => {
  const pt = await ev(`(() => { const c = document.querySelectorAll('.se-component.se-image')[${i}]; c.scrollIntoView({ block: 'center' }); const b = c.querySelector('img').getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 3)]; })()`);
  await sleep(300); await click(pt); await sleep(600);
};
const out = [];
for (const pair of pairs) {
  const [i, url] = [Number(pair.split('=')[0]), pair.slice(pair.indexOf('=') + 1)];
  await select(i);
  const lb = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && b.getBoundingClientRect().y < 140 && /링크/.test(b.innerText + (b.getAttribute('aria-label') || '')) && b.getBoundingClientRect().y > 105); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  await click(lb || [533, 121]); await sleep(800);
  await ev(`(() => { const i = document.querySelector('.se-custom-layer-link-input'); i.focus(); i.select(); return 1; })()`);
  await send('Input.insertText', { text: url }); await sleep(300); await key('Enter', 'Enter', 13); await sleep(800);
  const has = await ev(`(() => { const c = document.querySelectorAll('.se-component.se-image')[${i}]; return c.outerHTML.includes(${JSON.stringify(url)}) || !!c.querySelector('.se-module-image-link, [class*=link]'); })()`);
  out.push(`${i}:${has ? 'link' : '?'}`);
}
// AI mark on every image (state: the toggle carries se-is-selected when on)
const count = await ev(`document.querySelectorAll('.se-component.se-image').length`);
for (let i = 0; i < count; i++) {
  await select(i);
  const tp = await ev(`(() => { const t = document.querySelectorAll('.se-component.se-image')[${i}].querySelector('.se-set-ai-mark-button-toggle'); if (!t) return 'none'; if (/se-is-selected/.test(t.className)) return 'on'; const b = t.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`);
  if (Array.isArray(tp)) { await click(tp); await sleep(500); }
}
const ai = await ev(`[...document.querySelectorAll('.se-component.se-image')].map(c => /se-is-selected/.test((c.querySelector('.se-set-ai-mark-button-toggle') || {}).className || '') ? 1 : 0).join('')`);
console.log(JSON.stringify({ links: out, ai }));
ws.close();
