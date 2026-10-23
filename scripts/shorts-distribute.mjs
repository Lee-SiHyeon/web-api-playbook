// Distribute a set of finished vertical Shorts to every channel from ONE manifest; resumable (state file next to it).
//   node scripts/shorts-distribute.mjs <distribute.json> [--channels=youtube,youtube-pin,naver-clip,tiktok,instagram,facebook,threads,x] [--only=s1,s2] [--dry] [--retry-x] [--check]
// Default channels: all. Re-running skips what the state file already records, so the daily follow-up is the same command:
//   - youtube      upload (s1 public now, the rest scheduled one per day), then thumbnail + related long video (youtube-studio-edit)
//   - youtube-pin  post + pin the comment on every uploaded short; scheduled ones go through youtube-prepin.mjs (they take no
//                  comments while private: unlisted for ~1 min, pin, back to the same schedule), so nothing is left for later
//   - naver-clip   clip with description (<= 300 chars), linked Naver blog post, AI toggle
//   - tiktok       post with caption + AI label (links are not clickable there, so none are put in)
//   - instagram    Reel with AI label; at most `instagramPerDay` per 20 h (a new account gets rate-limited on bursts)
// Built for the Tokyo summary Shorts 2026-10-22 (references/longform-to-shorts-2026-10-19.md, "Runbook"). Every step calls the
// single-purpose scripts in this folder and records their JSON result; nothing here talks to a site directly.
//
// distribute.json:
// { "channelId": "UC…", "videoDir": "C:/…/upload", "thumbDir": "C:/…/thumbs", "videoName": "tokyo-short-{id}.mp4",
//   "longform": { "url": "https://youtu.be/…", "relatedTitle": "<title prefix in the Studio picker>" },   // optional: standalone Shorts
//   "naverBlogTitle": "<title part of the Naver post to link from the clip>",
//   "schedule": { "from": "2026-10-23", "time": "오후 6:00" },            // s[0] public now, s[i] = from + (i-1) days
//   "instagramPerDay": 1,
//   "common": { "footer": "…", "tags": ["…"], "affiliateDisclosure": "[제휴] …", "category": "여행/이벤트", "socialNote": "…" },
//   "shorts": [ { "id": "s1", "title": "…", "desc": "…", "question": "…", "hashtags": "#a #b", "links": [{ "label": "…", "url": "…" }] } ] }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const [manFile, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const M = JSON.parse(fs.readFileSync(manFile, 'utf8'));
const stateFile = manFile.replace(/\.json$/, '') + '.state.json';
const S = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { shorts: {} };
const save = () => { if (!opt.dry) fs.writeFileSync(stateFile, JSON.stringify(S, null, 2) + '\n'); }; // a dry run records nothing
const channels = (opt.channels || 'youtube,youtube-pin,naver-clip,tiktok,instagram,facebook,threads,x').split(',');
const only = opt.only ? opt.only.split(',') : null;
const work = path.join(os.tmpdir(), 'shorts-distribute', path.basename(manFile, '.json')); fs.mkdirSync(work, { recursive: true });
const st = (id) => (S.shorts[id] ||= {});
const log = (o) => console.log(JSON.stringify(o));

// run one helper script; its LAST JSON line is the result
function run(script, args, timeoutMs = 600000) {
  if (opt.dry) { log({ dry: script, args }); return { ok: true, dry: true, lines: [] }; }
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 << 20 });
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter((l) => l.startsWith('{'));
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { status: r.status, lines: parsed, last: parsed.at(-1) || null, stderr: String(r.stderr || '').slice(-400) };
}

// ---------- texts ----------
const linkBlock = (s) => (s.links?.length ? ['', M.common.affiliateDisclosure, ...s.links.map((l) => `- ${l.label}\n  ${l.url}`)] : []);
const fullLine = () => (M.longform?.url ? ['', `🎬 풀영상: ${M.longform.url}`] : []); // standalone Shorts have no long video
// The Short's own hashtags were missing from YouTube (only the shared footer ones went in): one merged, de-duplicated tag
// line at the end; YouTube shows the first three above the title.
const cut = (t, n) => { let s = String(t); while ([...s].length > n) s = s.replace(/\s*\S+$/, ''); return s; };
// X counts CJK as 2: title, the first link, then hashtags while the weighted length stays under 280 (links count 23)
const xWeight = (t) => [...t.replace(/https?:\/\/\S+/g, 'x'.repeat(23))].reduce((n, ch) => n + (/[ᄀ-￿]/.test(ch) ? 2 : 1), 0);
const xText = (s) => {
  const link = (String(s.desc).match(/https?:\/\/\S+/) || [])[0];
  let t = [s.title, link ? `🎮 ${link}` : ''].filter(Boolean).join('\n');
  for (const tag of String(s.hashtags || '').split(/\s+/).filter(Boolean)) if (xWeight(t + ' ' + tag) <= 270) t += (t.includes('#') ? ' ' : '\n') + tag;
  return t;
};
const tagLine = (...texts) => [...new Set(texts.join(' ').match(/#[^\s#]+/g) || [])].join(' ');
const ytDesc = (s) => [s.desc, ...linkBlock(s), ...fullLine(), '', String(M.common.footer).replace(/#[^\s#]+/g, '').trim(), '', tagLine(s.hashtags || '', M.common.footer)].join('\n');
const pinText = (s) => s.pin || [s.question, ...fullLine(), ...linkBlock(s)].join('\n'); // s.pin: a custom pinned comment
const socialText = (s) => [s.title, '', s.desc, '', s.question, '', M.common.socialNote, '', s.hashtags].join('\n');
// Naver Clip shows the description as plain text: links are not clickable and long URLs wrap mid-word. Keep paragraphs
// (blank lines), drop lines that carry an http(s) link (put a bare domain once in common.clipNote instead), max 300 chars.
const noUrl = (t) => String(t || '').split('\n').filter((l) => !/https?:\/\//.test(l)).join('\n').trim();
const clipText = (s) => {
  const sentences = noUrl(s.desc).split(/(?<=[.!?。])\s+/);
  const build = (n) => [s.title, sentences.slice(0, n).join(' '), s.question, noUrl(M.common.clipNote), s.hashtags].filter(Boolean)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim()).join('\n\n');
  let n = sentences.length, t = build(n);
  while ([...t].length > 300 && n > 1) t = build(--n);
  while ([...t].length > 300) t = t.replace(/\s*\S+$/, '');
  return t;
};
export function clipLint(t) { // errors that make a clip description look broken on the clip page
  const errs = [];
  if ([...t].length > 300) errs.push('CLIP_OVER_300');
  if (/https?:\/\//.test(t)) errs.push('CLIP_HTTP_LINK');
  const doms = t.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi) || [];
  if (doms.length !== new Set(doms.map((d) => d.toLowerCase())).size) errs.push('CLIP_DUPLICATE_LINK');
  if (!/\n/.test(t)) errs.push('CLIP_NO_LINE_BREAKS');
  return errs;
}
const write = (name, text) => { const f = path.join(work, name); fs.writeFileSync(f, text + '\n'); return f; };
const videoOf = (s) => path.join(M.videoDir, (M.videoName || '{id}.mp4').replace('{id}', s.id));
const thumbOf = (s) => path.join(M.thumbDir, `${s.id}.jpg`);
const publishAt = (i) => { // [Date, studio date string]
  if (i === 0 || !M.schedule) return [new Date(), null];
  const d = new Date(M.schedule.from + 'T00:00:00'); d.setDate(d.getDate() + i - 1);
  const [h, mnt] = M.schedule.time.replace(/^오[전후] /, '').split(':').map(Number); d.setHours((/오후/.test(M.schedule.time) && h < 12 ? h + 12 : h), mnt);
  return [d, `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`];
};

// TikTok pacing ledger (shared by every manifest): { pausedUntil, perDay, minGapHours, posts: [iso] }
const ttLedger = process.env.TIKTOK_LEDGER || path.join(os.homedir(), '.config', 'web-api-playbook', 'tiktok-ledger.json');
const ttRead = () => { try { return JSON.parse(fs.readFileSync(ttLedger, 'utf8')); } catch { return { perDay: 2, minGapHours: 4, posts: [] }; } };
function tiktokGate() {
  const L = ttRead(), now = Date.now();
  if (L.pausedUntil && now < new Date(L.pausedUntil).getTime()) return `paused until ${L.pausedUntil} (${L.reason || 'ledger'})`;
  const recent = (L.posts || []).map((t) => new Date(t).getTime()).filter((t) => now - t < 24 * 3600e3);
  if (recent.length >= (L.perDay ?? 2)) return `daily cap ${L.perDay ?? 2} reached; run again later`;
  const last = Math.max(0, ...recent);
  if (last && now - last < (L.minGapHours ?? 4) * 3600e3) return `min gap ${L.minGapHours ?? 4} h since ${new Date(last).toISOString()}`;
  return null;
}
function tiktokRecord() { const L = ttRead(); L.posts = [...(L.posts || []), new Date().toISOString()].slice(-200); fs.mkdirSync(path.dirname(ttLedger), { recursive: true }); fs.writeFileSync(ttLedger, JSON.stringify(L, null, 1)); }

const list = opt.check ? [] : M.shorts.map((s, i) => ({ s, i })).filter(({ s }) => !only || only.includes(s.id)); // --check: gate only, posts nothing
for (const { s, i } of list) {
  const x = st(s.id);
  if (channels.includes('youtube') && !x.youtube?.videoId) {
    const [when, dateStr] = publishAt(i);
    const job = { channelId: M.channelId, video: videoOf(s), title: s.title, description: ytDesc(s), tags: M.common.tags, category: M.common.category || '여행/이벤트',
      language: '한국어', madeForKids: false, paidPromotion: !!s.links?.length, alteredContent: M.common.alteredContent ?? true, visibility: 'PUBLIC',
      ...(dateStr ? { schedule: { date: dateStr, time: M.schedule.time } } : {}) };
    const jf = write(`${s.id}.yt-job.json`, JSON.stringify(job, null, 1));
    const r = run('youtube-studio.mjs', ['upload', jf, `--shots=${path.join(work, 'yt-' + s.id)}`], 900000);
    const vid = r.lines.find((l) => l.videoId)?.videoId; const done = r.lines.some((l) => l.step === 'upload-complete');
    x.youtube = { videoId: vid || null, publishAt: when.toISOString(), uploaded: done || !!r.dry, paid: job.paidPromotion };
    save(); log({ id: s.id, ch: 'youtube', ...x.youtube, error: done ? undefined : r.stderr || r.last });
    if (!done && !r.dry) continue;
  }
  if (channels.includes('youtube') && x.youtube?.videoId && !x.youtube.edited) {
    const editArgs = [...(M.thumbDir && fs.existsSync(thumbOf(s)) ? [`--thumb=${thumbOf(s)}`] : []), ...(M.longform?.relatedTitle ? [`--related=${M.longform.relatedTitle}`] : [])];
    const r = editArgs.length ? run('youtube-studio-edit.mjs', [x.youtube.videoId, ...editArgs]) : { last: { ok: true, skipped: 'no thumbnail or related video' } };
    x.youtube.edited = !!r.last?.ok || !!r.dry; save(); log({ id: s.id, ch: 'youtube-edit', ...(r.last || {}) });
  }
  if (channels.includes('youtube-pin') && x.youtube?.videoId && !x.youtube.pinned) {
    // public -> pin directly; scheduled -> youtube-prepin (unlisted for ~1 min, pin, back to the same schedule)
    const at = new Date(x.youtube.publishAt), pinFile = write(`${s.id}.pin.txt`, pinText(s));
    const studioDate = `${at.getFullYear()}. ${at.getMonth() + 1}. ${at.getDate()}.`, h = at.getHours(), studioTime = `${h < 12 ? '오전' : '오후'} ${((h + 11) % 12) + 1}:${String(at.getMinutes()).padStart(2, '0')}`;
    const r = at <= new Date() ? run('youtube-pin-comment.mjs', [x.youtube.videoId, pinFile, path.join(work, 'pin-' + s.id), '--shorts'])
      : run('youtube-prepin.mjs', [x.youtube.videoId, pinFile, studioDate, studioTime, '--shorts']);
    if (r.last && r.last.pin) r.last.badge = r.last.pin.badge;
    x.youtube.pinned = /고정함/.test(r.last?.badge || '') || !!r.dry; save(); log({ id: s.id, ch: 'youtube-pin', ...(r.last || {}) });
  }
  if (channels.includes('naver-clip') && !x.naverClip?.ok) {
    const ct = clipText(s), lint = clipLint(ct);
    if (lint.length) { log({ id: s.id, ch: 'naver-clip', error: 'CLIP_LINT', lint, text: ct }); continue; }
    const r = run('naver-clip-upload.mjs', [videoOf(s), write(`${s.id}.clip.txt`, ct), ...(M.naverBlogTitle ? [`--blog=${M.naverBlogTitle}`] : []), '--ai']);
    x.naverClip = r.last || { ok: !!r.dry }; save(); log({ id: s.id, ch: 'naver-clip', ...x.naverClip });
  }
  if (channels.includes('tiktok') && !x.tiktok?.ok) {
    // One ledger for every manifest: a new account that got 6 posts in 5 minutes (2026-10-22) dropped from 100-245 views per
    // post to 0 from the next post on. Pause date, daily cap and minimum gap apply across series.
    const gate = tiktokGate();
    if (gate) { x.tiktokDeferred = gate; log({ id: s.id, ch: 'tiktok', skipped: gate }); }
    else {
      const r = run('tiktok-studio-upload.mjs', [videoOf(s), write(`${s.id}.tiktok.txt`, noUrl(socialText(s))), '--ai', '--post', `--shots=${path.join(work, 'tt-' + s.id)}`]);
      x.tiktok = r.last || { ok: !!r.dry }; delete x.tiktokDeferred; save(); log({ id: s.id, ch: 'tiktok', ...x.tiktok });
      if (x.tiktok.ok && !opt.dry) tiktokRecord();
    }
  }
  if (channels.includes('instagram') && !x.instagram?.ok) {
    const recent = Object.values(S.shorts).map((v) => v.instagram?.at).filter(Boolean).filter((a) => Date.now() - new Date(a) < 20 * 3600e3).length;
    if (recent >= (M.instagramPerDay ?? 1)) log({ id: s.id, ch: 'instagram', skipped: `daily limit ${M.instagramPerDay ?? 1} reached; run again tomorrow` });
    else {
      const r = run('instagram-web-post.mjs', [write(`${s.id}.social.txt`, socialText(s)), videoOf(s), '--ai']);
      x.instagram = { ...(r.last || { ok: !!r.dry }), at: new Date().toISOString() }; if (!x.instagram.ok) delete x.instagram.at; save(); log({ id: s.id, ch: 'instagram', ...x.instagram });
    }
  }
  // Facebook Page, Threads and X were posted by hand before 2026-10-23 and two of them were forgotten: they are channels here now
  if (channels.includes('facebook') && !x.facebook?.ok) {
    const r = run('facebook-web.mjs', ['post', videoOf(s), write(`${s.id}.facebook.txt`, s.facebookText || socialText(s))], 900000);
    x.facebook = { ok: !!r.last?.posted || !!r.dry, aiLabel: r.last?.aiLabel, actor: r.last?.actor }; save(); log({ id: s.id, ch: 'facebook', ...x.facebook });
  }
  if (channels.includes('threads') && !x.threads?.ok) {
    const r = run('sns-web-post.mjs', ['threads', write(`${s.id}.threads.txt`, cut(s.threadsText || socialText(s), 500)), videoOf(s)], 900000);
    x.threads = { ok: !!(r.last?.posted && (r.last?.url || '').includes('/' + (r.last?.account || '@?') + '/')) || !!r.dry, url: r.last?.url, account: r.last?.account, error: r.last?.error }; save(); log({ id: s.id, ch: 'threads', ...x.threads });
  }
  if (channels.includes('x') && !x.x?.ok) {
    // never auto-retry X: a "failed" run has posted before (the composer closed late) and the retry made a duplicate
    if (x.x?.attempted && !opt['retry-x']) log({ id: s.id, ch: 'x', skipped: 'an earlier attempt did not confirm; check the profile, then rerun with --retry-x' });
    else {
      x.x = { attempted: new Date().toISOString() }; save();
      const r = run('sns-web-post.mjs', ['x', write(`${s.id}.x.txt`, s.xText || xText(s)), videoOf(s)], 900000);
      x.x = { ...x.x, ok: !!r.last?.posted || !!r.dry, url: r.last?.url, osClick: r.last?.osClick, error: r.last?.error }; save(); log({ id: s.id, ch: 'x', ...x.x });
    }
  }
}
// gate: every requested channel must be confirmed for every Short; a pacing deferral is a warning, anything else fails the run
const okOf = { youtube: (x) => !!x.youtube?.videoId && x.youtube.uploaded !== false, 'youtube-pin': (x) => !!x.youtube?.pinned, 'naver-clip': (x) => !!x.naverClip?.ok,
  tiktok: (x) => !!x.tiktok?.ok, instagram: (x) => !!x.instagram?.ok, facebook: (x) => !!x.facebook?.ok, threads: (x) => !!x.threads?.ok, x: (x) => !!x.x?.ok };
const rows = M.shorts.filter((s) => !only || only.includes(s.id)).map((s) => { const x = S.shorts[s.id] || {}; return { id: s.id, ...Object.fromEntries(channels.filter((c) => okOf[c]).map((c) => [c, okOf[c](x) ? 'ok' : c === 'tiktok' && x.tiktokDeferred ? 'deferred' : 'MISSING'])) }; });
console.table(rows);
const missing = rows.flatMap((r) => Object.entries(r).filter(([, v]) => v === 'MISSING').map(([c]) => `${r.id}:${c}`));
console.log(JSON.stringify({ gate: 'DIST_SHORTS', ok: !missing.length, missing, deferred: rows.filter((r) => Object.values(r).includes('deferred')).map((r) => r.id) }));
if (missing.length && !opt.dry) process.exitCode = 1;
