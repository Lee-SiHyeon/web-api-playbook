// One markdown source -> every blog surface (2026-10-19, 곽범 방콕 post).
//   node scripts/blog-md.mjs lab-run <post.md> <imgDir> <runDir> [--youtube=<id>]
//        -> runDir for lifehackailab-web scripts/mirror-lab.mjs --site-first (document.json, job-reviewed.json, img/)
//   node scripts/blog-md.mjs se-html <post.md> <urlMap.json> <out.html> [--headings=quote] [--palette=notebook]
//        -> HTML for naver-se-paste.mjs draft. urlMap = {"img/x.jpg": "https://public/url"} (SmartEditor accepts remote
//           images on paste; local files cannot be pasted). --headings=quote turns ## into quotation components (the
//           format 90% of top travel posts use); --palette adds the inline styles that survive SmartEditor paste.
//
// Markdown subset: front matter (title, tags|labels, category), ## / ###, paragraphs, - / 1. lists, | tables |,
// > notice, ---, **bold**, bare https links, [이미지: img/x.jpg — caption], [배너: img/x.jpg | https://link | alt].
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [cmd, ...rest] = MAIN ? process.argv.slice(2) : [];
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const args = rest.filter((a) => !a.startsWith('--'));

export function parse(md) {
  const src = md.replace(/\r/g, '');
  const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = fm ? Object.fromEntries(fm[1].split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })) : {};
  const body = fm ? src.slice(fm[0].length) : src;
  const blocks = []; let para = []; let list = null; let table = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: 'paragraph', text: para.join('\n') }); para = []; } };
  const flushList = () => { if (list) { blocks.push({ type: 'list', items: list.items, ordered: list.ordered }); list = null; } };
  const flushTable = () => { if (table) { blocks.push({ type: 'table', columns: table[0], rows: table.slice(1) }); table = null; } };
  const flush = () => { flushPara(); flushList(); flushTable(); };
  for (const line of body.split('\n')) {
    let m;
    if (!line.trim()) { flush(); continue; }
    if (/^---\s*$/.test(line)) { flush(); blocks.push({ type: 'divider' }); continue; }
    if ((m = line.match(/^(#{2,3}) (.+)/))) { flush(); blocks.push({ type: 'heading', level: m[1].length, text: m[2] }); continue; }
    if ((m = line.match(/^> (.+)/))) { flush(); blocks.push({ type: 'notice', text: m[1] }); continue; }
    if ((m = line.match(/^\[(?:배너|banner): (img\/\S+) \| (https:\/\/\S+) \| (.+)\]$/))) { flush(); blocks.push({ type: 'image', file: m[1], href: m[2], caption: m[3] }); continue; }
    if ((m = line.match(/^\[(?:이미지|image): (img\/[^\s\]]+)(?:\s*[—(-]\s*(.*?))?\)?\]$/))) { flush(); blocks.push({ type: 'image', file: m[1], caption: (m[2] || '').replace(/\)$/, '') }); continue; }
    if (/^\|/.test(line)) { flushPara(); flushList(); if (/^\|[\s|:-]+\|$/.test(line)) continue; (table ||= []).push(line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())); continue; }
    if ((m = line.match(/^(?:- |(\d+)\. )(.+)/))) { flushPara(); flushTable(); const ordered = !!m[1]; if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; } list.items.push(m[2]); continue; }
    flushList(); flushTable(); para.push(line);
  }
  flush();
  return { meta, blocks };
}

// inline styles that survived a SmartEditor ONE paste on 2026-10-19 (color, background-color, font-size, text-align,
// table cell background); font-family, border-radius and padding did not.
const PALETTE = { notebook: { ink: '#1d1a16', paper: '#f6efdf', accent: '#e5483c', mark: '#ffc83d' } };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(t, P) {
  let s = esc(t);
  s = s.replace(/\*\*(.+?)\*\*/g, P ? `<b><span style="background-color:${P.mark}">$1</span></b>` : '<b>$1</b>');
  return s.replace(/(https:\/\/[^\s<)]+)/g, '<a href="$1">$1</a>');
}
export function seHtml({ blocks }, urlMap, { headings, palette } = {}) {
  const P = palette ? PALETTE[palette] : null;
  return blocks.map((b) => {
    switch (b.type) {
      case 'heading': return headings === 'quote' && b.level === 2 ? `<blockquote><p><b>${inline(b.text)}</b></p></blockquote>` : `<h${b.level}>${inline(b.text, P)}</h${b.level}>`;
      case 'paragraph': return `<p>${b.text.split('\n').map((l) => inline(l, P)).join('<br>')}</p>`;
      case 'notice': return P ? `<div style="background:${P.paper};border:2px solid ${P.ink}"><p>${inline(b.text, P)}</p></div>` : `<blockquote><p>${inline(b.text)}</p></blockquote>`;
      case 'list': return `<${b.ordered ? 'ol' : 'ul'}>${b.items.map((i) => `<li>${inline(i, P)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`;
      case 'table': return `<table border="1"><tr>${b.columns.map((c) => `<th${P ? ` style="background:${P.mark}"` : ''}>${inline(c)}</th>`).join('')}</tr>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, P)}</td>`).join('')}</tr>`).join('')}</table>`;
      case 'divider': return '<hr>';
      case 'image': {
        const url = urlMap[b.file]; if (!url) throw new Error('NO_URL_FOR ' + b.file);
        const img = `<img src="${url}" alt="${esc(b.caption || '')}">`;
        return b.href ? `<p><a href="${b.href}">${img}</a></p>` : `<p>${img}</p>${b.caption ? `<p style="text-align:center"><span style="color:#888888;font-size:13px">${esc(b.caption)}</span></p>` : ''}`;
      }
      default: return '';
    }
  }).join('\n');
}

if (cmd === 'lab-run') {
  const [md, imgDir, run] = args;
  const { meta, blocks } = parse(fs.readFileSync(md, 'utf8'));
  fs.mkdirSync(path.join(run, 'img'), { recursive: true });
  for (const b of blocks) if (b.type === 'image') fs.copyFileSync(path.join(imgDir, path.basename(b.file)), path.join(run, b.file));
  if (opt.youtube) { const i = blocks.findIndex((b) => b.type === 'list'); blocks.splice(i + 1, 0, { type: 'youtube', videoId: opt.youtube, url: `https://youtu.be/${opt.youtube}` }); }
  const summary = (blocks.find((b) => b.type === 'paragraph')?.text ?? '').replace(/\*\*/g, '').slice(0, 600);
  fs.writeFileSync(path.join(run, 'document.json'), JSON.stringify({ title: meta.title, summary, blocks }, null, 1));
  fs.writeFileSync(path.join(run, 'job-reviewed.json'), JSON.stringify({ publishedAt: new Date().toISOString(), publishSettings: { tags: (meta.tags || meta.labels || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20), categoryName: meta.category || '연구소' } }, null, 1));
  console.log(JSON.stringify({ run, title: meta.title, blocks: blocks.length, images: blocks.filter((b) => b.type === 'image').length, note: 'add independent-review.json {decision:"pass"} from a real review before mirror-lab --site-first' }));
} else if (cmd === 'se-html') {
  const [md, mapFile, out] = args;
  const doc = parse(fs.readFileSync(md, 'utf8'));
  fs.writeFileSync(out, seHtml(doc, JSON.parse(fs.readFileSync(mapFile, 'utf8')), { headings: opt.headings, palette: opt.palette }));
  fs.writeFileSync(out.replace(/\.html$/, '') + '.title.txt', doc.meta.title || '');
  console.log(JSON.stringify({ out, title: doc.meta.title, blocks: doc.blocks.length }));
} else if (MAIN) {
  console.error('usage: blog-md.mjs lab-run <md> <imgDir> <runDir> [--youtube=id] | se-html <md> <urlMap.json> <out.html> [--headings=quote] [--palette=notebook]');
  process.exitCode = 2;
}
