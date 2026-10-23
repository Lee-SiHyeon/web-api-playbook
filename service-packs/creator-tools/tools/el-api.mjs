if (process.argv.includes('--help')) { console.log('el-api.mjs — see service-packs/creator-tools/README.md for inputs and execution mode'); process.exit(0); }
// ElevenLabs REST with the DPAPI-stored key. Usage: node el-api.mjs <METHOD> <path> [jsonBodyFile]
import fs from 'node:fs';
import { ProtectedStore } from '../../../lib/protected-store.mjs';
const [method, p, bodyFile] = process.argv.slice(2);
const key = JSON.parse(new ProtectedStore().read('elevenlabs-api-key')).key;
const r = await fetch('https://api.elevenlabs.io' + p, { method, headers: { 'xi-api-key': key, 'content-type': 'application/json' },
  body: bodyFile ? fs.readFileSync(bodyFile, 'utf8') : undefined, signal: AbortSignal.timeout(900000) });
const t = await r.text();
process.stdout.write(JSON.stringify({ status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t.slice(0, 500); } })() }));
