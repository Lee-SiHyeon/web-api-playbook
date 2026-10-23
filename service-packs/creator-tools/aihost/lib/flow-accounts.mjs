// Flow accounts: credits check per account, one automatic re-handoff on an auth error, and the order used by the clips stage
// (free accounts first, most credits first; PRO last; failed accounts last). Result rows are recorded in the registry.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const AUTH_ERR = /LOGIN_REQUIRED|TOKEN_MISSING|AUTH_COOKIE|DOCUMENT_REDIRECT/;

// one CLI call of the google-flow-api project for account index u; returns the full text
export function flowCli(flowDir, argv, u, timeout = 120000) {
  const r = spawnSync(process.execPath, ['src/cli.mjs', ...argv], { cwd: flowDir, encoding: 'utf8', timeout, env: { ...process.env, FLOW_AUTHUSER: String(u) } });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

// re-issue the saved session for this account (the browser is fine; the stored session was in the wrong slot)
export function handoffOnce(flowDir, a) {
  spawnSync(process.execPath, ['src/cdp-handoff.mjs', '--project', a.project, '--owner', a.owner, '--only', 'flow'],
    { cwd: flowDir, encoding: 'utf8', timeout: 120000, env: { ...process.env, FLOW_AUTHUSER: String(a.u) } });
}

export function parseCredits(text) {
  const c = text.match(/"credits":\s*(\d+)/);
  const t = text.match(/"tier":\s*"([^"]+)"/);
  const n = text.match(/"nextRefill[A-Za-z]*":\s*"([^"]+)"/);
  return { credits: c ? +c[1] : null, tier: t ? t[1] : null, nextRefill: n ? n[1] : null };
}

export function toKst(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  return p + ' KST'; // 2026-10-21 09:00:00 KST
}

export const isPro = (tier) => /pro/i.test(tier || '');

// one row per account; one automatic handoff and re-query when the first answer is an auth error
export function checkAccounts({ accounts, flowDir, run = flowCli, handoff = handoffOnce }) {
  return accounts.map((a) => {
    let text = run(flowDir, ['credits'], a.u);
    let p = parseCredits(text);
    let reauthed = false;
    if (p.credits == null && AUTH_ERR.test(text)) {
      handoff(flowDir, a); reauthed = true;
      text = run(flowDir, ['credits'], a.u);
      p = parseCredits(text);
    }
    return { u: a.u, owner: a.owner ?? null, project: a.project, credits: p.credits, tier: p.tier, ...(a.pro ? { pro: true } : {}),
      nextRefill: p.nextRefill ? toKst(p.nextRefill) : null, status: p.credits == null ? 'failed' : 'ok', reauthed,
      error: p.credits == null ? text.slice(-160) : null };
  });
}

// the clips order: free first (most credits first), PRO last, failed accounts after that
export function orderAccounts(rows) {
  const ok = rows.filter((r) => r.status === 'ok');
  const by = (a, b) => (b.credits - a.credits) || (a.u - b.u);
  // the credits call does not report a tier (2026-10-23: every account came back tier null and the PRO account, holding the most
  // credits, was used first); series.json flowAccounts[].pro marks the paid account explicitly
  const paid = (r) => r.pro === true || isPro(r.tier);
  const free = ok.filter((r) => !paid(r)).sort(by);
  const pro = ok.filter(paid).sort(by);
  return [...free, ...pro, ...rows.filter((r) => r.status !== 'ok')];
}

// the registry is tracked in git: owners are stored masked only (the full address stays in series.local.json)
export const maskOwner = (o) => (o ? String(o).replace(/^(.{3}).*(@.*)$/, '$1***$2') : null);

export function recordAccounts(registryFile, rows, now = new Date()) {
  const reg = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : { series: '', episodes: {} };
  reg.accounts = { checkedAt: now.toISOString(), rows: rows.map((r) => ({ ...r, owner: maskOwner(r.owner) })) };
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify(reg, null, 1) + '\n');
}

export function accountTable(rows) {
  const head = ['u', 'owner', 'credits', 'tier', 'nextRefill (KST)', 'status'];
  const lines = rows.map((r) => [r.u, maskOwner(r.owner) || '-', r.credits ?? '-', r.tier ?? '-', r.nextRefill ?? '-', r.status + (r.reauthed ? ' (re-handoff)' : '')]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const fmt = (l) => l.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return [fmt(head), ...lines.map(fmt)].join('\n');
}

// accounts for a clips run: checked now, recorded in the registry, ordered free-first (PRO last); failed accounts are left out
export function orderedAccounts(config, { run = flowCli, handoff = handoffOnce } = {}) {
  const all = config.series.flowAccounts || [];
  const rows = checkAccounts({ accounts: all, flowDir: config.tools.flowCli, run, handoff });
  recordAccounts(config.registry, rows);
  return orderAccounts(rows).filter((r) => r.status === 'ok').map((r) => all.find((a) => a.u === r.u));
}

// project write fences of the Flow API (<flowDir>/.runtime/jobs/.flow-generation-<project>.lock): the job each one points to and
// whether it is stale (job finished or journal gone). The Flow API reclaims a stale fence on the next generate; doctor shows them.
const FINISHED_JOB = ['downloaded', 'rejected', 'preflight_failed'];
export function fenceReport(flowDir) {
  const jobDir = path.join(flowDir, '.runtime', 'jobs');
  if (!fs.existsSync(jobDir)) return [];
  return fs.readdirSync(jobDir).filter((n) => n.startsWith('.flow-generation-') && n.endsWith('.lock')).sort().map((n) => {
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(path.join(jobDir, n), 'utf8')); } catch { /* unreadable fence */ }
    const jobFile = typeof lock?.jobPath === 'string' ? path.join(jobDir, path.basename(lock.jobPath)) : null;
    let state = 'unreadable';
    if (jobFile && !fs.existsSync(jobFile)) state = 'missing';
    else if (jobFile) { try { state = JSON.parse(fs.readFileSync(jobFile, 'utf8')).state ?? 'unreadable'; } catch { state = 'unreadable'; } }
    return { file: n, projectId: lock?.projectId ?? null, jobId: lock?.jobId ?? null, state, stale: state === 'missing' || FINISHED_JOB.includes(state) };
  });
}
