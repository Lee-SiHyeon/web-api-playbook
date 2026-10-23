// Publication hold: a file the owner (or an assistant on the owner's word) sets to stop writes without killing the bot.
// Every publish child process (adaptive route, mirrors, SNS) checks it on start, so a hold works on an already running bot.
//   node publish-hold.mjs set --all --reason="..."         hold every publication
//   node publish-hold.mjs set --match=<text> --reason=...   hold runs/briefs whose path contains <text>
//   node publish-hold.mjs clear [--all | --match=<text>]    release
//   node publish-hold.mjs list
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOLD_FILE = path.join(process.env.LOCALAPPDATA ?? path.resolve(process.cwd(), '.runtime'), 'affiliate-content-operations', 'publish-hold.json');
const norm = p => String(p ?? '').replace(/\\/g, '/').toLowerCase();

export function readHolds(file = HOLD_FILE) {
  if (!existsSync(file)) return { all: null, matches: [] };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { all: j.all ?? null, matches: Array.isArray(j.matches) ? j.matches : [] };
  } catch {
    return { all: { reason: 'publish-hold.json을 읽을 수 없어 전체 보류', at: null }, matches: [] };
  }
}

// paths: run dir, brief dir or any path of the write in question.
export function holdFor(paths, file = HOLD_FILE) {
  const h = readHolds(file);
  if (h.all) return { held: true, reason: h.all.reason ?? '전체 발행 보류', scope: 'all' };
  const list = [].concat(paths).filter(Boolean).map(norm);
  const hit = h.matches.find(m => m.match && list.some(p => p.includes(norm(m.match))));
  return hit ? { held: true, reason: hit.reason ?? `${hit.match} 발행 보류`, scope: hit.match } : { held: false };
}

export function assertNotHeld(paths, file = HOLD_FILE) {
  const h = holdFor(paths, file);
  if (h.held) { const e = new Error('PUBLISH_HELD'); e.code = 'PUBLISH_HELD'; e.reason = h.reason; e.scope = h.scope; throw e; }
}

export function setHold({ all = false, match = null, reason = '' } = {}, file = HOLD_FILE, now = () => new Date().toISOString()) {
  const h = readHolds(file);
  const at = now();
  if (all) h.all = { reason: reason || '전체 발행 보류', at };
  else if (match) h.matches = [...h.matches.filter(m => m.match !== match), { match, reason: reason || `${match} 발행 보류`, at }];
  else throw new Error('HOLD_TARGET_REQUIRED');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(h, null, 2) + '\n');
  return h;
}

export function clearHold({ all = false, match = null } = {}, file = HOLD_FILE) {
  const h = readHolds(file);
  if (all) { h.all = null; h.matches = []; }
  else if (match) h.matches = h.matches.filter(m => m.match !== match);
  else throw new Error('HOLD_TARGET_REQUIRED');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(h, null, 2) + '\n');
  return h;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = n => rest.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  const opts = { all: rest.includes('--all'), match: arg('match'), reason: arg('reason') ?? '' };
  try {
    if (cmd === 'set') console.log(JSON.stringify({ ok: true, holds: setHold(opts) }));
    else if (cmd === 'clear') console.log(JSON.stringify({ ok: true, holds: clearHold(opts) }));
    else if (cmd === 'list') console.log(JSON.stringify({ ok: true, holds: readHolds() }));
    else { console.log(JSON.stringify({ ok: false, code: 'USAGE' })); process.exitCode = 1; }
  } catch (e) { console.log(JSON.stringify({ ok: false, code: e.message })); process.exitCode = 1; }
}
