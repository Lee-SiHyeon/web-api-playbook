// Capture elements of a local HTML page as images through the automation Canary (CDP 9333). Used for affiliate banners
// (templates/affiliate-banner/) and other designed cards; one HTML file can hold several <section id=...> designs.
//   node scripts/html-capture.mjs <page.html> <outDir> <id1,id2,...> [--width=1200] [--format=jpeg|png]
// Fonts and images resolve relative to the HTML file (file://), so keep assets next to it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const CDP = process.env.CAPTURE_CDP || 'http://127.0.0.1:9333';
const [page, outDir, ids, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map((f) => f.replace(/^--/, '').split('=')));
if (!page || !outDir || !ids) { console.error('usage: html-capture.mjs <page.html> <outDir> <id1,id2> [--width=1200] [--format=jpeg]'); process.exit(2); }
const fmt = opt.format === 'png' ? 'png' : 'jpeg';
const t = await (await fetch(`${CDP}/json/new?${pathToFileURL(path.resolve(page)).href}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  await send('Emulation.setDeviceMetricsOverride', { width: Number(opt.width || 1200), height: 1800, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 2500)); // fonts + images
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const id of ids.split(',')) {
    const r = await send('Runtime.evaluate', { expression: `(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)return null;const b=e.getBoundingClientRect();return [b.x,b.y+scrollY,b.width,b.height]})()`, returnByValue: true });
    const box = r.result?.result?.value; if (!box) { out.push({ id, error: 'NOT_FOUND' }); continue; }
    const [x, y, width, height] = box;
    const s = await send('Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? 90 : undefined, clip: { x, y, width, height, scale: 1 }, captureBeyondViewport: true });
    const file = path.join(outDir, `${id}.${fmt === 'jpeg' ? 'jpg' : 'png'}`); fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
    out.push({ id, file, width: Math.round(width), height: Math.round(height) });
  }
  console.log(JSON.stringify(out));
} finally { ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
