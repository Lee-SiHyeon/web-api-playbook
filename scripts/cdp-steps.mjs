// Run a sequence of CDP steps against one existing tab, all in ONE session (so coordinates and the viewport stay consistent).
//   node scripts/cdp-steps.mjs <tabId> step... ; steps: metrics (1500x1000) | click:x,y | hover:x,y | text:<regex> (click the smallest
//   visible element whose innerText/aria-label matches) | type:<text> | rawfile:<path> (insertText the file, newlines kept, no key
//   events: TikTok/YouTube comment boxes submit on Enter and Shift+Enter) | key:Enter|Escape|Tab|Backspace | selall | wait:ms | shot:<file> | eval:<expr>
import fs from 'node:fs';
const [tid, ...steps] = process.argv.slice(2);
const CDP = 'http://127.0.0.1:9333';
const t = (await (await fetch(CDP + '/json/list')).json()).find((v) => v.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const key = async (k, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
const VK = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 };
await send('Page.enable');
for (const s of steps) {
  const i = s.indexOf(':'); const op = i < 0 ? s : s.slice(0, i), arg = i < 0 ? '' : s.slice(i + 1);
  if (op === 'metrics') await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  else if (op === 'click') { const [x, y] = arg.split(',').map(Number); await click(x, y); }
  else if (op === 'hover') { const [x, y] = arg.split(',').map(Number); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
  else if (op === 'text') {
    const pt = await ev(`(()=>{const re=new RegExp(${JSON.stringify(arg)});const c=[...document.querySelectorAll('*')].filter(x=>x.offsetParent!==null&&x.getClientRects().length&&re.test((x.innerText||x.getAttribute('aria-label')||'').trim()));c.sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length);const e=c[0];if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    console.log('text', arg, pt); if (pt) await click(pt[0], pt[1]);
  } else if (op === 'type') await send('Input.insertText', { text: arg });
  else if (op === 'rawfile') await send('Input.insertText', { text: fs.readFileSync(arg, 'utf8').trim().split('\r').join('') });
  else if (op === 'key') await key(arg, arg, VK[arg] || 0);
  else if (op === 'selall') await key('a', 'KeyA', 65, 2);
  else if (op === 'wait') await sleep(+arg);
  else if (op === 'shot') { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64')); }
  else if (op === 'eval') console.log('eval', JSON.stringify(await ev(arg)));
  await sleep(400);
}
ws.close();
