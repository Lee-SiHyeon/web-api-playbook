const BRIDGE_URL = 'ws://127.0.0.1:9417';
const MAX_FREQ_CHARS = 250_000;
const CAPTCHA_SLOT = '__CAPTCHA__';
const CAPTCHA_RPC_IDS = new Set(['YhhmEf']);
const ALLOWED_RPC_IDS = new Set(['YhhmEf', 'as29s', 'Zzl0ze']);

let socket;
let reconnectTimer;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect() {
  clearTimeout(reconnectTimer);
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch {
    reconnectTimer = setTimeout(connect, 3000);
    return;
  }
  socket.addEventListener('open', () => send({ type: 'hello', protocol: 1 }));
  socket.addEventListener('message', async ({ data }) => {
    let command;
    try { command = JSON.parse(data); } catch { return; }
    if (typeof command?.id !== 'string') return;
    try {
      const result = await dispatch(command);
      send({ id: command.id, result });
    } catch (error) {
      send({ id: command.id, error: String(error?.message || 'Flow bridge request failed').slice(0, 160) });
    }
  });
  socket.addEventListener('close', () => { reconnectTimer = setTimeout(connect, 3000); });
  socket.addEventListener('error', () => { try { socket.close(); } catch {} });
}

async function flowTab() {
  const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
  const tab = tabs.find((candidate) => candidate.active && !candidate.discarded)
    || tabs.find((candidate) => !candidate.discarded);
  if (!tab?.id) throw new Error('NO_FLOW_TAB: open a signed-in Flow project in Chrome.');
  return tab;
}

async function context() {
  const tab = await flowTab();
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const match = location.pathname.match(/\/project\/([a-f\d-]{16,64})(?:\/|$)/i);
      return { projectId: match?.[1] };
    },
  });
  if (!injected?.result?.projectId) throw new Error('NO_FLOW_PROJECT: open a Flow project editor.');
  return injected.result;
}

async function rpc(command) {
  const { rpcId, freq, captchaAction } = command.params || {};
  if (!ALLOWED_RPC_IDS.has(rpcId)) throw new Error('RPC_NOT_ALLOWED');
  if (typeof freq !== 'string' || freq.length > MAX_FREQ_CHARS) throw new Error('INVALID_RPC_PAYLOAD');
  const needsCaptcha = CAPTCHA_RPC_IDS.has(rpcId);
  if (needsCaptcha !== Boolean(captchaAction)) throw new Error('CAPTCHA_ACTION_MISMATCH');
  if (needsCaptcha && captchaAction !== 'VIDEO_GENERATION') throw new Error('CAPTCHA_ACTION_NOT_ALLOWED');
  if (needsCaptcha && !freq.includes(CAPTCHA_SLOT)) throw new Error('CAPTCHA_SLOT_MISSING');
  if (!needsCaptcha && freq.includes(CAPTCHA_SLOT)) throw new Error('UNEXPECTED_CAPTCHA_SLOT');

  const tab = await flowTab();
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [rpcId, freq, captchaAction || null],
    func: async (id, requestEnvelope, action) => {
      const wiz = window.WIZ_global_data || {};
      const at = wiz.SNlM0e;
      const sid = wiz.FdrFJe;
      const bl = wiz.cfb2h;
      if (typeof at !== 'string' || !at) return { error: 'NO_PAGE_AT_TOKEN' };

      let bodyEnvelope = requestEnvelope;
      if (action) {
        const enterprise = window.grecaptcha?.enterprise;
        const script = [...document.scripts].find((item) => item.src.includes('/recaptcha/enterprise.js'));
        const siteKey = script ? new URL(script.src).searchParams.get('render') : null;
        if (!enterprise?.execute || !siteKey) return { error: 'RECAPTCHA_NOT_READY' };
        await new Promise((resolve) => enterprise.ready(resolve));
        const token = await enterprise.execute(siteKey, { action });
        if (typeof token !== 'string' || !token) return { error: 'RECAPTCHA_TOKEN_EMPTY' };
        bodyEnvelope = requestEnvelope.split('__CAPTCHA__').join(token);
      }

      const reqid = Math.floor(Math.random() * 900000) + 100000;
      const query = new URLSearchParams({
        rpcids: id,
        'source-path': location.pathname || '/',
        bl: typeof bl === 'string' ? bl : '',
        'f.sid': typeof sid === 'string' ? sid : '',
        hl: (document.documentElement.lang || navigator.language || 'en').split('-')[0],
        _reqid: String(reqid),
        rt: 'c',
      });
      const response = await fetch('/_/AiSandboxAngularFrontend/data/batchexecute?' + query, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: new URLSearchParams({ 'f.req': bodyEnvelope, at }),
      });
      return { status: response.status, text: await response.text() };
    },
  });
  if (injected?.result?.error) throw new Error(injected.result.error);
  return injected?.result;
}

async function dispatch(command) {
  if (command.method === 'context') return context();
  if (command.method === 'rpc') return rpc(command);
  throw new Error('METHOD_NOT_ALLOWED');
}

connect();
