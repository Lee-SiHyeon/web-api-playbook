// SmartEditor ONE layout of a public Naver post page (m.blog.naver.com PostView HTML): component sequence and styles,
// text rhythm, typography. Format only — no body text is kept beyond short heading previews. Port of
// se-format-analyze.py (2026-09-27), used by reference-scout.mjs --formats.
const unescape = s => String(s ?? '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plain = s => unescape(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/[\s​]+/g, ' ').trim();
const EMOJI_LEAD = /^[←-⯿☀-➿\u{1F000}-\u{1FAFF}]/u;
const NEUTRAL = new Set(['#000000', '#333333', '#141414', '#0d0d0d', '#555555', '#191e23', '#222222', '#666666']);
export const RICH = ['sectionTitle', 'sticker', 'imageStrip', 'imageGroup', 'placesMap', 'video', 'shopping', 'material', 'talktalk'];

export function components(html) {
  const start = html.indexOf('se-main-container');
  let body = start >= 0 ? html.slice(start) : html;
  const end = body.indexOf('class="comment');
  if (end > 0) body = body.slice(0, end);
  return body.split(/(?=<div class="se-component se-)/).slice(1).map(p => {
    const head = p.match(/^<div class="se-component se-([a-zA-Z]+)([^"]*)"/);
    const type = head[1], layout = head[2].match(/se-l-([a-zA-Z0-9_]+)/)?.[1] ?? 'default';
    const c = { type, layout, fonts: [...new Set([...p.matchAll(/se-ff-([a-zA-Z0-9]+)/g)].map(m => m[1]))] };
    if (type === 'text') {
      const paras = [...p.matchAll(/<p class="se-text-paragraph([^"]*)"[^>]*>([\s\S]*?)<\/p>/g)];
      const lines = paras.map(m => plain(m[2]));
      c.lens = lines.filter(Boolean).map(l => l.length);
      c.blank = lines.filter(l => !l).length;
      c.center = paras.filter(m => m[1].includes('align-center')).length;
      c.justify = paras.filter(m => m[1].includes('align-justify')).length;
      c.bold = (p.match(/se-bold|font-weight:\s*bold|<b>/g) ?? []).length;
      c.fs = [...new Set([...p.matchAll(/se-fs-(fs\d+)/g)].map(m => m[1]))];
      c.lists = (p.match(/se-text-list-type-(bullet|decimal)/g) ?? []).length;
      c.lineHeights = [...new Set([...p.matchAll(/line-height:\s*([\d.]+)/g)].map(m => m[1]))];
      c.colors = [...new Set([...p.matchAll(/(?<!background-)color:\s*(#[0-9a-fA-F]{6})/g)].map(m => m[1].toLowerCase()))].filter(x => !NEUTRAL.has(x));
      c.highlights = [...new Set([...p.matchAll(/background-color:\s*(#[0-9a-fA-F]{6})/g)].map(m => m[1].toLowerCase()))].filter(x => !['#ffffff', '#fcfcfc'].includes(x));
    }
    if (type === 'quotation') { const t = plain(p); c.preview = t.slice(0, 40); c.emojiLead = EMOJI_LEAD.test(t); c.cite = /<cite[^>]*>\s*[^<\s]/.test(p); }
    if (['image', 'imageStrip', 'imageGroup'].includes(type)) { c.images = (p.match(/<img /g) ?? []).length; c.caption = /se-caption/.test(p); }
    if (type === 'table') c.rows = (p.match(/<tr/g) ?? []).length;
    return c;
  });
}

export function analyzePost(html) {
  const cs = components(html);
  const of = t => cs.filter(c => c.type === t);
  const texts = of('text'), lens = texts.flatMap(c => c.lens);
  const lines = lens.length, blank = texts.reduce((a, c) => a + c.blank, 0);
  const tally = list => list.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  return {
    components: cs.length,
    counts: tally(cs.map(c => c.type)),
    images: cs.reduce((a, c) => a + (c.images ?? 0), 0),
    lines, blankLines: blank,
    avgLineChars: lines ? Math.round((lens.reduce((a, b) => a + b, 0) / lines) * 10) / 10 : 0,
    maxLineChars: lines ? Math.max(...lens) : 0,
    centered: lines ? Math.round((texts.reduce((a, c) => a + c.center, 0) / (lines + blank)) * 100) / 100 : 0,
    boldRuns: texts.reduce((a, c) => a + c.bold, 0),
    fontSizes: [...new Set(texts.flatMap(c => c.fs))].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))),
    fonts: [...new Set(cs.flatMap(c => c.fonts))],
    lineHeights: [...new Set(texts.flatMap(c => c.lineHeights))],
    accentColors: [...new Set(texts.flatMap(c => c.colors))], highlightColors: [...new Set(texts.flatMap(c => c.highlights))],
    nativeListItems: texts.reduce((a, c) => a + c.lists, 0),
    quotationStyles: tally(of('quotation').map(c => c.layout)),
    quotationEmojiLead: of('quotation').filter(c => c.emojiLead).length,
    headingPreviews: of('quotation').map(c => c.preview).slice(0, 6),
    tableStyles: tally(of('table').map(c => c.layout)), dividerStyles: tally(of('horizontalLine').map(c => c.layout)),
    oglinkStyles: tally(of('oglink').map(c => c.layout)), imageCaptions: cs.filter(c => c.caption).length,
    rich: Object.fromEntries(RICH.map(t => [t, of(t).length]).filter(([, n]) => n)),
  };
}

// Genre summary: medians and how many posts use each style (so one heavy post does not dominate).
export function summarizeFormats(list) {
  const posts = list.filter(Boolean), n = posts.length;
  if (!n) return null;
  const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const inPosts = f => posts.reduce((m, p) => { for (const k of f(p)) m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return {
    posts: n, medianAvgLineChars: median(posts.map(p => p.avgLineChars)), medianImages: median(posts.map(p => p.images)),
    mostlyCentered: posts.filter(p => p.centered >= 0.5).length, withQuotation: posts.filter(p => Object.keys(p.quotationStyles).length).length,
    quotationStyles: inPosts(p => Object.keys(p.quotationStyles)), fontSizes: inPosts(p => p.fontSizes), fonts: inPosts(p => p.fonts),
    lineHeightSet: posts.filter(p => p.lineHeights.length).length, tables: posts.filter(p => Object.keys(p.tableStyles).length).length,
    oglinks: posts.filter(p => Object.keys(p.oglinkStyles).length).length, nativeLists: posts.filter(p => p.nativeListItems).length,
    rich: inPosts(p => Object.keys(p.rich)),
  };
}
