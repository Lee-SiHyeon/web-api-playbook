const ORIGIN = 'https://flow.google.com';

// Values remain in this closure and are never returned in receipts or errors.
export function createDocumentProvenanceAudit() {
  let pair;
  let sequence = 0;
  const readString = (html, name) => {
    const match = new RegExp('"' + name + '"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")').exec(html);
    if (!match) return null;
    try { const value = JSON.parse(match[1]); return typeof value === 'string' && value ? value : null; }
    catch { return null; }
  };
  return {
    observeDocument(url, html) {
      const target = new URL(url);
      if (target.origin !== ORIGIN || !/^\/project\/[A-Fa-f0-9-]{16,64}$/.test(target.pathname)) return false;
      sequence++;
      const at = readString(html, 'SNlM0e');
      const sid = readString(html, 'FdrFJe');
      pair = at && sid ? { at, sid, sequence } : null;
      return Boolean(pair);
    },
    inspectRpc(url, body) {
      const target = new URL(url);
      if (target.origin !== ORIGIN || target.pathname !== '/_/AiSandboxAngularFrontend/data/batchexecute') return null;
      const form = body instanceof URLSearchParams ? body : new URLSearchParams(body);
      return {
        documentPairObserved: Boolean(pair),
        documentSequence: pair?.sequence ?? null,
        requestTokenMatchesDocument: Boolean(pair) && form.getAll('at').length === 1 && form.get('at') === pair.at,
        sessionIdMatchesDocument: Boolean(pair) && target.searchParams.getAll('f.sid').length === 1 && target.searchParams.get('f.sid') === pair.sid,
        formKeysUnique: new Set(form.keys()).size === [...form.keys()].length,
        queryKeysUnique: new Set(target.searchParams.keys()).size === [...target.searchParams.keys()].length,
      };
    },
    clear() { pair = null; },
  };
}
