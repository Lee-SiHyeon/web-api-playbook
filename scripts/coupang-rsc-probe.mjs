import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readCoupangRsc } from '../lib/retail/coupang-rsc.mjs';
const args = process.argv.slice(2), out = args.find(x => x.startsWith('--out='))?.slice(6);
const authentication = args.includes('--visitor') ? 'visitor' : 'anonymous';
if (!out || args.length !== (authentication === 'visitor' ? 2 : 1)) throw new Error('USAGE_--out=NEW_FILE_[--visitor]_WITH_STDIN');
await mkdir(path.dirname(out), { recursive: true }); const file = await open(out, 'wx');
try {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 16384) throw new Error('INPUT_SIZE'); }
  let result;
  try { result = await readCoupangRsc(JSON.parse(text), { authentication }); }
  catch (e) { result = { ok: false, checkedAt: new Date().toISOString(), code: /^COUPANG_[A-Z_0-9]+$/.test(e.code ?? '') ? e.code : 'COUPANG_RSC_INPUT_FAILED',
    receipt: e.receipt ?? null, states: { captured: true, client_exists: true, remnant_free: 'transport_only_inputs_currently_browser_observed',
      credential_propagated: 'not_applicable_anonymous', live_replay: false } }; }
  text = '';
  await file.writeFile(JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, ok: result.ok, code: result.code, status: result.receipt?.status,
    mime: result.receipt?.contentType, server: result.receipt?.server, count: result.data?.products?.length,
    cookieSent: result.receipt?.cookieSent }));
  if (!result.ok) process.exitCode = 2;
} finally { await file.close(); }
