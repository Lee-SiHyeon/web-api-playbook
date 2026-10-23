// Grok Bot CLI (observed 2026-10-18 on grok.com/bot/<agentId>, logged-in automation Canary CDP 9333).
//   node scripts/grokbot.mjs roster                     -> bots (agentId, name, status)
//   node scripts/grokbot.mjs tail <agentId> [n]         -> last n transcript entries
//   node scripts/grokbot.mjs send <agentId> <prompt>    -> bot.command sendPrompt (accepted:true)
//   node scripts/grokbot.mjs wait <agentId> [secs]      -> poll transcript until the bot posts after our prompt
// Contract (captured): wss://grok.com/ws/bot/?uid=<userId> (session cookies); first frame {"protocol_version":"1.0.0","kind":"bot_client"}, then JSON-RPC 2.0
//   {"method":"bot.roster","params":{}}
//   {"method":"bot.command","params":{"agentId":ID,"name":"sendPrompt","args":{"agentId":ID,"prompt":TEXT}}} -> {"accepted":true}
//   {"method":"bot.command","params":{"agentId":ID,"name":"getAgentTranscriptTail","args":{"id":ID,"limit":N}}} -> {entries:[...]}
// The socket is opened inside the logged-in grok.com tab so the first-party cookies authenticate it; nothing leaves the browser.
const CDP = process.env.GROKBOT_CDP || 'http://127.0.0.1:9333';
const [cmd, agent, ...rest] = process.argv.slice(2);

const tabs = await (await fetch(CDP + '/json/list')).json();
let t = tabs.find((x) => x.type === 'page' && x.url.startsWith('https://grok.com/'));
if (!t) { t = await (await fetch(CDP + '/json/new?' + encodeURIComponent('https://grok.com/'), { method: 'PUT' })).json(); await new Promise((r) => setTimeout(r, 6000)); }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expr) => new Promise((r) => { const i = ++id; pend.set(i, (m) => r(m.result?.result?.value ?? { error: m.result?.exceptionDetails?.text })); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });

// one JSON-RPC call over a fresh page-side socket
const rpc = (method, params) => ev(`(async () => {
  const s = await (await fetch('/api/auth/session')).json(); const uid = s.session?.userId;
  const sock = new WebSocket('wss://grok.com/ws/bot/?uid=' + uid);
  await new Promise((ok, no) => { sock.onopen = ok; sock.onerror = () => no(new Error('ws error')); });
  // handshake observed in the web client: {protocol_version, kind:'bot_client'} -> server hello with connection_id
  await new Promise((ok) => { sock.onmessage = (e) => { if (JSON.parse(e.data).connection_id) ok(); }; sock.send(JSON.stringify({ protocol_version: '1.0.0', kind: 'bot_client' })); });
  const rid = 'cli-' + Math.random().toString(36).slice(2);
  const res = await new Promise((ok) => { const to = setTimeout(() => ok({ error: 'timeout' }), 20000);
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === rid) { clearTimeout(to); ok(m.result ?? { error: m.error }); } };
    sock.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })); });
  sock.close(); return res; })()`);
const textOf = (en) => en.message?.content ?? en.text ?? en.content ?? (en.kind === 'user-prompt' ? en.prompt : null) ?? JSON.stringify(en).slice(0, 200);
const tail = async (n) => (await rpc('bot.command', { agentId: agent, name: 'getAgentTranscriptTail', args: { id: agent, limit: n } }))?.entries || [];

try {
  if (cmd === 'roster') console.log(JSON.stringify(await rpc('bot.roster', {}), null, 1));
  else if (cmd === 'tail') for (const en of (await tail(Number(rest[0] || 10))).slice(-Number(rest[0] || 10))) console.log(`${new Date(en.timestampMs || 0).toISOString().slice(11, 19)} ${en.kind} ${String(textOf(en)).slice(0, 400)}`);
  else if (cmd === 'send') { const prompt = rest.join(' '); if (!agent || !prompt) throw new Error('usage: send <agentId> <prompt>'); console.log(JSON.stringify(await rpc('bot.command', { agentId: agent, name: 'sendPrompt', args: { agentId: agent, prompt } }))); }
  else if (cmd === 'wait') {
    const until = Date.now() + Number(rest[0] || 600) * 1000; const start = Date.now() - 5000;
    for (;;) {
      const fresh = (await tail(30)).filter((en) => (en.timestampMs || 0) > start && en.kind === 'send-message');
      if (fresh.length) { for (const en of fresh) console.log(String(textOf(en))); break; }
      if (Date.now() > until) { console.log('TIMEOUT'); process.exitCode = 3; break; }
      await new Promise((r) => setTimeout(r, 15000));
    }
  } else { console.log('usage: grokbot.mjs roster | tail <agentId> [n] | send <agentId> <prompt> | wait <agentId> [secs]'); process.exitCode = 1; }
} finally { ws.close(); }
