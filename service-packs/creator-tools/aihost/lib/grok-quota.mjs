if (process.argv.includes('--help')) { console.log('grok-quota.mjs — see service-packs/creator-tools/README.md for inputs and execution mode'); process.exit(0); }
// node lib/grok-quota.mjs [cdp]  -> prints { ok, status, body } from POST grok.com/rest/media/imagine/quota_info.
// Runs in one new tab on https://grok.com/imagine of the automation Canary (cookies are the browser's); closes only that tab.
// Never sends Browser.close (CLAUDE.md: disconnect only).
const cdp = process.argv[2] || 'http://127.0.0.1:9333';

async function main() {
  const tab = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  let ws;
  try {
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let n = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise((resolve) => { const i = ++n; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send('Page.enable');
    await send('Page.navigate', { url: 'https://grok.com/imagine' });
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && (await evalJs('document.readyState')) !== 'complete') await new Promise((r) => setTimeout(r, 300));
    const out = await evalJs(`fetch('/rest/media/imagine/quota_info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'include' })
      .then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String(e) }))`);
    let body = null; try { body = JSON.parse(out?.text || 'null'); } catch { body = null; }
    console.log(JSON.stringify({ ok: out?.status === 200 && !!body, status: out?.status ?? null, body }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await fetch(`${cdp}/json/close/${tab.id}`).catch(() => {});
  }
}
await main();
