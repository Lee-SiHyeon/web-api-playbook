import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const botProcessKey = (spec, pid) => spec.script + '#' + pid;
export function botPidMayExist(pid, probe = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { probe(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Return only script identity booleans. Command lines stay inside the probe.
// A failed probe is unknown, never evidence that it is safe to launch a copy.
export async function readBotProcessPresence(requests, { pidAlive = botPidMayExist, processReader = exec } = {}) {
  const result = new Map(), pending = new Map();
  for (const { spec, pid } of requests) {
    const key = botProcessKey(spec, pid);
    if (!pidAlive(pid)) { result.set(key, false); continue; }
    if (!/^[a-z0-9][a-z0-9_.-]{0,100}\.mjs$/.test(spec.script) || !Number.isSafeInteger(pid) || pid <= 0) {
      throw Object.assign(new Error(), { code: 'BOT_PID_PROBE_INPUT' });
    }
    result.set(key, null); pending.set(key, { spec, pid });
  }
  if (!pending.size) return result;
  if (pending.size > 50) throw Object.assign(new Error(), { code: 'BOT_PID_PROBE_INPUT' });
  const ids = [...new Set([...pending.values()].map(row => row.pid))];
  const rows = [...pending.entries()].map(([key, { spec, pid }]) => {
    const pattern = `(?:^|[\\\\/\\s\"])${spec.script.replaceAll('.', '\\.')}($|[\\s\"])`;
    return `$botRow=@($botProcesses | Where-Object { $_.ProcessId -eq ${pid} }); $botPresent=$null; if($botRow.Count -eq 0){$botPresent=$false} elseif($botRow.Count -eq 1 -and $botRow[0].Name -ne 'node.exe'){$botPresent=$false} elseif($botRow.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace($botRow[0].CommandLine)){$botPresent=($botRow[0].Name -eq 'node.exe' -and $botRow[0].CommandLine -match '${pattern}')} ; [pscustomobject]@{ key='${key}'; present=$botPresent }`;
  });
  const command = `$botProcesses=@(Get-CimInstance Win32_Process -Filter '${ids.map(pid => 'ProcessId = ' + pid).join(' OR ')}' -ErrorAction Stop); $botResults=@(${rows.join('; ')}); ConvertTo-Json -Compress -InputObject $botResults`;
  try {
    const response = await processReader('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 });
    const values = JSON.parse(response.stdout);
    if (Array.isArray(values)) for (const row of values) {
      if (pending.has(row?.key) && typeof row.present === 'boolean') result.set(row.key, row.present);
    }
  } catch { /* Still-live identities remain unknown. */ }
  for (const [key, { pid }] of pending) if (!pidAlive(pid)) result.set(key, false);
  return result;
}

export function botWorkerPresence(spec, status, previous, presence, now = Date.now()) {
  const current = presence.get(botProcessKey(spec, status.pid));
  const launched = presence.get(botProcessKey(spec, previous.pid));
  const workerAlive = current === true || launched === true;
  const identityPending = !workerAlive && (current === null || launched === null);
  return { workerAlive: identityPending ? null : workerAlive, identityPending,
    pid: current === true ? status.pid : launched === true ? previous.pid : status.pid || previous.pid || null,
    startupPending: launched === true && status.pid !== previous.pid
      && now - Date.parse(previous.restartedAt || '') >= 0 && now - Date.parse(previous.restartedAt || '') < 60_000 };
}
