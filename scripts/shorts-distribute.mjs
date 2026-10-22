// Distribute a set of finished vertical Shorts to every channel from ONE manifest; resumable (state file next to it).
//   node scripts/shorts-distribute.mjs <distribute.json> [--channels=youtube,youtube-pin,naver-clip,tiktok,instagram] [--only=s1,s2] [--dry]
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
//   "longform": { "url": "https://youtu.be/…", "relatedTitle": "<title prefix in the Studio picker>" },
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
const save = () => fs.writeFileSync(stateFile, JSON.stringify(S, null, 2) + '\n');
const channels = (opt.channels || 'youtube,youtube-pin,naver-clip,tiktok,instagram').split(',');
const only = opt.only ? opt.only.split(',') : null;
const work = path.join(os.tmpdir(), 'shorts-distribute', path.basename(manFile, '.json')); fs.mkdirSync(work, { recursive: true });
const st = (id) => (S.shorts[id] ||= {});
const log = (o) => console.log(JSON.stringify(o));

// run one helper script; its LAST JSON line is the result
function run(script, args, timeoutMs = 600000) {
  if (opt.dry) { log({ dry: script, args }); return { ok: true, dry: true }; }
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 << 20 });
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter((l) => l.startsWith('{'));
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { status: r.status, lines: parsed, last: parsed.at(-1) || null, stderr: String(r.stderr || '').slice(-400) };
}

// ---------- texts ----------
const linkBlock = (s) => (s.links?.length ? ['', M.common.affiliateDisclosure, ...s.links.map((l) => `- ${l.label}\n  ${l.url}`)] : []);
const ytDesc = (s) => [s.desc, ...linkBlock(s), '', `🎬 풀영상: ${M.longform.url}`, '', M.common.footer].join('\n');
const pinText = (s) => [s.question, '', `🎬 풀영상: ${M.longform.url}`, ...linkBlock(s)].join('\n');
const socialText = (s) => [s.title, '', s.desc, '', s.question, '', M.common.socialNote, '', s.hashtags].join('\n');
const clipText = (s) => { let t = `${s.desc} ${s.question} ${M.common.clipNote || ''} ${s.hashtags}`.replace(/\s+/g, ' ').trim(); while ([...t].length > 300) t = t.replace(/ \S+$/, ''); return t; };
const write = (name, text) => { const f = path.join(work, name); fs.writeFileSync(f, text + '\n'); return f; };
const videoOf = (s) => path.join(M.videoDir, (M.videoName || '{id}.mp4').replace('{id}', s.id));
const thumbOf = (s) => path.join(M.thumbDir, `${s.id}.jpg`);
const publishAt = (i) => { // [Date, studio date string]
  if (i === 0 || !M.schedule) return [new Date(), null];
  const d = new Date(M.schedule.from + 'T00:00:00'); d.setDate(d.getDate() + i - 1);
  const [h, mnt] = M.schedule.time.replace(/^오[전후] /, '').split(':').map(Number); d.setHours((/오후/.test(M.schedule.time) && h < 12 ? h + 12 : h), mnt);
  return [d, `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`];
};

const list = M.shorts.map((s, i) => ({ s, i })).filter(({ s }) => !only || only.includes(s.id));
for (const { s, i } of list) {
  const x = st(s.id);
  if (channels.includes('youtube') && !x.youtube?.videoId) {
    const [when, dateStr] = publishAt(i);
    const job = { channelId: M.channelId, video: videoOf(s), title: s.title, description: ytDesc(s), tags: M.common.tags, category: M.common.category || '여행/이벤트',
      language: '한국어', madeForKids: false, paidPromotion: !!s.links?.length, alteredContent: true, visibility: 'PUBLIC',
      ...(dateStr ? { schedule: { date: dateStr, time: M.schedule.time } } : {}) };
    const jf = write(`${s.id}.yt-job.json`, JSON.stringify(job, null, 1));
    const r = run('youtube-studio.mjs', ['upload', jf, `--shots=${path.join(work, 'yt-' + s.id)}`], 900000);
    const vid = r.lines.find((l) => l.videoId)?.videoId; const done = r.lines.some((l) => l.step === 'upload-complete');
    x.youtube = { videoId: vid || null, publishAt: when.toISOString(), uploaded: done || !!r.dry, paid: job.paidPromotion };
    save(); log({ id: s.id, ch: 'youtube', ...x.youtube, error: done ? undefined : r.stderr || r.last });
    if (!done && !r.dry) continue;
  }
  if (channels.includes('youtube') && x.youtube?.videoId && !x.youtube.edited) {
    const r = run('youtube-studio-edit.mjs', [x.youtube.videoId, `--thumb=${thumbOf(s)}`, `--related=${M.longform.relatedTitle}`]);
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
    const r = run('naver-clip-upload.mjs', [videoOf(s), write(`${s.id}.clip.txt`, clipText(s)), `--blog=${M.naverBlogTitle}`, '--ai']);
    x.naverClip = r.last || { ok: !!r.dry }; save(); log({ id: s.id, ch: 'naver-clip', ...x.naverClip });
  }
  if (channels.includes('tiktok') && !x.tiktok?.ok) {
    const r = run('tiktok-studio-upload.mjs', [videoOf(s), write(`${s.id}.social.txt`, socialText(s)), '--ai', '--post', `--shots=${path.join(work, 'tt-' + s.id)}`]);
    x.tiktok = r.last || { ok: !!r.dry }; save(); log({ id: s.id, ch: 'tiktok', ...x.tiktok });
  }
  if (channels.includes('instagram') && !x.instagram?.ok) {
    const recent = Object.values(S.shorts).map((v) => v.instagram?.at).filter(Boolean).filter((a) => Date.now() - new Date(a) < 20 * 3600e3).length;
    if (recent >= (M.instagramPerDay ?? 1)) { log({ id: s.id, ch: 'instagram', skipped: `daily limit ${M.instagramPerDay ?? 1} reached; run again tomorrow` }); continue; }
    const r = run('instagram-web-post.mjs', [write(`${s.id}.social.txt`, socialText(s)), videoOf(s), '--ai']);
    x.instagram = { ...(r.last || { ok: !!r.dry }), at: new Date().toISOString() }; if (!x.instagram.ok) delete x.instagram.at; save(); log({ id: s.id, ch: 'instagram', ...x.instagram });
  }
}
// summary: what is still open
const open = M.shorts.map((s) => { const x = S.shorts[s.id] || {}; return { id: s.id, youtube: x.youtube?.videoId || '-', pinned: !!x.youtube?.pinned, publishAt: x.youtube?.publishAt?.slice(0, 16), naverClip: !!x.naverClip?.ok, tiktok: !!x.tiktok?.ok, instagram: !!x.instagram?.ok }; });
console.table(open);
