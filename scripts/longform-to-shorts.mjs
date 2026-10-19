// Long-form (16:9, burned-in subtitles, motion graphics) -> vertical Shorts, transcript-driven. 2026-10-19.
// Research (references/longform-to-shorts-2026-10-19.md): with an exact sentence-timed transcript, pick self-contained
// sentence spans instead of LLM/energy highlight detection; for map/motion-graphics footage face tracking and centre crops
// are useless, so use a STACKED layout: hook band (top) · 16:9 video with its burned subtitle band cropped off (middle) ·
// large re-timed captions (bottom) · end card pointing to the long video.
//
//   node scripts/longform-to-shorts.mjs plan   <spec.json>             -> prints spans/sentences/durations (no render)
//   node scripts/longform-to-shorts.mjs still  <spec.json> <id> <sec>  -> one 1080x1920 PNG at <sec> into the short (layout check)
//   node scripts/longform-to-shorts.mjs render <spec.json> [id]        -> MP4s (run where rendering is allowed, e.g. cloud)
//
// spec.json: { "video": "final.mp4", "timed": "timed.ko.json", "font": "BlackHanSans-Regular.ttf", "out": "shorts/",
//   "ffmpeg": "ffmpeg", "cropSubtitleBand": [0, 880], "brand": "생활이득AI연구소", "endCard": ["전체 코스는", "롱폼 영상에서 ▶"], "endUrl": "lifehackailab.com",
//   "shorts": [ { "id": "A", "from": 240.4, "to": 264.9, "hook": ["이 야시장", "이사했다"], "kicker": "곽범 방콕 코스" } ] }
// timed.ko.json: [{ s, e, ko }] sentence timings of the long video (seconds).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [cmd, specFile, ...rest] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const base = path.dirname(path.resolve(specFile));
const P = (p) => path.resolve(base, p);
const FF = spec.ffmpeg ? (/[\/]/.test(spec.ffmpeg) ? P(spec.ffmpeg) : spec.ffmpeg) : 'ffmpeg';
const timed = (() => { const t = JSON.parse(fs.readFileSync(P(spec.timed), 'utf8')); return t.sentences || t; })();
const C = { bg: '0x1d1a16', mark: '0xffc83d', white: 'white', accent: '0xe5483c' };
const W = 1080, H = 1920, VW = 1080;
const [cy0, cy1] = spec.cropSubtitleBand || [0, 880];
const VH = Math.round((cy1 - cy0) * VW / 1920 / 2) * 2;
const VY = 640;
const fontPath = P(spec.font).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');

function sentencesFor(sh) {
  return timed.filter((x) => x.s >= sh.from - 0.05 && x.e <= sh.to + 0.05).map((x) => ({ s: x.s - sh.from, e: x.e - sh.from, text: x.ko }));
}
function wrap(text, max = 13) {
  const words = text.split(' '); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur); return lines.slice(0, 3);
}
function filter(sh, { still } = {}) {
  const dur = sh.to - sh.from;
  const f = [];
  f.push(`color=c=${C.bg}:s=${W}x${H}:r=30:d=${dur.toFixed(2)}[bg]`);
  f.push(`[0:v]crop=1920:${cy1 - cy0}:0:${cy0},scale=${VW}:${VH},setsar=1[v]`);
  f.push(`[bg][v]overlay=0:${VY}:shortest=1[b0]`);
  let last = 'b0'; const add = (expr) => { const n = `b${f.length}`; f.push(`[${last}]${expr}[${n}]`); last = n; };
  add(`drawbox=x=0:y=${VY - 8}:w=${W}:h=8:color=${C.mark}@1:t=fill,drawbox=x=0:y=${VY + VH}:w=${W}:h=8:color=${C.mark}@1:t=fill`);
  if (sh.kicker) add(`drawtext=fontfile='${fontPath}':text='${esc(sh.kicker)}':fontsize=54:fontcolor=${C.mark}:x=(w-tw)/2:y=150`);
  sh.hook.forEach((line, i) => add(`drawtext=fontfile='${fontPath}':text='${esc(line)}':fontsize=128:fontcolor=${i === sh.hook.length - 1 ? C.mark : C.white}:borderw=6:bordercolor=black:x=(w-tw)/2:y=${250 + i * 150}`));
  // captions: one sentence at a time, wrapped, centred under the video
  for (const s of sentencesFor(sh)) {
    wrap(s.text).forEach((line, li, arr) => add(`drawtext=fontfile='${fontPath}':text='${esc(line)}':fontsize=76:fontcolor=white:borderw=7:bordercolor=black:x=(w-tw)/2:y=${VY + VH + 140 + li * 100 - (arr.length - 1) * 20}:enable='between(t,${s.s.toFixed(2)},${s.e.toFixed(2)})'`));
  }
  if (spec.brand) add(`drawtext=fontfile='${fontPath}':text='${esc(spec.brand)}':fontsize=40:fontcolor=white@0.75:x=(w-tw)/2:y=${H - 150}`);
  // end card over the last 2.5 s
  const ec = Math.max(0, dur - 2.5).toFixed(2);
  if (spec.endCard) {
    add(`drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.72:t=fill:enable='gte(t,${ec})'`);
    spec.endCard.forEach((line, i) => add(`drawtext=fontfile='${fontPath}':text='${esc(line)}':fontsize=104:fontcolor=${i ? C.mark : 'white'}:x=(w-tw)/2:y=${760 + i * 140}:enable='gte(t,${ec})'`));
    if (spec.endUrl) add(`drawtext=fontfile='${fontPath}':text='${esc(spec.endUrl)}':fontsize=58:fontcolor=white:x=(w-tw)/2:y=1100:enable='gte(t,${ec})'`);
  }
  return { graph: f.join(';'), out: last, dur };
}
const run = (args) => { const r = spawnSync(FF, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 26 }); if (r.error || r.status !== 0) throw new Error(String(r.error || r.stderr.toString().slice(-1500))); };

const pick = (id) => spec.shorts.filter((s) => !id || s.id === id);
if (cmd === 'plan') {
  for (const sh of spec.shorts) { const ss = sentencesFor(sh); console.log(JSON.stringify({ id: sh.id, seconds: +(sh.to - sh.from).toFixed(1), sentences: ss.length, first: ss[0]?.text, last: ss.at(-1)?.text })); }
} else if (cmd === 'still') {
  // render 1.2 s starting at <sec> and keep the last frame (a single-frame grab can precede the first video frame)
  const [id, sec] = rest; const sh0 = pick(id)[0]; const sh = { ...sh0, from: sh0.from + Number(sec) };
  const shift = Number(sec); const { graph, out } = filter({ ...sh, to: sh0.to });
  fs.mkdirSync(P(spec.out), { recursive: true });
  const file = path.join(P(spec.out), `${sh0.id}-still-${sec}.png`);
  const g = graph.replace(/enable='([^']*)'/g, (m, e) => `enable='${e.replace(/t/g, `(t+${shift})`)}'`);
  const tmp = file.replace(/\.png$/, '.tmp.mp4');
  run(['-ss', String(sh.from), '-t', '1.2', '-i', P(spec.video), '-filter_complex', g, '-map', `[${out}]`, '-t', '1.2', '-c:v', 'libx264', '-preset', 'ultrafast', tmp]);
  run(['-sseof', '-0.1', '-i', tmp, '-frames:v', '1', '-update', '1', file]); fs.rmSync(tmp, { force: true });
  console.log(file);
} else if (cmd === 'render') {
  fs.mkdirSync(P(spec.out), { recursive: true });
  for (const sh of pick(rest[0])) {
    const { graph, out, dur } = filter(sh);
    const file = path.join(P(spec.out), `short-${sh.id}.mp4`);
    run(['-ss', String(sh.from), '-t', dur.toFixed(2), '-i', P(spec.video), '-filter_complex', graph, '-map', `[${out}]`, '-map', '0:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', file]);
    console.log(JSON.stringify({ id: sh.id, file, seconds: +dur.toFixed(2) }));
  }
} else {
  console.error('usage: longform-to-shorts.mjs plan|still|render <spec.json> …'); process.exitCode = 2;
}
