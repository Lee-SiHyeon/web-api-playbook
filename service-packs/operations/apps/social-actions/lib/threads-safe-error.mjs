export function threadsSafeFailure(error) {
  const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(value) ? value : null;
  const knownNames = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'TimeoutError', 'AbortError'];
  const frames = [...String(error?.stack || '').matchAll(/[/\\]social-actions[/\\]([a-z0-9./\\_-]+\.mjs):(\d{1,7}):(\d{1,7})/gi)]
    .slice(0, 4).map(match => match[1].replaceAll('\\', '/') + ':' + match[2] + ':' + match[3]);
  return { name: knownNames.includes(error?.name) ? error.name : 'unknown', code: safeCode(error?.code),
    causeCode: safeCode(error?.cause?.code), frames,
    ...(['CREDENTIAL_STORE_UNREADABLE', 'CREDENTIAL_STORE_FAILED'].includes(error?.code) && typeof error?.detail?.timedOut === 'boolean'
      ? { localStore: { timedOut: error.detail.timedOut, exitStatus: Number.isInteger(error.detail.exitStatus) ? error.detail.exitStatus : null } } : {}) };
}
