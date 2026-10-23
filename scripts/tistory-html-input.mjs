// node tistory-html.mjs <targetId> <html> : switch the Tistory editor to HTML mode (auto-accepting the native confirm)
// and type the HTML into CodeMirror as real input, so the editor's own state holds it (cm.setValue alone published an empty body).
import fs from 'node:fs';
const [id, file] = process.argv.slice(2);
const html = fs.readFileSync(file, 'utf8');
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const t = list.find((v) => v.id === id);
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
await send('Page.enable');
const pt = (txt) => ev(`(() => { const e = [...document.querySelectorAll('button, li, div, span')].filter(e => e.offsetParent && e.children.length === 0 && e.innerText.trim() === ${JSON.stringify(txt)}); const x = e.pop(); if (!x) return null; const r = x.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
const mode = await pt('기본모드');
if (mode) { await click(mode); await sleep(700); const h = await pt('HTML'); if (h) { click(h); } await sleep(2500); }
const cmBox = await ev(`(() => { const c = [...document.querySelectorAll('.CodeMirror')].find(c => c.offsetParent); if (!c) return null; c.CodeMirror.focus(); c.CodeMirror.execCommand('selectAll'); return true; })()`);
if (!cmBox) { console.log(JSON.stringify({ ok: false, code: 'NO_VISIBLE_CODEMIRROR' })); process.exit(2); }
await send('Input.insertText', { text: html }); await sleep(1500);
const len = await ev(`[...document.querySelectorAll('.CodeMirror')].find(c => c.offsetParent).CodeMirror.getValue().length`);
console.log(JSON.stringify({ ok: len > html.length * 0.9, length: len, expected: html.length }));
ws.close();
