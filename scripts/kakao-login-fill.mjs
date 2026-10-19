// node kakao-fill.mjs <targetId> : types the DPAPI Tistory/Kakao identity into the open accounts.kakao.com login form (never printed)
import { ProtectedStore } from 'file:///C:/Users/sihyeon/dev/web-api-playbook/lib/protected-store.mjs';
const [id] = process.argv.slice(2);
const raw = new ProtectedStore().read(process.env.KAKAO_STORE_KEY || 'tistory-kakao-login');
if (!raw) { console.log(JSON.stringify({ ok: false, code: 'IDENTITY_MISSING' })); process.exit(2); }
const s = JSON.parse(raw); const user = s.username ?? s.email ?? s.id ?? s.loginId, pw = s.password ?? s.pw;
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const t = list.find((v) => v.id === id);
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true });
for (const [sel, val] of [['input[name=loginId], #loginId--1, input[type=email], input[name=email]', user], ['input[name=password], #password--2, input[type=password]', pw]]) {
  const r = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.focus();e.select&&e.select();return true})()`);
  if (!r.result?.result?.value) { console.log(JSON.stringify({ ok: false, code: 'FIELD_NOT_FOUND', sel })); process.exit(2); }
  for (const ch of val) { await send('Input.insertText', { text: ch }); await new Promise((r) => setTimeout(r, 40 + Math.random() * 50)); }
}
console.log(JSON.stringify({ ok: true, filled: !!user && !!pw }));
ws.close();
