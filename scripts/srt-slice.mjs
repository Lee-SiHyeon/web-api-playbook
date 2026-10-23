// Subtitles for Shorts cut from a long video, and for summary Shorts with their own narration. 2026-10-23.
//   node scripts/srt-slice.mjs cut <segments.json> <srtDir> <outDir> [--prefix=name-]
//        segments.json = [{ "id": "s1", "in": 0, "out": 47.1 }, ...] (longform-to-shorts.mjs writes it as segments.final.json).
//        Every <lang>.srt in srtDir is cut to each window (cues clipped, shifted to 0) -> <outDir>/<prefix><id>.<lang>.srt.
//        Translate the long video once, and every Short cut from it gets the same languages for free.
//   node scripts/srt-slice.mjs captions <captions.json> <out.srt>
//        captions.json = [{ "t0": 4.78, "t1": 6.06, "text": "..." }, ...] (short on-screen chunks) -> one cue per sentence
//        (merged until . ? ! or a 0.6 s gap or 5 s).
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const args = rest.filter((a) => !a.startsWith('--'));
export const toSec = (t) => { const [h, m, s] = t.replace(',', '.').split(':'); return +h * 3600 + +m * 60 + +s; };
export const toTime = (x) => { x = Math.max(0, x); const h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, s = x % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0').replace('.', ',')}`; };
export const parseSrt = (text) => text.replace(/\r/g, '').trim().split(/\n\n+/).map((b) => { const L = b.split('\n'); const [a, z] = L[1].split(' --> '); return { a: toSec(a), z: toSec(z), text: L.slice(2).join('\n') }; });
export const writeSrt = (cues) => cues.map((q, i) => `${i + 1}\n${toTime(q.a)} --> ${toTime(q.z)}\n${q.text}`).join('\n\n') + '\n';
// cues overlapping [from, to] by more than `edge` seconds, clipped and shifted to start at 0
export function cutCues(cues, from, to, edge = 0.15) {
  return cues.filter((q) => q.z > from + edge && q.a < to - edge).map((q) => ({ a: Math.max(q.a, from) - from, z: Math.min(q.z, to) - from, text: q.text }));
}
export function captionsToCues(chunks) {
  const cues = []; let cur = null;
  for (const k of chunks) {
    if (cur && k.t0 - cur.z > 0.6) { cues.push(cur); cur = null; }
    if (!cur) cur = { a: k.t0, z: k.t1, text: k.text }; else { cur.z = k.t1; cur.text += ' ' + k.text; }
    if (/[.?!]$/.test(k.text) || cur.z - cur.a > 5) { cues.push(cur); cur = null; }
  }
  if (cur) cues.push(cur);
  return cues;
}

if (cmd === 'cut') {
  const [segFile, srtDir, outDir] = args; const prefix = opt.prefix || '';
  const segs = JSON.parse(fs.readFileSync(segFile, 'utf8')); fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const f of fs.readdirSync(srtDir).filter((x) => x.endsWith('.srt'))) {
    const lang = f.slice(0, -4); const cues = parseSrt(fs.readFileSync(path.join(srtDir, f), 'utf8'));
    for (const s of segs) { const out = path.join(outDir, `${prefix}${s.id}.${lang}.srt`); fs.writeFileSync(out, writeSrt(cutCues(cues, s.in, s.out))); written.push(out); }
  }
  console.log(JSON.stringify({ shorts: segs.length, files: written.length }));
} else if (cmd === 'captions') {
  const [inp, out] = args; const raw = JSON.parse(fs.readFileSync(inp, 'utf8'));
  const cues = captionsToCues(Array.isArray(raw) ? raw : raw.captions); fs.writeFileSync(out, writeSrt(cues));
  console.log(JSON.stringify({ out, cues: cues.length }));
} else if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  console.error('usage: srt-slice.mjs cut <segments.json> <srtDir> <outDir> [--prefix=x-] | captions <captions.json> <out.srt>'); process.exitCode = 2;
}
