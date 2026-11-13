import { createAgyRemoteClient, validateAgyState, AGY_STORE } from './agy-remote.mjs';

/** Phase coordinator: trusted local session maintenance is separate from HTTP business operations. */
export function createAgyRemoteRuntime({ state, store, sessionName = AGY_STORE, remote, allowMaintenance = false,
  fetchImpl, journalRoot, syncImpl, now = Date.now } = {}) {
  let current = validateAgyState(state), synchronized = false;
  let maintenance = { usedBrowser: false, kind: 'not_needed', automaticGoogleLogin: false };
  const save = value => {
    if (store) {
      const raw = store.read(sessionName); let existing;
      try { existing = raw ? JSON.parse(raw) : null; } catch { existing = null; }
      // An older in-flight HTTP operation must not replace a newer browser-cookie sync.
      if (existing?.expectedEmail === value.expectedEmail && Date.parse(existing.importedAt) > Date.parse(value.importedAt)) {
        current = validateAgyState(existing); return;
      }
      store.write(sessionName, JSON.stringify(value));
    }
    current = value;
  };
  const client = () => createAgyRemoteClient({ state: current, fetchImpl, journalRoot, saveState: save });
  const sync = async () => {
    if (!allowMaintenance || !current.maintenance || synchronized) throw Object.assign(new Error(), { code: 'AGY_REAUTH_REQUIRED' });
    synchronized = true;
    const refresh = syncImpl ?? (await import('./agy-remote-bootstrap.mjs')).refreshAgyRemoteSession;
    const result = await refresh({ state: current, remote, fetchImpl });
    if (result.state?.expectedEmail !== current.expectedEmail) throw Object.assign(new Error(), { code: 'AGY_OWNER_MISMATCH' });
    save(result.state); maintenance = result.receipt;
  };
  const read = async action => {
    try { return await action(client()); }
    catch (error) { if (error.code !== 'AGY_REAUTH_REQUIRED' || !allowMaintenance || !current.maintenance || synchronized) throw error; await sync(); return action(client()); }
  };
  async function run(action, { write = false } = {}) {
    synchronized = false;
    maintenance = { usedBrowser: false, kind: 'not_needed', automaticGoogleLogin: false };
    if (allowMaintenance && current.maintenance && now() - Date.parse(current.importedAt) >= current.maintenance.maxAgeMs) await sync();
    if (write) {
      // Only this read preflight can be retried; the mutation itself is dispatched once.
      await read(c => c.owner(remote));
      return action(client());
    }
    return read(action);
  }
  return { run, get maintenance() { return structuredClone(maintenance); } };
}
