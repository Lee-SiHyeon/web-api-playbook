// Tistory (and any HTML-mode blog) rendering of the blog markdown with the detective-notebook theme, inline CSS only
// (Tistory's HTML mode keeps inline styles; class-based <style> blocks depend on the skin).
//   node scripts/blog-tistory-html.mjs <post.md> <urlMap.json> <out.html> [--youtube=<id>]
// "<emoji> label → https://link" lines become pill buttons; [배너: …] become linked rounded images.
import fs from 'node:fs';
import { parse } from './blog-md.mjs';

const [md, mapFile, out, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map((f) => f.replace(/^--/, '').split('=')));
const urlMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const { meta, blocks } = parse(fs.readFileSync(md, 'utf8'));
const C = { ink: '#1d1a16', paper: '#f6efdf', accent: '#e5483c', mark: '#ffc83d', muted: '#6b6152' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => esc(t)
  .replace(/\*\*(.+?)\*\*/g, `<b style="background:linear-gradient(transparent 58%, ${C.mark} 58%);padding:0 2px">$1</b>`)
  .replace(/(https:\/\/[^\s<)]+)/g, `<a href="$1" target="_blank" rel="noopener sponsored" style="color:${C.accent};text-decoration:underline">$1</a>`);
const button = (label, url) => `<p style="margin:10px 0"><a href="${url}" target="_blank" rel="noopener sponsored" style="display:inline-block;background:${C.accent};color:#fff;font-weight:700;padding:11px 20px;border-radius:999px;text-decoration:none;box-shadow:0 3px 0 #a92d24">${esc(label)} →</a></p>`;
const CTA = /^(\S{1,3})\s+(.+?)\s+→\s+(https:\/\/\S+)$/u;
let sec = 0;
const html = blocks.map((b) => {
  switch (b.type) {
    case 'heading':
      if (b.level === 2) { sec++; return `<div style="margin:44px 0 18px;background:${C.ink};color:${C.mark};padding:14px 20px;border-radius:12px;border-left:10px solid ${C.mark};font-size:21px;font-weight:800;letter-spacing:-.3px">${esc(b.text)}</div>`; }
      return `<h3 style="font-size:18px;border-bottom:3px solid ${C.mark};display:inline-block;padding-bottom:2px">${esc(b.text)}</h3>`;
    case 'paragraph': {
      const lines = b.text.split('\n');
      const out = []; let buf = [];
      const flush = () => { if (buf.length) { out.push(`<p style="margin:12px 0;line-height:1.85">${buf.map(inline).join('<br>')}</p>`); buf = []; } };
      for (const l of lines) { const m = l.match(CTA); if (m) { flush(); out.push(button(`${m[1]} ${m[2]}`, m[3])); } else buf.push(l); }
      flush(); return out.join('');
    }
    case 'notice': return `<div style="background:${C.paper};border:2px dashed ${C.ink};border-radius:14px;padding:14px 18px;margin:16px 0;font-size:14px;color:${C.ink}">📌 ${inline(b.text)}</div>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<div style="background:${C.paper};border-radius:14px;padding:12px 18px 12px 8px;margin:14px 0"><${tag} style="margin:0;line-height:1.9">${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}></div>`;
    }
    case 'table': return `<div style="overflow-x:auto;margin:16px 0;border-radius:14px;border:2px solid ${C.ink}"><table style="border-collapse:collapse;width:100%;font-size:14px;min-width:560px"><tr>${b.columns.map((c) => `<th style="background:${C.mark};color:${C.ink};padding:10px;border-bottom:2px solid ${C.ink};text-align:left">${esc(c)}</th>`).join('')}</tr>${b.rows.map((r, ri) => `<tr style="background:${ri % 2 ? '#fffaf0' : '#fff'}">${r.map((c) => `<td style="padding:9px 10px;border-top:1px solid #e6dcc6;vertical-align:top">${inline(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
    case 'divider': return `<hr style="border:none;border-top:2px dashed ${C.muted};margin:36px 0">`;
    case 'image': {
      const url = urlMap[b.file]; if (!url) throw new Error('NO_URL_FOR ' + b.file);
      if (b.href) return `<p style="text-align:center;margin:18px 0"><a href="${b.href}" target="_blank" rel="noopener sponsored"><img src="${url}" alt="${esc(b.caption)}" style="width:100%;max-width:760px;border-radius:14px;box-shadow:0 8px 22px rgba(0,0,0,.18)"></a></p>`;
      return `<figure style="margin:20px 0;text-align:center"><img src="${url}" alt="${esc(b.caption || '')}" style="width:100%;border-radius:14px;box-shadow:0 8px 22px rgba(0,0,0,.15)">${b.caption ? `<figcaption style="font-size:13px;color:#888;margin-top:6px">${esc(b.caption)}</figcaption>` : ''}</figure>`;
    }
    default: return '';
  }
});
if (opt.youtube) {
  const i = blocks.findIndex((b) => b.type === 'list');
  html.splice(i + 1, 0, `<div style="position:relative;padding-top:56.25%;margin:18px 0;border-radius:14px;overflow:hidden"><iframe src="https://www.youtube.com/embed/${opt.youtube}" style="position:absolute;inset:0;width:100%;height:100%;border:0" allowfullscreen title="video"></iframe></div>`);
}
const doc = `<div style="max-width:780px;margin:0 auto;color:${C.ink};font-size:16px;word-break:keep-all">\n${html.join('\n')}\n</div>`;
fs.writeFileSync(out, doc);
fs.writeFileSync(out.replace(/\.html$/, '') + '.title.txt', meta.title || '');
console.log(JSON.stringify({ out, title: meta.title, sections: sec, bytes: doc.length }));
