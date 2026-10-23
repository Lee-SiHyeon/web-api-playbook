// Localize many YouTube videos (Shorts or long) in one resumable run: original-language captions + N localized tracks
// (title, description, SRT) per video, through youtube-studio.mjs captions. 2026-10-23 (19 Shorts x 9 languages).
//   node scripts/youtube-captions-batch.mjs <batch.json> [--only=key1,key2] [--dry]
// batch.json:
//   { "channelId": "UC...", "srtDir": "C:/.../srt", "locDir": "C:/.../loc",
//     "original": "ko",                                     // <srtDir>/<key>.<original>.srt replaces the auto captions; omit to skip
//     "langs": { "en": "영어", "ja": "일본어", ... },        // srt language code -> Studio language label (Studio UI in Korean)
//     "items": [ { "key": "macau-s1", "videoId": "..." }, ... ] }
//   <srtDir>/<key>.<lang>.srt and <locDir>/<key>.json = { "<lang>": { "title": "...", "description": "..." } } per item.
// State: <batch>.state.json (done keys skipped). A video stopped mid-way resumes: youtube-studio.mjs skips languages whose
// captions are already 게시됨 and completes a language row that has a title but no captions.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const [batchFile, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
if (!batchFile) { console.error('usage: youtube-captions-batch.mjs <batch.json> [--only=a,b] [--dry]'); process.exit(2); }
const B = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
const stFile = batchFile.replace(/\.json$/, '') + '.state.json';
const st = fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, 'utf8')) : {};
const work = path.join(path.dirname(path.resolve(batchFile)), 'captions-jobs'); fs.mkdirSync(work, { recursive: true });
const items = B.items.filter((x) => !opt.only || String(opt.only).split(',').includes(x.key)).filter((x) => !st[x.key]?.ok);
for (const it of items) {
  const loc = JSON.parse(fs.readFileSync(path.join(B.locDir, `${it.key}.json`), 'utf8'));
  const job = { channelId: B.channelId, videoId: it.videoId, captions: {
    ...(B.original ? { original: path.win32.normalize(path.join(B.srtDir, `${it.key}.${B.original}.srt`)) } : {}),
    tracks: Object.entries(B.langs).map(([l, label]) => ({ label, srt: path.win32.normalize(path.join(B.srtDir, `${it.key}.${l}.srt`)), title: loc[l]?.title, description: loc[l]?.description })) } };
  const missing = [job.captions.original, ...job.captions.tracks.map((t) => t.srt)].filter((f) => f && !fs.existsSync(f));
  if (missing.length) { console.log(JSON.stringify({ key: it.key, error: 'MISSING_FILES', missing })); continue; }
  const jf = path.join(work, `${it.key}.json`); fs.writeFileSync(jf, JSON.stringify(job, null, 1));
  if (opt.dry) { console.log(JSON.stringify({ key: it.key, videoId: it.videoId, tracks: job.captions.tracks.length })); continue; }
  const r = spawnSync(process.execPath, [path.join(HERE, 'youtube-studio.mjs'), 'captions', jf, `--shots=${path.join(work, 'shots', it.key)}`], { encoding: 'utf8', timeout: 1800000 });
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  const tracks = lines.filter((l) => l.step === 'track' && /게시됨/.test(l.row || '')).length;
  const orig = !B.original || lines.some((l) => l.step === 'original' && l.ok);
  st[it.key] = { videoId: it.videoId, ok: r.status === 0 && orig && tracks === job.captions.tracks.length, original: orig, tracks, at: new Date().toISOString(), ...(r.status ? { err: lines.at(-1) } : {}) };
  fs.writeFileSync(stFile, JSON.stringify(st, null, 1));
  console.log(JSON.stringify({ key: it.key, ...st[it.key] }));
}
