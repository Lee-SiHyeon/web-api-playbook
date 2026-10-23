// Real OS mouse click on an element of a CDP-driven tab, through a Windows desktop MCP served over streamable HTTP
// (Windows-MCP: tools Click/Screenshot/ControlStatus; see references/windows-canary-automation-setup-2026-10-23.md).
// For sites that ignore CDP input events on one control (X's Post button, 2026-10-23).
//   import { osClickElement } from '../lib/desktop-click.mjs';
//   await osClickElement(send, ev, 'document.querySelector("[data-testid=tweetButton]")');
// The tab must be the visible one in a non-minimized window: the click lands on real screen pixels.
const MCP = process.env.DESKTOP_MCP || 'http://127.0.0.1:8765/mcp';

async function rpc(session, body) {
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id') || session;
  const text = await r.text();
  // streamable HTTP answers either JSON or SSE ("data: {...}" lines)
  const data = text.trim().startsWith('{') ? text : (text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() || '');
  return { sid, msg: data ? JSON.parse(data) : null };
}

export async function mcpCall(tool, args) {
  const init = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'web-api-playbook', version: '1' } } });
  await rpc(init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const res = await rpc(init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  if (res.msg?.error) throw new Error(`MCP ${tool}: ${res.msg.error.message}`);
  const content = res.msg?.result?.content || [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (res.msg?.result?.isError) throw new Error(`MCP ${tool}: ${text.slice(0, 200)}`);
  return text;
}

// Screen coordinates of an element: window bounds from the browser + the page's own viewport offset.
// Device-metrics emulation is cleared first, because the click lands on the real viewport.
export async function screenPoint(send, ev, expr) {
  await send('Emulation.clearDeviceMetricsOverride'); await send('Page.bringToFront');
  await new Promise((r) => setTimeout(r, 800));
  const p = await ev(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: devicePixelRatio, sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight }; })()`);
  if (!p) return null;
  const border = Math.max(0, (p.ow - p.iw * 1) / 2);
  const top = p.oh - p.ih - border; // browser chrome above the viewport (tabs, address bar)
  return [Math.round((p.sx + border + p.x) * p.dpr), Math.round((p.sy + top + p.y) * p.dpr)];
}

export async function osClickElement(send, ev, expr) {
  const status = await mcpCall('ControlStatus', {});
  if (/"state"\s*:\s*"user"/.test(status)) throw new Error('DESKTOP_USER_CONTROL: someone may be using the PC; not clicking');
  const pt = await screenPoint(send, ev, expr);
  if (!pt) throw new Error('ELEMENT_NOT_FOUND');
  await mcpCall('Click', { loc: pt });
  return pt;
}
