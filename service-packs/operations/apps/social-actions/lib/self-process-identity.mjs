const PROCESS_IDENTITY_PATTERN = /^(?:win32:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/;

export function validProcessIdentity(value) {
  return typeof value === 'string' && PROCESS_IDENTITY_PATTERN.test(value);
}

export function createSelfProcessIdentityResolver({
  pidProvider = () => process.pid,
  probe,
  maxAttempts = 2,
  timeoutMs = 15_000,
  retryDelayMs = 100,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (typeof pidProvider !== 'function' || typeof probe !== 'function') throw new TypeError('PROCESS_IDENTITY_DEPENDENCIES_REQUIRED');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1_000
    || typeof delay !== 'function') throw new TypeError('PROCESS_IDENTITY_OPTIONS_INVALID');
  let selfPid = null;
  try { selfPid = pidProvider(); } catch {}
  let cachedIdentity = null;
  let inFlight = null;
  return async function resolveSelfProcessIdentity() {
    try { if (!Number.isSafeInteger(selfPid) || selfPid <= 0 || pidProvider() !== selfPid) return null; }
    catch { return null; }
    if (cachedIdentity) return cachedIdentity;
    if (inFlight) return inFlight;
    const lookup = (async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let identity = null;
        try { identity = await probe(selfPid, { timeoutMs }); } catch {}
        try { if (pidProvider() !== selfPid) return null; } catch { return null; }
        if (validProcessIdentity(identity)) {
          cachedIdentity = identity;
          return identity;
        }
        if (attempt + 1 < maxAttempts) {
          try { await delay(retryDelayMs); } catch { return null; }
        }
      }
      return null;
    })();
    inFlight = lookup;
    try { return await lookup; }
    finally { if (inFlight === lookup) inFlight = null; }
  };
}

export async function requireWriterIdentity(readIdentity) {
  const identity = await readIdentity();
  if (!validProcessIdentity(identity)) throw Object.assign(new Error('SOCIAL_WRITER_IDENTITY_UNAVAILABLE'), { code: 'SOCIAL_WRITER_IDENTITY_UNAVAILABLE' });
  return identity;
}

export async function writerIdentityIsAlive(pid, expectedIdentity, { processAlive, probeIdentity } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof processAlive !== 'function' || typeof probeIdentity !== 'function') return false;
  let alive = true;
  try { alive = await processAlive(pid); }
  catch (error) { if (error?.code === 'ESRCH') return false; }
  if (alive === false) return false;
  if (!expectedIdentity) return true;
  let currentIdentity = null;
  try { currentIdentity = await probeIdentity(pid, { timeoutMs: 5_000 }); } catch {}
  return !validProcessIdentity(currentIdentity) || currentIdentity === expectedIdentity;
}
