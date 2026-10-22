// Long-form (16:9, burned-in subtitles) -> vertical Shorts, cut (not re-voiced). v2 2026-10-22 (Tokyo), v1 2026-10-19 (Bangkok).
// Layout (stacked, 1080x1920): blurred copy of the picture as background · label + 2-line hook title (line 1 leads with the
// source creator's name) · the 16:9 picture with its burned subtitle band cropped off · big captions (ASS, libass) under it.
// Text stays inside the Shorts safe zone (y 120..1415; right edge <= 900 below y 960, the button column).
//
//   node scripts/longform-to-shorts.mjs plan  <spec.json>                 -> cut points, durations, caption counts
//   node scripts/longform-to-shorts.mjs build <spec.json>                 -> <out>/ass/*.ass, render.sh, segments.final.json, README.md
//                                                                            + glyph check (every drawn char must exist in the font)
//   node scripts/longform-to-shorts.mjs still <spec.json> <id> <sec,…>    -> local preview JPGs (single frames only; light)
//   node scripts/longform-to-shorts.mjs kit   <spec.json> <branch>        -> push the render kit (ass, font, render.sh, README) as an
//                                                                            orphan branch of spec.renderRepo; prints the worker job text
// Then send the printed job to the render worker (Dots: `node scripts/dots.mjs send <room> "<job>"`, fallback Grok Bot), download
// the outputs from the release, check them (ffprobe + last frames + any patch window) and publish with shorts-distribute.mjs.
//
// spec.json (paths relative to the spec):
// { "plan": "../tokyo-v1/cloud-render/plan.json",     // aihost plan: cut on scene edges (scenes[]) and captions from plan.subs
//   "timed": "timed.ko.json",                         // OR sentence timings [{s,e,ko}] with from/to cuts (v1 specs)
//   "video": "../tokyo-v1/final/final-bgm.mp4",       // local copy, only for `still`
//   "ffmpeg": "C:/…/ffmpeg.exe", "fontFile": "C:/…/BlackHanSans-Regular.ttf", "fontName": "Black Han Sans",
//   "out": "build", "label": "곽범 [연차없이 어떡행2] 도쿄 편 | AI 진행자 리아",
//   "pictureCrop": [1920, 930, 0, 0],                  // w,h,x,y of the source kept (subtitle band cut; keep the full width when
//                                                      // location cards / the AI badge sit at the edges)
//   "renderRepo": "Lee-SiHyeon/longform-render", "sourceRelease": "tokyo-v1-out", "sourceAsset": "final.mp4", "outRelease": "tokyo-shorts-v1-out",
//   "shorts": [ { "id": "s1", "scenes": ["s00a","s01"], "out": 39.48, "title": ["곽범 연차 0일 도쿄", "115만 원, 진짜 돼?"],
//                 "patches": [{ "t0": 323.59, "t1": 327.03, "fadeIn": 100, "box": [596,338,326,80], "color": "1872E8",
//                               "text": "카트 주행", "textRight": 906, "textCy": 377, "fs": 60 }],   // source-frame px/seconds
//                 "blur": [{ "t0": 323.2, "t1": 324.1, "box": [586,280,336,150] }] } ] }
// Lessons encoded (Tokyo 2026-10-22):
//  - Cut on plan scene edges: no mid-shot cut, no narration syllable from the next sentence.
//  - The longform crossfades into the next scene over its last ~0.3 s: the last HOLD s are a frozen clean frame.
//  - The encoded file can be one frame longer than the cut: persistent lines and patches run to dur+1 s (a missing title / an
//    uncovered patch on the last frame happened).
//  - A caption must overlap the cut by >= 0.3 s (the next scene's caption flashed for 2 frames).
//  - Black Han Sans lacks 「」·…▶ and many rare syllables; esc() maps the common ones and `build` fails on any other missing glyph.
//    Ship only that font to the worker: a system "Noto Sans" shadowed "Noto Sans KR" on the cloud box (fallback to a CJK font).
//  - A patch over an animated element must start on its first visible frame; while it fades/slides in, blur the region instead.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const [cmd, specFile, ...rest] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const base = path.dirname(path.resolve(specFile));
const P = (p) => path.resolve(base, p);
const FF = spec.ffmpeg ? (/[\\/]/.test(spec.ffmpeg) ? P(spec.ffmpeg) : spec.ffmpeg) : 'ffmpeg';
const FONT_NAME = spec.fontName || 'Black Han Sans';
const OUT = P(spec.out || 'build');
const HOLD = spec.holdSec ?? 0.32;
const [CW, CH, CX, CY] = spec.pictureCrop || [1920, 930, 0, 0];
const PW = 1080, PH = Math.round(CH * PW / CW), PY = spec.pictureY ?? 470; // 930 -> 523 (odd is fine: only the final frame must be even)
const k = PW / CW;

// ---------- cuts + captions ----------
function segments() {
  if (spec.plan) {
    const plan = JSON.parse(fs.readFileSync(P(spec.plan), 'utf8'));
    const sc = Object.fromEntries(plan.scenes.map((s) => [s.id, s]));
    return spec.shorts.map((g) => {
      const a = sc[g.scenes[0]], b = sc[g.scenes.at(-1)];
      if (!a || !b) throw new Error(`SCENE_UNKNOWN ${g.id}`);
      const tin = +a.t0.toFixed(2), tout = +(g.out ?? b.t1).toFixed(2), dur = +(tout - tin).toFixed(2);
      const subs = plan.subs.filter((s) => s.t1 > tin + 0.3 && s.t0 < tout - 0.3).map((s) => ({ t0: Math.max(0, s.t0 - tin), t1: Math.min(dur, s.t1 - tin), text: s.text }));
      return { g, tin, tout, dur, subs };
    });
  }
  const timed = (() => { const t = JSON.parse(fs.readFileSync(P(spec.timed), 'utf8')); return t.sentences || t; })();
  return spec.shorts.map((g) => {
    const tin = g.from, tout = g.to, dur = +(tout - tin).toFixed(2);
    const subs = timed.filter((x) => x.e > tin + 0.3 && x.s < tout - 0.3).map((x) => ({ t0: Math.max(0, x.s - tin), t1: Math.min(dur, x.e - tin), text: x.ko }));
    return { g, tin, tout, dur, subs };
  });
}

// ---------- ASS ----------
const ts = (t) => { const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
const esc = (s) => String(s).replace(/[「」]/g, "'").replace(/…/g, '...').replace(/·/g, ',').replace(/▶/g, '>').replace(/\\/g, '\\\\').replace(/{/g, '(').replace(/}/g, ')');
const wrap = (text, max = 13) => { const out = []; let cur = ''; for (const w of text.split(/\s+/)) { if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; } if (cur) out.push(cur); return out.join('\\N'); };
function assFor({ g, tin, tout, dur, subs }) {
  const X = (x) => +(x * k).toFixed(2), Y = (y) => +((y - CY) * k + PY).toFixed(2);
  const patchLines = (g.patches || []).flatMap((p) => {
    const [bx, by, bw, bh] = p.box, bgr = p.color.match(/../g).reverse().join('');
    const t0 = ts(p.t0 - tin), t1 = ts(p.t1 >= tout ? dur + 1 : p.t1 - tin), fad = `\\fad(${p.fadeIn || 0},${p.fadeOut || 0})`;
    const at = (x, y) => p.dy ? `\\move(${X(x)},${+(Y(y) + p.dy * k).toFixed(2)},${X(x)},${Y(y)},0,${p.moveMs})` : `\\pos(${X(x)},${Y(y)})`;
    return [
      `Dialogue: 0,${t0},${t1},Cap,,0,0,0,,{\\an7${at(bx, by)}\\p1\\bord0\\shad0\\1c&H${bgr}&${fad}}m 0 0 l ${X(bw)} 0 ${X(bw)} ${+(bh * k).toFixed(2)} 0 ${+(bh * k).toFixed(2)}{\\p0}`,
      `Dialogue: 1,${t0},${t1},Cap,,0,0,0,,{\\an6${at(p.textRight, p.textCy)}\\fs${Math.round(p.fs * k)}\\bord0\\shad0\\1c&HFFFFFF&${fad}}${esc(p.text)}`,
    ];
  });
  const capTop = PY + PH + 47;
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Label,${FONT_NAME},36,&H00E6E6E6,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,0,8,40,40,140,1`,
    `Style: T1,${FONT_NAME},96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,7,0,8,40,40,196,1`,
    `Style: T2,${FONT_NAME},96,&H003BD4FF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,7,0,8,40,40,304,1`,
    `Style: Cap,${FONT_NAME},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,6,0,8,60,180,${capTop},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 1,${ts(0)},${ts(dur + 1)},Label,,0,0,0,,${esc(spec.label || '')}`,
    `Dialogue: 1,${ts(0)},${ts(dur + 1)},T1,,0,0,0,,${esc(g.title[0])}`,
    `Dialogue: 1,${ts(0)},${ts(dur + 1)},T2,,0,0,0,,${esc(g.title[1] || '')}`,
    ...subs.map((s) => `Dialogue: 2,${ts(s.t0)},${ts(s.t1)},Cap,,0,0,0,,${wrap(esc(s.text))}`),
    ...patchLines,
  ].join('\n') + '\n';
}
function filterGraph({ g, tin, dur }, assPath, fontsDir, head = `[0:v]trim=end=${(dur - HOLD).toFixed(2)},tpad=stop_mode=clone:stop_duration=${HOLD},`) {
  const blur = (g.blur || []).map((b, bi) => `,split[bm${bi}][bs${bi}];[bs${bi}]crop=${b.box[2]}:${b.box[3]}:${b.box[0] - CX}:${b.box[1] - CY},boxblur=14:3[bb${bi}];[bm${bi}][bb${bi}]overlay=${b.box[0] - CX}:${b.box[1] - CY}:enable='between(t,${(b.t0 - tin).toFixed(2)},${(b.t1 - tin).toFixed(2)})'`).join('');
  return [`${head}crop=${CW}:${CH}:${CX}:${CY}${blur},split=2[bgsrc][fgsrc]`,
    '[bgsrc]scale=-2:1920,crop=1080:1920,boxblur=24:2,eq=brightness=-0.16:saturation=0.9[bg]',
    `[fgsrc]scale=${PW}:${PH}[fg]`,
    `[bg][fg]overlay=0:${PY},subtitles=${assPath}:fontsdir=${fontsDir},format=yuv420p[v]`].join(';');
}

// ---------- glyph check (minimal TTF cmap reader, formats 4 and 12) ----------
function cmapOf(file) {
  const buf = fs.readFileSync(file); const u16 = (o) => buf.readUInt16BE(o), u32 = (o) => buf.readUInt32BE(o), i16 = (o) => buf.readInt16BE(o);
  let off0 = 0; for (let i = 0, n = u16(4); i < n; i++) { const r = 12 + i * 16; if (buf.toString('latin1', r, r + 4) === 'cmap') off0 = u32(r + 8); }
  const has = new Set();
  for (let i = 0, n = u16(off0 + 2); i < n; i++) {
    const off = off0 + u32(off0 + 4 + i * 8 + 4), fmt = u16(off);
    if (fmt === 4) { const seg = u16(off + 6) / 2, ends = off + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ros = deltas + seg * 2;
      for (let s = 0; s < seg; s++) { const e = u16(ends + s * 2), st = u16(starts + s * 2), d = i16(deltas + s * 2), ro = u16(ros + s * 2);
        for (let c = st; c <= e && c !== 0xffff; c++) { let gl; if (ro === 0) gl = (c + d) & 0xffff; else { gl = u16(ros + s * 2 + ro + (c - st) * 2); if (gl) gl = (gl + d) & 0xffff; } if (gl) has.add(c); } }
    } else if (fmt === 12) { for (let q = 0, ng = u32(off + 12); q < ng; q++) { const b = off + 16 + q * 12; for (let c = u32(b); c <= u32(b + 4); c++) has.add(c); } }
  }
  return has;
}
function glyphCheck(files) {
  const has = cmapOf(P(spec.fontFile)); const miss = {};
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.startsWith('Dialogue:')) continue;
    for (const ch of line.split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '').split('\\N').join('')) if (ch !== ' ' && !has.has(ch.codePointAt(0))) (miss[ch] ||= new Set()).add(path.basename(f));
  }
  return Object.fromEntries(Object.entries(miss).map(([c, v]) => [c, [...v].join(' ')]));
}

const segs = segments();
if (cmd === 'plan') {
  for (const s of segs) console.log(s.g.id, s.tin, '->', s.tout, `${s.dur}s`, 'captions', s.subs.length, s.g.title.join(' / '), s.dur > 60 ? 'OVER_60S' : '');
} else if (cmd === 'build') {
  fs.mkdirSync(path.join(OUT, 'ass'), { recursive: true });
  const sh = ['#!/usr/bin/env bash', 'set -euo pipefail', `# ffmpeg with libass; ./src/${spec.sourceAsset || 'final.mp4'}; ./fonts holds ONLY ${path.basename(spec.fontFile)}`, 'mkdir -p out'];
  const fin = [];
  for (const s of segs) {
    fs.writeFileSync(path.join(OUT, 'ass', `${s.g.id}.ass`), assFor(s));
    const af = `afade=t=in:st=0:d=0.03,afade=t=out:st=${(s.dur - 0.08).toFixed(2)}:d=0.08`;
    sh.push(`ffmpeg -y -v error -ss ${s.tin} -t ${s.dur} -i src/${spec.sourceAsset || 'final.mp4'} -filter_complex "${filterGraph(s, `ass/${s.g.id}.ass`, 'fonts')}" -map "[v]" -map 0:a -af "${af}" -r 30 -c:v libx264 -preset medium -crf 18 -profile:v high -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/${spec.outPrefix || 'short-'}${s.g.id}.mp4`);
    fin.push({ id: s.g.id, in: s.tin, out: s.tout, dur: s.dur, title: s.g.title, captions: s.subs.length });
  }
  sh.push('ls -la out');
  fs.writeFileSync(path.join(OUT, 'render.sh'), sh.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'segments.final.json'), JSON.stringify(fin, null, 1));
  const miss = glyphCheck(segs.map((s) => path.join(OUT, 'ass', `${s.g.id}.ass`)));
  for (const f of fin) console.log(f.id, f.in, '->', f.out, `${f.dur}s`, 'captions', f.captions);
  if (Object.keys(miss).length) { console.log('GLYPH_MISSING', JSON.stringify(miss)); process.exit(1); }
  console.log('GLYPHS ok ->', OUT);
} else if (cmd === 'still') {
  const [id, secs] = rest; const s = segs.find((x) => x.g.id === id); if (!s) throw new Error('NO_SHORT ' + id);
  const assP = path.join(OUT, 'ass', `${id}.ass`).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  const fontsDir = path.dirname(P(spec.fontFile)).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
  for (const f of secs.split(',').map(Number)) {
    const o = path.join(OUT, 'stills', `${id}-${f.toFixed(2).replace('.', '_')}.jpg`);
    const r = spawnSync(FF, ['-v', 'error', '-y', '-ss', String(s.tin + f), '-i', P(spec.video), '-filter_complex', `[0:v]setpts=PTS+${f.toFixed(2)}/TB,` + filterGraph(s, `'${assP}'`, `'${fontsDir}'`, ''), '-map', '[v]', '-frames:v', '1', o], { encoding: 'utf8' });
    console.log(r.status ? 'FAIL ' + r.stderr.slice(0, 300) : o);
  }
} else if (cmd === 'kit') {
  const [branch] = rest; if (!branch) throw new Error('usage: kit <spec> <branch>');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-kit-'));
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  spawnSync('gh', ['repo', 'clone', spec.renderRepo, dir, '--', '--depth', '1', '-q'], { encoding: 'utf8' });
  const exists = spawnSync('git', ['ls-remote', '--heads', 'origin', branch], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  if (exists) { git('fetch', '-q', '--depth', '1', 'origin', branch); git('checkout', '-q', '-B', branch, 'FETCH_HEAD'); }
  else { git('checkout', '-q', '--orphan', branch); git('rm', '-rq', '--cached', '.'); }
  for (const e of fs.readdirSync(dir)) if (e !== '.git') fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  fs.cpSync(path.join(OUT, 'ass'), path.join(dir, 'ass'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fonts')); fs.copyFileSync(P(spec.fontFile), path.join(dir, 'fonts', path.basename(spec.fontFile)));
  for (const f of ['render.sh', 'segments.final.json']) fs.copyFileSync(path.join(OUT, f), path.join(dir, f));
  const src = spec.sourceAsset || 'final.mp4';
  const job = `저장소 ${spec.renderRepo} 브랜치 ${branch}의 README 순서대로 렌더해 줘(브라우저 필요 없음, ffmpeg만): ffmpeg(libass) 설치 → gh release download ${spec.sourceRelease} -p ${src} -D src → 폰트 확인(fonts/의 ${path.basename(spec.fontFile)}만 잡혀야 함, 다른 폰트/Glyph not found면 중단) → bash render.sh → ffprobe(1080x1920, 30fps, 길이 segments.final.json dur ±0.1s, 48kHz 2ch) → gh release upload ${spec.outRelease} out/*.mp4 --clobber (릴리스가 없으면 gh release create). 다른 파일·커밋은 건드리지 말고, 끝나면 에셋 크기와 ffprobe 결과를 알려 줘.`;
  fs.writeFileSync(path.join(dir, 'README.md'), `# Shorts render kit\n\n${job}\n\nDo not edit the .ass files, crop/overlay numbers or cut points (checked against the Shorts safe zone and the font cmap).\n`);
  git('add', '-A');
  git('commit', '-qm', `shorts kit ${branch}`); // uses the machine's git identity
  git('push', '-q', 'origin', branch);
  console.log(JSON.stringify({ branch, commit: git('rev-parse', '--short', 'HEAD'), job }));
} else {
  console.log('usage: longform-to-shorts.mjs plan|build|still|kit <spec.json> …'); process.exitCode = 2;
}
