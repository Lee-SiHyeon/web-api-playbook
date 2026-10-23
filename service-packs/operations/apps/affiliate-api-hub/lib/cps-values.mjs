// Currency values are observations; absence and unrepresentable precision stay unknown.
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
export const isSupportedCurrency = value => typeof value === 'string' && CURRENCIES.has(value);
export function decimalString(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return text;
  const scientific = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!scientific) return null;
  const exponent = Number(scientific[3]);
  if (Math.abs(exponent) > 100) return null;
  const digits = scientific[1] + (scientific[2] ?? '');
  const position = scientific[1].length + exponent;
  return position <= 0 ? '0.' + '0'.repeat(-position) + digits
    : position >= digits.length ? digits + '0'.repeat(position - digits.length)
      : digits.slice(0, position) + '.' + digits.slice(position);
}

export function decimalToMinor(value, currency) {
  const parsed = decimalString(value);
  if (parsed == null || !isSupportedCurrency(currency)) return null;
  let precision;
  try { precision = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; }
  catch { return null; }
  const [whole, fraction = ''] = parsed.split('.');
  if (fraction.length > precision && /[1-9]/.test(fraction.slice(precision))) return null;
  const minor = BigInt(whole) * (10n ** BigInt(precision)) + BigInt((fraction.slice(0, precision) + '0'.repeat(precision)).slice(0, precision) || '0');
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

export function observedNumber(value) {
  const parsed = decimalString(value);
  return parsed !== null && Number.isFinite(Number(parsed)) ? Number(parsed) : null;
}

export function observedCount(value) {
  const number = observedNumber(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
