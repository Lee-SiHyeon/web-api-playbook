#!/usr/bin/env node
// Read-only follow audit. Exits FOLLOW_STATUS_PARTIAL_READ instead of reporting from a partial follower list.
import { pathToFileURL } from 'node:url';
import { auditFollowers, followStatusFromRead } from './follow-status-gate.mjs';
export async function runFollowAudit(handles = [], { readFollowers } = {}) {
  const r = await readFollowers();
  const audit = auditFollowers(r);
  return { ...audit, handles: Object.fromEntries(handles.map(h => [h, followStatusFromRead(r, h).status])) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readThreadsFollowers } = await import('./threads-social.mjs');
  runFollowAudit(process.argv.slice(2), { readFollowers: () => readThreadsFollowers() })
    .then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.log(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(e?.code || '') ? e.code : 'FOLLOW_AUDIT_ERROR' })); process.exitCode = 2; });
}
