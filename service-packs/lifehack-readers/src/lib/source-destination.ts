const SENSITIVE_QUERY_KEY = /(^|[^a-z0-9])(access_token|refresh_token|id_token|token|secret|password|passwd|authorization|auth|session|session_id|sessionid|cookie|api_key|apikey|client_secret|signature|sig|code)([^a-z0-9]|$)/i;

function isDnsHost(value: string) {
  if (!value || value.length > 253 || value.endsWith('.') || value.startsWith('.') || value.includes('..')) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

/** Exact HTTPS host match against the source rows reviewed in trusted_source_hosts. */
export function safeSourceDestination(raw: unknown, approvedHosts: readonly string[]): string | null {
  if (typeof raw !== 'string') return null;
  const hosts = new Set(approvedHosts
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter((host) => isDnsHost(host) && !host.endsWith('.localhost') && host !== 'localhost'));
  if (!hosts.size) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || raw.includes('#') ||
      (url.port && url.port !== '443') || !isDnsHost(host) || !hosts.has(host)) return null;
  if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) return null;
  return url.toString();
}

/** Observed shopping SDK URL; these parameters identify a public affiliate click. */
export function safeAdpickSdkDestination(raw: unknown): string | null {
  const accepted = safeSourceDestination(raw, ['adpick.co.kr', 'www.adpick.co.kr']);
  if (!accepted) return null;
  const url = new URL(accepted);
  if (url.pathname !== '/apis/goshopping.php' || [...url.searchParams.keys()].some(key => !['affid','offer','url'].includes(key))) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(url.searchParams.get('affid') ?? '') || !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get('offer') ?? '')) return null;
  try {
    const target = new URL(url.searchParams.get('url') ?? '');
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.port || target.hash
      || !isDnsHost(target.hostname) || /^\d+(?:\.\d+){3}$/.test(target.hostname)
      || target.hostname.endsWith('.localhost')
      || [...target.searchParams.keys()].some(key => SENSITIVE_QUERY_KEY.test(key))) return null;
  } catch { return null; }
  return accepted;
}
