// ChatGPT Dots CLI (observed 2026-10-18 on chatgpt.com/dots/home, logged-in automation Canary CDP 9333).
//   node scripts/dots.mjs list                       -> dots (tbo) with their messaging room ids
//   node scripts/dots.mjs messages <roomId> [n]      -> last n messages (role, time, text)
//   node scripts/dots.mjs send <roomId> <text>       -> post a message, then read it back
//   node scripts/dots.mjs wait <roomId> [secs]       -> poll until the dot replies after our last message
// Contract (captured):
//   GET  /backend-api/tbo?limit=25                                   list dots
//   GET  /backend-api/messaging/rooms/{room}/messages?limit=N         history (Bearer + ChatGPT-Account-Id)
//   POST /backend-api/messaging/rooms/{room}/messages                 {content:{text}, request_id, page_context:{page_id:null},
//        idempotency_token(=request_id), timezone_offset_min}  + OpenAI-Sentinel-Token (flow "calpico_send_message")
// The sentinel token is produced by ChatGPT's own SDK (proof-of-work); `send` therefore types into the dot's composer in the
// logged-in tab (first-party SDK signs the request) and verifies the result through the read API. Reads are pure HTTP from the page context.
const CDP = process.env.DOTS_CDP || 'http://127.0.0.1:9333';
const [cmd, a1, ...rest] = process.argv.slice(2);

async function tab() {
  const tabs = await (await fetch(CDP + '/json/list')).json();
  let t = tabs.find((x) => x.type === 'page' && x.url.startsWith('https://chatgpt.com/'));
  if (!t) t = await (await fetch(CDP + '/json/new?' + encodeURIComponent('https://chatgpt.com/dots/home'), { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text); return m.result?.result?.value; };
  return { t, ws, send, ev };
}
// in-page authenticated GET (token never leaves the browser)
const API = `async (p) => { const s = await (await fetch('/api/auth/session')).json(); const h = { authorization: 'Bearer ' + s.accessToken };
  if (s.account?.id) h['chatgpt-account-id'] = s.account.id; const r = await fetch('/backend-api' + p, { headers: h }); return { status: r.status, body: await r.json().catch(() => null) }; }`;
const get = (T, p) => T.ev(`(${API})(${JSON.stringify(p)})`);
const fmt = (m) => `${m.created_at.slice(11, 19)} ${m.role === 'user' && !String(m.account_user_id).startsWith('calpico-member') ? 'ME ' : 'DOT'} ${m.content?.text ?? ''}`;

const T = await tab();
try {
  if (cmd === 'list') {
    const r = await get(T, '/tbo?limit=25&include_room_preview=false');
    const items = r.body?.items || r.body?.tbos || r.body?.data || r.body;
    console.log(JSON.stringify({ status: r.status, dots: (Array.isArray(items) ? items : []).map((d) => ({ id: d.id, name: d.name || d.title || d.display_name, room: d.room_id || d.messaging_room_id || d.room?.id })) }, null, 1));
    if (!Array.isArray(items)) console.log(JSON.stringify(r.body).slice(0, 1500));
  } else if (cmd === 'messages') {
    const r = await get(T, `/messaging/rooms/${a1}/messages?limit=${Number(rest[0] || 10)}`);
    const msgs = (r.body?.items || r.body?.messages || []).slice().sort((x, y) => x.created_at.localeCompare(y.created_at));
    for (const m of msgs) console.log(fmt(m));
  } else if (cmd === 'send') {
    const text = rest.join(' ');
    if (!a1 || !text) throw new Error('usage: send <roomId> <text>');
    await T.send('Page.navigate', { url: 'https://chatgpt.com/dots/home' }); await new Promise((r) => setTimeout(r, 5000));
    await T.ev(`(()=>{const e=document.querySelector('[contenteditable=true]'); if(!e) throw new Error('composer not found'); e.focus();})()`);
    await T.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await T.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await new Promise((r) => setTimeout(r, 2500));
    const r = await get(T, `/messaging/rooms/${a1}/messages?limit=5`);
    const mine = (r.body?.items || r.body?.messages || []).find((m) => m.content?.text === text);
    console.log(JSON.stringify({ sent: !!mine, id: mine?.id || null }));
    if (!mine) process.exitCode = 2;
  } else if (cmd === 'wait') {
    const until = Date.now() + Number(rest[0] || 300) * 1000; let lastMine = null;
    for (;;) {
      const r = await get(T, `/messaging/rooms/${a1}/messages?limit=20`);
      const msgs = (r.body?.items || r.body?.messages || []).slice().sort((x, y) => x.created_at.localeCompare(y.created_at));
      const meIdx = msgs.map((m) => !String(m.account_user_id).startsWith('calpico-member')).lastIndexOf(true);
      lastMine = msgs[meIdx]; const after = msgs.slice(meIdx + 1);
      if (after.length) { for (const m of after) console.log(fmt(m)); break; }
      if (Date.now() > until) { console.log('TIMEOUT waiting after', lastMine?.created_at); process.exitCode = 3; break; }
      await new Promise((r2) => setTimeout(r2, 10000));
    }
  } else {
    console.log('usage: dots.mjs list | messages <room> [n] | send <room> <text> | wait <room> [secs]'); process.exitCode = 1;
  }
} finally { T.ws.close(); }
