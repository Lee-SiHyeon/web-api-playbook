import { execFileSync, spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PROFILE_DIR = 'C:\\Users\\User\\tools\\gflow\\.gflow\\profiles\\default';
export const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export function profileError(code) { return Object.assign(new Error(code), { code }); }
export function windowsChildEnvironment(extra = {}) {
  const env = {};
  for (const name of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // Inherited PowerShell 7 module paths break Windows PowerShell 5 cmdlet discovery.
  return { ...env, ...extra };
}

// Never expose full process command lines, browser target lists, or login URLs.
export function inspectProfileProcess(profileDir) {
  if (process.platform !== 'win32') throw profileError('FLOW_PROFILE_WINDOWS_REQUIRED');
  const script = `$ErrorActionPreference='Stop'; $wanted=[IO.Path]::GetFullPath($env:FLOW_PROFILE_DIR).TrimEnd('\\'); $items=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $m=[regex]::Match($_.CommandLine, '--user-data-dir=(?:"([^\"]+)"|([^ ]+))'); if($m.Success) { $p=$m.Groups[1].Value; if(-not $p){$p=$m.Groups[2].Value}; if([IO.Path]::GetFullPath($p).TrimEnd('\\') -ieq $wanted) { $d=[regex]::Match($_.CommandLine,'--remote-debugging-port(?:=| )([0-9]+)'); [pscustomobject]@{pid=$_.ProcessId; debug=($d.Success); port= $(if($d.Success){[int]$d.Groups[1].Value}else{-1})} } } }); ConvertTo-Json -Compress -InputObject $items`;
  try {
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: windowsChildEnvironment({ FLOW_PROFILE_DIR: path.resolve(profileDir) }), windowsHide: true,
      encoding: 'utf8', timeout: 20_000, maxBuffer: 8192,
    });
    const items = JSON.parse(output);
    if (!Array.isArray(items) || items.length > 1) throw profileError('FLOW_PROFILE_PROCESS_AMBIGUOUS');
    return items[0] ?? null;
  } catch (error) {
    if (error?.code?.startsWith('FLOW_PROFILE_')) throw error;
    throw profileError('FLOW_PROFILE_PROCESS_CHECK_FAILED');
  }
}

export function hiddenProfileArgs(profileDir) {
  return [`--user-data-dir=${path.resolve(profileDir)}`, '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--start-minimized', '--window-position=-32000,-32000', 'https://flow.google.com/'];
}

export async function resolveProfileEndpoint({ profileDir = DEFAULT_PROFILE_DIR, launch = false,
  inspectImpl = inspectProfileProcess, readFileImpl = readFile, launchImpl,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), fetchImpl = fetch } = {}) {
  profileDir = path.resolve(profileDir);
  let owner = inspectImpl(profileDir);
  if (!owner && launch) {
    await mkdir(profileDir, { recursive: true });
    if (launchImpl) await launchImpl(profileDir);
    else {
      // The already authorized profile only. No profile copy, stealth flags, or security weakening.
      const child = spawn(DEFAULT_CHROME, hiddenProfileArgs(profileDir), { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(profileError('FLOW_PROFILE_LAUNCH_FAILED'))); });
      child.unref();
    }
    for (let i = 0; i < 40 && !owner; i += 1) { await sleep(250); owner = inspectImpl(profileDir); }
  }
  if (!owner) throw profileError('FLOW_PROFILE_NOT_RUNNING');
  if (owner.debug !== true) throw profileError('FLOW_PROFILE_NOT_DEBUGGABLE');
  let port = owner.port;
  if (port === 0) {
    for (let i = 0; i < 40; i += 1) {
      try { port = Number((await readFileImpl(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]); } catch { port = 0; }
      if (Number.isInteger(port) && port > 0 && port < 65536) break;
      await sleep(250);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw profileError('FLOW_PROFILE_PORT_UNAVAILABLE');
  const endpoint = `http://127.0.0.1:${port}`;
  let info;
  try {
    const response = await fetchImpl(endpoint + '/json/version', { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (response.status !== 200) throw new Error();
    info = await response.json();
    const url = new URL(info.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port
      || !url.pathname.startsWith('/devtools/browser/') || url.search || url.hash || url.username || url.password) throw new Error();
  } catch { throw profileError('FLOW_PROFILE_CDP_UNAVAILABLE'); }
  const current = inspectImpl(profileDir);
  if (!current || current.pid !== owner.pid || current.debug !== true) throw profileError('FLOW_PROFILE_PROCESS_CHANGED');
  return { endpoint, webSocketUrl: info.webSocketDebuggerUrl, profileDir };
}

export async function connectProfileCdp(options = {}) {
  const resolved = await resolveProfileEndpoint(options);
  const socket = new WebSocket(resolved.webSocketUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  const failPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(profileError('FLOW_PROFILE_CDP_DISCONNECTED')); } pending.clear(); };
  socket.addEventListener('close', failPending);
  socket.addEventListener('error', failPending);
  socket.addEventListener('message', event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.id) {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(profileError('FLOW_PROFILE_CDP_COMMAND_FAILED'));
      else item.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(profileError('FLOW_PROFILE_CDP_TIMEOUT')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(profileError('FLOW_PROFILE_CDP_UNAVAILABLE')); }, { once: true });
  });
  return {
    ...resolved,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(method, params = {}, sessionId) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(profileError('FLOW_PROFILE_CDP_DISCONNECTED'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(profileError('FLOW_PROFILE_CDP_TIMEOUT')); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { listeners.clear(); failPending(); socket.close(); },
  };
}
