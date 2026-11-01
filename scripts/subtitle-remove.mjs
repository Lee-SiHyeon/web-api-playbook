#!/usr/bin/env node
// Hard-subtitle removal through PiAPI (owner 2026-10-26: "상용으로 돌려", "신규 무료 크레딧 있으면 그거 써봐").
// The local OCR + MI-GAN eraser (shorts-anatomy/removal/erase.py) took 38+ min of CPU for a 37 s clip and stalled the
// automation Canary, so removal runs on PiAPI's Qubico/video-toolkit `remove-subtitle` task ($0.006 per source second,
// rounded up; 2026-10-26 docs). PiAPI takes a video URL, not a file: pass a public MP4 URL (seller videos already have one)
// or --offer to resolve a 1688 offer's seller video. PiAPI's own upload endpoint needs a paid plan.
//   node scripts/subtitle-remove.mjs --url <https mp4> --out <file.mp4> [--region x,y,w,h] [--source-file <local original>]
//   node scripts/subtitle-remove.mjs --offer <1688 offerId> --out <file.mp4> [--region x,y,w,h]
//   node scripts/subtitle-remove.mjs --balance
// Key: protected store entry `piapi-api-key` (never printed). Writes <out>, <out>.provenance.json and appends a cost line to
// %LOCALAPPDATA%\web-api-playbook\piapi-ledger.jsonl.
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ProtectedStore } from '../lib/protected-store.mjs';

const API = 'https://api.piapi.ai/api/v1';
const PRICE_PER_SECOND = 0.006;
const RESULT_HOSTS = /(^|\.)(piapi\.ai|theapi\.app|storage\.googleapis\.com|amazonaws\.com|cloudflarestorage\.com|r2\.dev)$/;
const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(process.argv[i]);
  if (!m) { console.error(JSON.stringify({ error: 'UNKNOWN_ARGUMENT' })); process.exit(2); }
  opts[m[1]] = m[2] ?? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true);
}
const fail = (code, detail) => { console.error(JSON.stringify({ error: code, ...(detail ? { detail } : {}) })); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = new ProtectedStore().read('piapi-api-key');
if (!key) fail('PIAPI_KEY_MISSING', 'store the key as protected entry piapi-api-key');
const api = async (method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok || (j && j.code && j.code !== 200)) fail('PIAPI_HTTP_FAILED', { status: r.status, message: String(j?.message ?? j?.data?.error?.message ?? '').slice(0, 300) });
  return j?.data ?? j;
};

if (opts.balance) {
  const r = await fetch('https://api.piapi.ai/account/info', { headers: { 'x-api-key': key } });
  const j = await r.json().catch(() => null);
  console.log(JSON.stringify({ status: r.status, credits: j?.data?.equivalent_in_usd ?? j?.data?.credits ?? null, plan: j?.data?.plan ?? null }));
  process.exit(0);
}
if (typeof opts.out !== 'string') fail('OUT_REQUIRED');
let videoUrl = typeof opts.url === 'string' ? opts.url : null;
let source = { kind: 'url' };
if (!videoUrl && typeof opts.offer === 'string') {
  const { create1688Client } = await import('../lib/video-sources/alibaba-1688.mjs');
  const m = await create1688Client({}).offerMedia({ offerId: opts.offer });
  if (!m.video?.playUrl) fail('OFFER_HAS_NO_VIDEO');
  videoUrl = m.video.playUrl; source = { kind: '1688-offer', offerId: opts.offer, videoId: m.video.videoId, supplier: m.supplier?.companyName ?? null };
}
if (!videoUrl || !/^https:\/\//.test(videoUrl)) fail('VIDEO_URL_REQUIRED');

const input = { video: videoUrl };
if (typeof opts.region === 'string') {
  const [x, y, width, height] = opts.region.split(',').map(Number);
  if (![x, y, width, height].every(Number.isFinite)) fail('REGION_INVALID');
  input.region = { x, y, width, height }; // original-pixel rectangle (PiAPI FAQ); omitted = automatic text detection
}
const created = await api('POST', '/task', { model: 'Qubico/video-toolkit', task_type: 'remove-subtitle', input });
const taskId = created.task_id;
if (!taskId) fail('PIAPI_NO_TASK_ID');
console.error(JSON.stringify({ step: 'created', taskId }));
let task;
for (const t0 = Date.now(); Date.now() - t0 < 30 * 60 * 1000;) {
  await sleep(8000);
  task = await api('GET', `/task/${taskId}`);
  const status = String(task.status ?? '').toLowerCase();
  if (status === 'completed') break;
  if (status === 'failed') fail('PIAPI_TASK_FAILED', { taskId, error: task.error ?? null });
}
const outUrl = task?.output?.video ?? task?.output?.video_url ?? task?.output?.url;
if (!outUrl) fail('PIAPI_NO_OUTPUT', { taskId, output: Object.keys(task?.output ?? {}) });
if (!RESULT_HOSTS.test(new URL(outUrl).hostname)) fail('RESULT_HOST_NOT_ALLOWED', new URL(outUrl).hostname);
const out = path.resolve(opts.out);
mkdirSync(path.dirname(out), { recursive: true });
const res = await fetch(outUrl);
if (!res.ok) fail('RESULT_DOWNLOAD_FAILED', res.status);
await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
const bytes = readFileSync(out);
const seconds = Number(task?.meta?.usage?.duration ?? task?.input?.duration ?? NaN);
const receipt = { taskId, model: 'Qubico/video-toolkit', taskType: 'remove-subtitle', region: input.region ?? 'auto', source,
  sourceVideoHost: new URL(videoUrl).hostname, resultHost: new URL(outUrl).hostname, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length, at: new Date().toISOString(), usage: task?.meta?.usage ?? null,
  estimatedUsd: Number.isFinite(seconds) ? +(Math.ceil(seconds) * PRICE_PER_SECOND).toFixed(4) : null };
const srcProv = typeof opts['source-file'] === 'string' && existsSync(`${opts['source-file']}.provenance.json`)
  ? JSON.parse(readFileSync(`${opts['source-file']}.provenance.json`, 'utf8')) : null;
writeFileSync(`${out}.provenance.json`, JSON.stringify({ ...(srcProv ?? {}), derivedFrom: srcProv ? opts['source-file'] : null, subtitleRemoval: receipt }, null, 2));
const ledgerDir = path.join(process.env.LOCALAPPDATA ?? '.', 'web-api-playbook'); mkdirSync(ledgerDir, { recursive: true });
appendFileSync(path.join(ledgerDir, 'piapi-ledger.jsonl'), JSON.stringify({ at: receipt.at, taskId, taskType: 'remove-subtitle', usage: receipt.usage, estimatedUsd: receipt.estimatedUsd, out }) + '\n');
console.log(JSON.stringify({ ok: true, out, taskId, bytes: bytes.length, usage: receipt.usage, estimatedUsd: receipt.estimatedUsd }));
