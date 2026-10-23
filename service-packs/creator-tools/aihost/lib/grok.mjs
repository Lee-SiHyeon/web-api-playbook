// Grok quota handling. grok.com publishes availability only (quota_info -> {video720p:{available}, windowSizeSeconds:64800}),
// no counts. So the ledger is our own record: <series>/grok-ledger.jsonl with events
//   quota-check (available true|false), used (a clip made), skipped (not called: quota unavailable), cap-observed (first
//   time available:false was seen, with the uses counted in the window at that moment = observedCap, a reference value).
// Budget reporting: uses in the last 18 h (windowSizeSeconds 64800) + this episode's planned uses.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WINDOW_SEC = 64800; // 18 h, from quota_info windowSizeSeconds
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ledgerPath = (seriesRoot) => path.join(seriesRoot, 'grok-ledger.jsonl');

export function appendLedger(seriesRoot, entry, now = new Date()) {
  fs.mkdirSync(seriesRoot, { recursive: true });
  fs.appendFileSync(ledgerPath(seriesRoot), JSON.stringify({ at: now.toISOString(), ...entry }) + '\n');
}

export function readLedger(seriesRoot) {
  const f = ledgerPath(seriesRoot);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// quota_info response -> { available: true|false|null, windowSizeSeconds }
export function parseQuota(json) {
  const v = json?.video720p ?? json?.video ?? null;
  return { available: typeof v?.available === 'boolean' ? v.available : null, windowSizeSeconds: json?.windowSizeSeconds ?? json?.video?.windowSizeSeconds ?? null };
}

// what the storyboard reports: uses in the window, and the latest observed cap (reference only)
export function summarize(ledger, { nowMs = Date.now(), windowSec = WINDOW_SEC } = {}) {
  const from = nowMs - windowSec * 1000;
  const recentUses = ledger.filter((e) => e.event === 'used' && Date.parse(e.at) >= from).length;
  const caps = ledger.filter((e) => e.event === 'cap-observed');
  const lastQuota = ledger.filter((e) => e.event === 'quota-check').slice(-1)[0] || null;
  return { recentUses, windowSec, observedCap: caps.length ? caps[caps.length - 1].observedCap : null, lastQuota: lastQuota ? { at: lastQuota.at, available: lastQuota.available } : null };
}

export function decide(quota) {
  if (quota.available === true) return { ok: true };
  if (quota.available === false) return { ok: false, reason: 'quota-unavailable' };
  return { ok: false, reason: 'quota-check-unknown' };
}

// live check through the Canary tab (cookies live in the browser; see lib/grok-quota.mjs)
export function quotaInfo(cdp) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'grok-quota.mjs'), cdp || 'http://127.0.0.1:9333'], { encoding: 'utf8', timeout: 120000 });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { error: (r.stderr || 'no output').slice(-200) }; }
}

// Gate called before every Grok fallback. Returns { ok, reason }. Records quota-check / cap-observed / skipped in the ledger.
export function grokGate({ seriesRoot, cdp, episode, shot, windowSec = WINDOW_SEC, now = new Date(), quotaFetch = quotaInfo }) {
  const raw = quotaFetch(cdp);
  const quota = raw.error ? { available: null } : parseQuota(raw.body ?? raw);
  const before = readLedger(seriesRoot);
  const sum = summarize(before, { nowMs: now.getTime(), windowSec });
  appendLedger(seriesRoot, { event: 'quota-check', episode, shot, available: quota.available, error: raw.error || null }, now);
  if (quota.available === false && sum.lastQuota?.available !== false) {
    appendLedger(seriesRoot, { event: 'cap-observed', episode, shot, observedCap: sum.recentUses, windowSec }, now);
  }
  const d = decide(quota);
  if (!d.ok) appendLedger(seriesRoot, { event: 'skipped', episode, shot, reason: d.reason }, now);
  return d;
}
