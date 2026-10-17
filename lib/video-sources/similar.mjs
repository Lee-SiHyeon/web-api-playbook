import { spawn } from 'node:child_process';

// Similar-product discovery across no-login sources (AliExpress KR, 1688, Amazon US).
// Pipeline: per-source keyword search -> candidate cards (title, image, price) -> image dHash distance to the seed
// image + title similarity -> ranked list -> optional judge (LLM) on the top candidates -> optional media lookup.
// Image hashing decodes with ffmpeg (9x8 grayscale), so only allow-listed image hosts are fetched.

export const IMAGE_HOSTS = [/^ae-pic-[a-z0-9]+\.aliexpress-media\.com$/, /^cbu\d{2}\.alicdn\.com$/, /^img\.alicdn\.com$/,
  /^m\.media-amazon\.com$/, /^thumbnail\d*\.coupangcdn\.com$/, /^image\d*\.coupangcdn\.com$/];

export class SimilarError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'SimilarError'; this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new SimilarError(code, detail); };

function allowedImage(src) {
  if (typeof src !== 'string') return false;
  if (!/^https:\/\//.test(src)) return /^[A-Za-z]:\\|^\//.test(src); // local file path
  try { const u = new URL(src); return u.protocol === 'https:' && IMAGE_HOSTS.some(re => re.test(u.hostname)); } catch { return false; }
}

/** 64-bit difference hash (dHash) as a 16-char hex string. */
export function dHashFromGray9x8(buf) {
  if (!buf || buf.length !== 72) fail('SIMILAR_HASH_INPUT_INVALID');
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits = (bits << 1n) | (buf[y * 9 + x] > buf[y * 9 + x + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingHex(a, b) {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return null;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export function imageDHash(src, { ffmpegPath = process.env.FFMPEG_BIN || 'ffmpeg', timeoutMs = 20_000 } = {}) {
  if (!allowedImage(src)) return Promise.reject(new SimilarError('SIMILAR_IMAGE_HOST_NOT_ALLOWED'));
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', ...(/^https:/.test(src) ? ['-protocol_whitelist', 'https,tls,tcp'] : []),
      '-i', src, '-frames:v', '1', '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', d => chunks.push(d));
    const timer = setTimeout(() => { child.kill(); reject(new SimilarError('SIMILAR_HASH_TIMEOUT')); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new SimilarError('SIMILAR_FFMPEG_UNAVAILABLE')); });
    child.on('close', code => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length !== 72) reject(new SimilarError('SIMILAR_HASH_FAILED'));
      else resolve(dHashFromGray9x8(buf));
    });
  });
}

/** Character-trigram Jaccard over normalized text; meaningful only within one language. */
export function titleSimilarity(a, b) {
  const grams = s => {
    const t = String(s ?? '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const set = new Set();
    for (const w of t.split(' ')) { const p = ` ${w} `; for (let i = 0; i + 3 <= p.length; i++) set.add(p.slice(i, i + 3)); }
    return set;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Score = image similarity (1 - hamming/64) weighted 0.7 + same-language title similarity 0.3.
 * Cross-language candidates (e.g. Chinese 1688 titles vs a Korean seed) get image-only scores.
 */
/** Language-independent model codes such as PJ88C, FP61C, 88037 (letters+digits, or 5+ digits). */
export function modelCodes(title) {
  const out = new Set();
  for (const m of String(title ?? '').toUpperCase().matchAll(/[A-Z0-9][A-Z0-9-]{2,14}[A-Z0-9]/g)) {
    const t = m[0].replace(/-/g, '');
    if ((/[A-Z]/.test(t) && /\d/.test(t) && t.length >= 4) || /^\d{5,}$/.test(t)) {
      if (!/^\d+(K|KEY|KEYS|MM|CM|M|ML|L|G|KG|GB|TB|W|V|MAH|PCS|P|HZ|INCH|IN)$/.test(t) && !/^(USB|MIDI)\d*$/.test(t)) out.add(t);
    }
  }
  return [...out];
}

export function scoreCandidate({ seedHash, seedTitle, seedLang, seedCodes = modelCodes(seedTitle) }, cand) {
  const dist = seedHash && cand.imageHash ? hammingHex(seedHash, cand.imageHash) : null;
  const img = dist == null ? null : 1 - dist / 64;
  const title = cand.lang === seedLang ? titleSimilarity(seedTitle, cand.title) : null;
  const candCodes = new Set(modelCodes(cand.title));
  const modelMatch = seedCodes.filter(c => candCodes.has(c));
  let score = img != null && title != null ? 0.7 * img + 0.3 * title : img ?? (title != null ? 0.6 * title : 0);
  if (modelMatch.length) score = Math.min(1, score + 0.4); // same model code across languages is the strongest cheap signal
  return { imageDistance: dist, imageSimilarity: img, titleSimilarity: title, modelMatch, score: Number(score.toFixed(4)) };
}

/**
 * clients: { aliexpress: {search}, '1688': {search}, amazon: {search} } (any subset).
 * keywords: { ko, zh, en } — AliExpress KR uses ko (falls back to en), 1688 uses zh, Amazon uses en.
 */
export async function findSimilarProducts({ seed, keywords, clients, perSource = 20, hashConcurrency = 6, hash = imageDHash, judge, judgeTop = 25 } = {}) {
  if (!seed || (!seed.image && !seed.title)) fail('SIMILAR_SEED_REQUIRED');
  const seedLang = seed.lang ?? 'ko';
  const seedHash = seed.image ? await hash(seed.image).catch(() => null) : null;
  const plan = [
    ['aliexpress', keywords?.ko ?? keywords?.en, 'ko'],
    ['1688', keywords?.zh, 'zh'],
    ['amazon', keywords?.en, 'en'],
  ].filter(([source, kw]) => clients?.[source] && kw);
  const sources = {};
  const candidates = [];
  for (const [source, keyword, lang] of plan) {
    try {
      const r = await clients[source].search({ keyword });
      const items = (r.items ?? []).slice(0, perSource);
      sources[source] = { keyword, found: r.items?.length ?? 0, used: items.length, receipt: r.receipt };
      for (const it of items) candidates.push({ source, lang, id: it.productId ?? it.offerId ?? it.asin, title: it.title, imageUrl: it.imageUrl,
        price: it.price ?? it.priceCny ?? null, currency: it.currency ?? (it.priceCny ? 'CNY' : null), url: it.productUrl ?? it.offerUrl,
        signals: { sold: it.sold ?? it.bookedCount ?? null, rating: it.rating ?? null, repurchaseRate: it.repurchaseRate ?? null } });
    } catch (error) {
      sources[source] = { keyword, error: error?.code ?? 'SEARCH_FAILED' };
    }
  }
  for (let i = 0; i < candidates.length; i += hashConcurrency) {
    await Promise.all(candidates.slice(i, i + hashConcurrency).map(async c => { c.imageHash = c.imageUrl ? await hash(c.imageUrl).catch(() => null) : null; }));
  }
  const seedCodes = modelCodes(seed.title);
  for (const c of candidates) Object.assign(c, scoreCandidate({ seedHash, seedTitle: seed.title, seedLang, seedCodes }, c));
  candidates.sort((a, b) => b.score - a.score);
  let judged = null;
  if (typeof judge === 'function') {
    judged = await judge({ seed, candidates: candidates.slice(0, judgeTop) }).catch(error => ({ error: error?.code ?? 'JUDGE_FAILED' }));
    applyVerdicts(candidates, judged?.verdicts);
  }
  return { seed: { ...seed, imageHash: seedHash }, sources, candidates, judged };
}

const VERDICT_RANK = { same: 0, type: 1, undefined: 2, different: 3 };
/** Attach judge verdicts and order: same > type > unjudged > different, then by score. */
export function applyVerdicts(candidates, verdicts) {
  const byKey = new Map((Array.isArray(verdicts) ? verdicts : []).map(v => [`${v.source}:${v.id}`, v]));
  for (const c of candidates) {
    const v = byKey.get(`${c.source}:${c.id}`);
    if (v) { c.verdict = v.verdict; c.verdictReason = v.reason; }
  }
  candidates.sort((a, b) => (VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]) || (b.score - a.score));
  return candidates;
}
