const BAD_X_LANGS = new Set(['und', 'qme', 'qam', 'qht', 'qst', 'zxx', 'art']);
const ALIASES = { in: 'id', iw: 'he', 'zh-cn': 'zh', 'zh-tw': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh', jp: 'ja', kr: 'ko' };
const NON_LATIN = ['ko', 'ja', 'zh', 'ru', 'ar', 'th', 'hi', 'he', 'el'];

function scriptOf(text) {
  const t = String(text || '').replace(/https?:\/\/\S+|[@#]\w+/g, ' ');
  const count = re => (t.match(re) || []).length;
  if (count(/[가-힯]/g) >= 2) return 'ko';
  if (count(/[぀-ヿ]/g) >= 1) return 'ja';
  const found = [['zh', count(/[一-鿿]/g)], ['ru', count(/[Ѐ-ӿ]/g)], ['ar', count(/[؀-ۿ]/g)], ['th', count(/[฀-๿]/g)],
    ['hi', count(/[ऀ-ॿ]/g)], ['he', count(/[֐-׿]/g)], ['el', count(/[Ͱ-Ͽ]/g)], ['en', count(/[A-Za-z]/g)]]
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return found[0]?.[0] || null;
}

export function normalizeLanguage(code) {
  const c = String(code ?? '').trim().toLowerCase().replace('_', '-');
  if (!c || BAD_X_LANGS.has(c)) return null;
  const mapped = ALIASES[c] || c.split('-')[0];
  return /^[a-z]{2,3}$/.test(mapped) && !BAD_X_LANGS.has(mapped) ? mapped : null;
}

// The post's own script beats X's `lang` field, which is unreliable on short or mixed-script text; Latin text keeps X's hint (es, pt, fr, id, ...).
export function detectLanguage(text, hint) {
  const declared = normalizeLanguage(hint), script = scriptOf(text);
  if (!script) return declared || 'en';
  if (script === 'ko' || script === 'ja') return script;
  if (script === 'zh') return declared === 'ja' ? 'ja' : 'zh';
  if (script === 'en') return declared && !NON_LATIN.includes(declared) ? declared : 'en';
  return script;
}

export function languageName(code) {
  const c = normalizeLanguage(code) || 'en';
  if (c === 'ko') return 'Korean';
  if (c === 'en') return 'English';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(c) || c; } catch { return c; }
}

export function postLanguage(post) {
  return detectLanguage(post?.text, post?.format?.lang ?? post?.lang);
}
