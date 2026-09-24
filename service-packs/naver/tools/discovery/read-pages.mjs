// A URL under an account prefix is not sufficient evidence of a read operation.
// Reuse paths and selector names from previously inspected documents only.
export function observedReadPages(urls) {
  const contracts = new Map();
  for (const raw of urls) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    const key = u.origin + u.pathname;
    const fields = contracts.get(key) || new Set();
    for (const name of u.searchParams.keys()) fields.add(name);
    contracts.set(key, fields);
  }
  return raw => {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
    if (!['admin.blog.naver.com', 'blog.stat.naver.com'].includes(u.hostname)) return false;
    const fields = contracts.get(u.origin + u.pathname);
    if (!fields) return false;
    const actor = u.hostname === 'admin.blog.naver.com' ? u.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] : null;
    if (actor && actor !== '4053103') return false;
    if (u.searchParams.getAll('blogId').some(value => value !== '4053103')) return false;
    for (const [name, value] of u.searchParams) {
      if (!fields.has(name) || /token|password|cookie|secret|session|csrf|auth/i.test(name)) return false;
      if (/\[redacted\]|<.*>|[\r\n]/i.test(value)) return false;
      // An observed page selector must not be repurposed as a command.
      if (/^(?:action|command|cmd|mode|method)$/i.test(name)) return false;
    }
    return true;
  };
}
