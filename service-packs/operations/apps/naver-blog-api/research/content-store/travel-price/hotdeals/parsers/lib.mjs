// Shared helpers for hotdeal parsers. No dependencies; every parser takes the raw response text.

export function extractNextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('__NEXT_DATA__ not found');
  return JSON.parse(m[1]);
}

// "726,000원 → 308,000원~"  -> { original: 726000, sale: 308000, from: true }
// "1,234,050원~"            -> { original: null, sale: 1234050, from: true }
export function parseWonRange(text) {
  if (typeof text !== 'string') return { original: null, sale: null, from: false };
  const nums = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/g)].map((m) => Number(m[1].replace(/,/g, '')));
  if (nums.length === 0) return { original: null, sale: null, from: false };
  const from = /~\s*$/.test(text.trim());
  if (nums.length === 1) return { original: null, sale: nums[0], from };
  return { original: nums[0], sale: nums[nums.length - 1], from };
}

export function discountPct(original, sale) {
  if (!original || !sale || sale >= original) return null;
  return Math.round((1 - sale / original) * 100);
}

// UTC ISO -> KST wall clock string "YYYY-MM-DD HH:mm:ss" (+09:00)
export function toKst(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

export function nightsBetween(checkIn, checkOut) {
  const a = Date.parse(checkIn + 'T00:00:00Z');
  const b = Date.parse(checkOut + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return Math.round((b - a) / 86400000);
}
