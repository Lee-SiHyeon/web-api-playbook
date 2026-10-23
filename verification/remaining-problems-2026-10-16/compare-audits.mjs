import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const beforePath = 'verification/playbook-path-audit-2026-10-15/audit.json';
const afterPath = 'verification/remaining-problems-audit-2026-10-16-final/audit.json';
const [before, after] = await Promise.all([beforePath, afterPath].map(async file =>
  JSON.parse(await readFile(path.join(root, file), 'utf8'))));
const rows = report => new Map(report.services.flatMap(service => service.capabilities.map(cap =>
  [`${service.service}/${cap.id}`, { service: service.service, capabilityId: cap.id,
    status: cap.status, required: cap.priority === 'required', requiredPassed: cap.requiredPassed }])));
const oldRows = rows(before), newRows = rows(after);
const transitions = [], added = [], removed = [];
for (const [key, current] of newRows) {
  const previous = oldRows.get(key);
  if (!previous) added.push(current);
  else if (previous.status !== current.status) transitions.push({
    service: current.service, capabilityId: current.capabilityId,
    before: previous.status, after: current.status,
  });
}
for (const [key, previous] of oldRows) if (!newRows.has(key)) removed.push(previous);
const result = {
  schema: 'playbook-audit-comparison-v1', checkedAt: new Date().toISOString(),
  beforePath, afterPath, before: before.summary, after: after.summary,
  auditErrors: after.errors, missingReferences: after.inventory.missingReferences,
  interpretation: 'Offline status transitions compare recorded evidence and implementation hashes; they do not themselves establish a remote service regression or a fresh live replay.',
  added, removed, transitions,
  lostRecordedLive: transitions.filter(row => row.before === 'recorded_live' && row.after !== 'recorded_live'),
  gainedRecordedLive: transitions.filter(row => row.before !== 'recorded_live' && row.after === 'recorded_live'),
};
await writeFile(path.join(here, 'audit-comparison.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
