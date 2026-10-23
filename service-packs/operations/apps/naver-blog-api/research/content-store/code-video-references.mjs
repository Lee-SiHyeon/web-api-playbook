// Code-rendered video references (owner 2026-09-29: "https://x.com/yihui_indie/status/2104122905961595267 영상만들때
// 참조할수있게 온톨로지 작업해놔"). The post shares 300+ Claude Opus 5.5 videos and their prompts; the collected list
// is github.com/yihui-dev/awesome-opus5-5-videos (data/videos.json: author, original post, category, tech tags, prompt).
// Each video is an HTML/canvas/three.js/svg scene rendered to MP4, the same kind our motion engine (sns/motion) renders.
//
// build: fetch the list → classify each prompt into formats, techniques and structure devices → map to our genres →
//        code-video-references.v1.json with each full prompt (owner: use prompts as is); excerpt is a display line.
// pick:  node code-video-references.mjs pick --genre=travel [--n=6] [--tech=threejs]  → references for a shot plan.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, 'code-video-references.v1.json');
const SOURCE = 'https://raw.githubusercontent.com/yihui-dev/awesome-opus5-5-videos/HEAD/data/videos.json';
const EXCERPT = 280;

// What the video is (one or more). Order matters only for readability.
export const FORMATS = {
  showreel: /showreel|sizzle|reel|show (me )?(the best|what)|go all out/i,
  product_ad: /\bads?\b|commercial|launch (video|film)|promo|product (video|film|demo)|brand (film|video)|app store/i,
  explainer: /explain|explainer|how .* works|educational|tutorial|walk ?through|lesson/i,
  data_story: /\bcharts?\b|\bgraphs?\b|data ?vi[sz]|infographic|statistic|leaderboard|bar chart race/i,
  kinetic_type: /kinetic|typograph|lyric|word(s)? (fly|slam|stack)|text animation|title sequence/i,
  map_travel: /\bmaps?\b|\bglobe\b|\bearth\b|\bflights?\b|\btravel|\btrip\b|postcard|\btour\b|landmark|landscape|street view|cityscape/i,
  ui_story: /\bui\b|user interface|dashboard|app (screen|ui|states)|mock ?up|phone screen|iphone|screen recording/i,
  scene_3d: /three\.?js|3d scene|\bblender\b|isometric|diorama|voxel|low[- ]poly/i,
  game: /\bgames?\b|playable|arcade/i,
  loop_art: /\bloop(ing)?\b|generative|infinite zoom|screensaver|ambient/i,
};
// How it moves or looks.
export const TECHNIQUES = {
  camera_move: /dolly|orbit|fly[- ]?through|zoom|pan\b|tracking shot|crane|push[- ]in|camera (moves|travels|flies)/i,
  match_cut: /match cut|morph|transform(s|ing)? into|seamless(ly)? transition|one (continuous|shot)|infinite zoom/i,
  particles: /particle|confetti|sparks?|dust|smoke|fireworks/i,
  shader_fx: /shader|glsl|bloom|chromatic|glitch|crt|film grain|noise|halftone|dither/i,
  physics: /physics|gravity|collision|rigid|cloth|fluid|liquid|spring/i,
  split_screen: /split[- ]screen|side[- ]by[- ]side|versus|\bvs\b|before.*after|compare/i,
  collage: /collage|cut ?out|paper|scrapbook|sticker|stop[- ]motion/i,
  retro_pixel: /pixel|8-bit|16-bit|retro|vhs|arcade/i,
  countdown: /countdown|timer|clock|ticking|deadline/i,
  sound_sync: /beat|bpm|drop\b|music|sound design|audio|sync(ed)? to/i,
  photo_real: /photo(real|graph)|real (photos|clips|footage)|stock clip|vertical clips/i,
};
// Structural devices worth copying into a shot plan.
export const DEVICES = {
  self_contained_brief: /self[- ]contained|no (reference|assets)|from the following brief/i,
  asks_inputs_first: /<inputs>|ask me for/i,
  draw_t_function: /draw\(t\)|render\(t\)|deterministic|frame[- ]by[- ]frame|seek(able)?/i,
  exact_spec: /\d{2,4}\s*[×x]\s*\d{3,4}|\d+\s*fps|\d+[- ]second/i,
  role_prompt: /you are (a|the) |act as|world[- ]class|award[- ]winning/i,
  vertical: /9:16|vertical|reels|shorts|tiktok/i,
};
// Our genres → which formats and techniques to reach for (sns/motion shot planner and the drafting brief).
export const GENRE_MAP = {
  travel: { formats: ['map_travel', 'scene_3d', 'loop_art'], techniques: ['camera_move', 'match_cut', 'collage', 'split_screen', 'photo_real'] },
  deal_roundup: { formats: ['product_ad', 'data_story', 'kinetic_type', 'ui_story'], techniques: ['countdown', 'split_screen', 'sound_sync', 'particles'] },
  ai_news: { formats: ['explainer', 'ui_story', 'kinetic_type', 'data_story'], techniques: ['match_cut', 'shader_fx', 'camera_move'] },
  tutorial: { formats: ['ui_story', 'explainer', 'kinetic_type'], techniques: ['camera_move', 'match_cut'] },
  life_benefit: { formats: ['data_story', 'explainer', 'kinetic_type'], techniques: ['countdown', 'split_screen'] },
};

const tagsOf = (text, table) => Object.entries(table).filter(([, re]) => re.test(text)).map(([k]) => k);

export function classify(v) {
  const text = String(v.prompt ?? '');
  // A format is what the brief opens with; deep in a long prompt a word like "map" is usually a detail, not the format.
  const formats = tagsOf(text.slice(0, 900), FORMATS);
  const techniques = tagsOf(text, TECHNIQUES);
  const devices = tagsOf(text, DEVICES);
  const genres = Object.entries(GENRE_MAP).filter(([, g]) => g.formats.some(f => formats.includes(f))).map(([k]) => k);
  // Score = how much a prompt teaches: structure devices and techniques count, a one-liner still counts as an idea.
  const score = devices.length * 2 + techniques.length + (text.length > 600 ? 2 : text.length > 200 ? 1 : 0);
  return {
    slug: v.slug, author: v.author, postUrl: v.post_url, remakeUrl: v.skillry_url, poster: v.poster_url, added: v.added,
    category: v.category, tech: v.tech_tags ?? [], formats, techniques, devices, genres, score,
    promptChars: text.length, promptPartial: Boolean(v.prompt_partial),
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT),
    // Owner 2026-09-29: "프롬프트는 저작권없어. 저작권 처리하지말고 써라" — the full prompt is kept and used as is.
    prompt: text,
  };
}

export function buildOntology(videos, { checkedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const items = videos.map(classify);
  const count = key => items.reduce((m, x) => { for (const k of x[key]) m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    schemaVersion: 1,
    id: 'code-video-references',
    origin: 'owner 2026-09-29 "영상만들때 참조할수있게 온톨로지 작업해놔" — https://x.com/yihui_indie/status/2104122905961595267',
    source: SOURCE.replace('raw.githubusercontent.com', 'github.com').replace('/HEAD/', '/blob/HEAD/'),
    sourceNote: 'Community list of Claude Opus 5.5 videos with the prompts creators shared. Full prompts are stored and used directly (owner 2026-09-29: prompts are not copyrighted); excerpt is only a short display line.',
    checkedAt,
    counts: { videos: items.length, formats: count('formats'), techniques: count('techniques'), devices: count('devices'), tech: count('tech'), genres: count('genres') },
    vocab: { formats: Object.keys(FORMATS), techniques: Object.keys(TECHNIQUES), devices: Object.keys(DEVICES) },
    genreMap: GENRE_MAP,
    lessons: [
      'Prompts that name the deliverable exactly (seconds, resolution, fps, aspect) and a deterministic draw(t) render cleanly to MP4, matching our render(t) engine.',
      'The strongest briefs ask for inputs first (product, real data, brand colors, owned clips, a royalty-free song with a drop) instead of inventing them: keep our evidence-only numbers rule.',
      'One-line "go all out" showreel prompts go viral but vary run to run; for series content prefer a structured brief plus our catalog techniques.',
      'Match cuts, infinite zooms and one-continuous-shot transitions recur in the most-shared travel/landscape pieces.',
    ],
    items: items.sort((a, b) => b.score - a.score),
  };
}

export function pick(ontology, { genre, tech, n = 6 } = {}) {
  const g = GENRE_MAP[genre];
  if (genre && !g) throw Object.assign(new Error(`unknown genre ${genre}`), { code: 'GENRE_UNKNOWN' });
  const fit = x => (g ? g.formats.filter(f => x.formats.includes(f)).length * 3 + g.techniques.filter(t => x.techniques.includes(t)).length * 2 : 0) + x.score;
  // One per author and one per prompt: the same viral prompt is reposted by many accounts.
  const seenAuthors = new Set(), seenPrompts = new Set();
  const promptKey = x => x.excerpt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
  return ontology.items
    .filter(x => (!g || x.genres.includes(genre)) && (!tech || x.tech.includes(tech)))
    .map(x => ({ ...x, fit: fit(x) }))
    .sort((a, b) => b.fit - a.fit)
    .filter(x => !seenAuthors.has(x.author) && !seenPrompts.has(promptKey(x)) && seenAuthors.add(x.author) && seenPrompts.add(promptKey(x)))
    .slice(0, n)
    .map(({ slug, author, postUrl, remakeUrl, formats, techniques, devices, tech: t, fit: f, excerpt, prompt }) => ({ slug, author, postUrl, remakeUrl, formats, techniques, devices, tech: t, fit: f, excerpt, prompt }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = k => rest.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  if (cmd === 'build') {
    const r = await fetch(SOURCE); if (!r.ok) throw new Error(`SOURCE_HTTP_${r.status}`);
    const data = await r.json(); const videos = Array.isArray(data) ? data : data.videos;
    const o = buildOntology(videos);
    writeFileSync(OUT, JSON.stringify(o, null, 2) + '\n');
    console.log(JSON.stringify({ out: OUT, ...o.counts }));
  } else if (cmd === 'pick') {
    const o = JSON.parse(readFileSync(OUT, 'utf8'));
    console.log(JSON.stringify(pick(o, { genre: opt('genre'), tech: opt('tech'), n: Number(opt('n') ?? 6) }), null, 1));
  } else {
    console.log('usage: node code-video-references.mjs build | pick --genre=travel [--tech=threejs] [--n=6]');
  }
}
