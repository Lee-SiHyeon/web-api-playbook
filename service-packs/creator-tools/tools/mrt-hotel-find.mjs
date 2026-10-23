if (process.argv.includes('--help')) { console.log('mrt-hotel-find.mjs — see service-packs/creator-tools/README.md for inputs and execution mode'); process.exit(0); }
// node mrt-hotel-find.mjs "<name>" ... -> first accommodation result (id, title, price, rating) via the logged-in Canary tab on myrealtrip search
const tabs = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const t = tabs.find((x) => x.type === 'page' && x.url.includes('myrealtrip.com/search'));
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const send = (method, params) => new Promise((r) => { const i = ++id; ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); r(m.result); } }); ws.send(JSON.stringify({ id: i, method, params })); });
for (const name of process.argv.slice(2)) {
  await send('Page.navigate', { url: 'https://www.myrealtrip.com/search?q=' + encodeURIComponent(name) + '&tab=accommodation' });
  await new Promise((r) => setTimeout(r, 9000));
  const r = await send('Runtime.evaluate', { returnByValue: true, expression: String.raw`[...document.querySelectorAll('a[href*="union/products/"]')].map(a=>({id:(a.href.match(/products\/(\d+)/)||[])[1],t:(a.innerText||'').replace(/\s+/g,' ').trim()})).filter(x=>x.t).slice(0,3)` });
  console.log(JSON.stringify({ q: name, results: r.result?.value, err: r.exceptionDetails?.text }));
}
ws.close();
