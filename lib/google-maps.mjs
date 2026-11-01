import { ScopedSession } from './scoped-session.mjs';
import { WriteJournal } from './write-journal.mjs';
import { createHash } from 'node:crypto';

export const MAPS_ORIGIN = 'https://www.google.com';
export const MAPS_STORE = 'google-maps-state';
const MAX_CONTEXT_AGE_MS = 60 * 60 * 1000; // Client bound, not a measured Google expiry.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const bounded = (x, max = 512) => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\x00-\x1f\x7f]/.test(x);
const listId = x => typeof x === 'string' && /^[A-Za-z0-9_-]{10,128}$/.test(x);
const contextValue = x => bounded(x, 256) && !/[!\s]/.test(x);
const ownerId = x => typeof x === 'string' && /^\d{10,30}$/.test(x);
const validCoordinate = x => object(x) && Object.keys(x).length === 2 && Number.isFinite(x.lat) && Math.abs(x.lat) <= 90
  && Number.isFinite(x.lng) && Math.abs(x.lng) <= 180;
const coordinateKey = x => `${Math.round(x.lat * 1e7)},${Math.round(x.lng * 1e7)}`;

export function parseMapsJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8 * 1024 * 1024) fail('MAPS_RESPONSE_INVALID');
  const clean = raw.replace(/^\)\]\}'\s*/, '');
  let data;
  try { data = JSON.parse(clean); } catch { fail('MAPS_RESPONSE_INVALID'); }
  if (!Array.isArray(data)) fail('MAPS_RESPONSE_INVALID');
  return data;
}

export function decodeMapsSearch(data, expectedQuery) {
  if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0][0] !== expectedQuery || !Array.isArray(data[0][1])) fail('MAPS_SEARCH_SCHEMA_INVALID');
  return data[0][1].map(row => {
    const d = row?.[22];
    const fid = d?.[14]?.[1];
    const lat = d?.[11]?.[2], lng = d?.[11]?.[3];
    const name = d?.[1]?.[0], address = d?.[14]?.[0];
    // Autocomplete also returns street-only predictions and unlocated entries.
    // They are not safe inputs for the observed feature-ID createitem contract.
    if (fid == null || lat == null || lng == null) return null;
    if (!bounded(name) || !bounded(address, 2048) || /\uFFFD/.test(name + address) || typeof fid !== 'string' || !/^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i.test(fid)
        || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) fail('MAPS_SEARCH_CANDIDATE_INVALID');
    return { name, address, fid, lat, lng };
  }).filter(Boolean);
}

export function decodeMapsList(data, expectedListId, expectedOwnerId) {
  const d = data?.[0];
  if (!Array.isArray(d) || d[0]?.[0] !== expectedListId || !bounded(d[4]) || !Array.isArray(d[8]) || d[8].length > 500
    || !Number.isSafeInteger(d[12]) || d[12] < 0) fail('MAPS_LIST_SCHEMA_INVALID');
  if (d[3]?.[2] !== expectedOwnerId) fail('MAPS_OWNER_MISMATCH');
  const items = d[8].map(row => {
    const ids = row?.[1]?.[6];
    if (ids == null) {
      const lat = row?.[1]?.[5]?.[2], lng = row?.[1]?.[5]?.[3];
      const key = row?.[8];
      if (!bounded(row[2]) || key?.[0]?.[0] !== 1 || key?.[1] != null
          || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180
          || key?.[2]?.[2] !== lat || key?.[2]?.[3] !== lng) fail('MAPS_LIST_ITEM_SCHEMA_INVALID');
      return { name: row[2], fid: null, kind: 'coordinate', coordinateKey: `${Math.round(lat * 1e7)},${Math.round(lng * 1e7)}`,
        lat, lng, note: typeof row[3] === 'string' ? row[3] : '' };
    }
    if (!Array.isArray(ids) || ids.length !== 2 || !ids.every(x => typeof x === 'string' && /^-?\d{1,20}$/.test(x)
      && BigInt(x) >= -(1n << 63n) && BigInt(x) <= (1n << 64n) - 1n) || !bounded(row[2])) fail('MAPS_LIST_ITEM_SCHEMA_INVALID');
    return { name: row[2], fid: ids.map(x => '0x' + BigInt.asUintN(64, BigInt(x)).toString(16)).join(':'),
      lat: row[1]?.[5]?.[2], lng: row[1]?.[5]?.[3], note: typeof row[3] === 'string' ? row[3] : '' };
  });
  return { id: expectedListId, title: d[4], description: d[5] ?? '', ownerVerified: true,
    items, reportedCount: d[12], complete: d[12] === items.length, visibilityCode: d[2] ?? null };
}

export function mapsListPb(id, context) {
  if (!listId(id) || !contextValue(context)) fail('MAPS_INPUT_INVALID');
  return `!1m4!1s${id}!2e1!3m1!1e1!2e2!3e2!4i500!6m3!1s${context}!7e81!28e2!8i3!16b1`;
}

export function mapsAddPb(id, place, context, xsrf) {
  if (!listId(id) || !contextValue(context) || !contextValue(xsrf) || !object(place) || !bounded(place.name)
      || !/^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i.test(place.fid ?? '')
      || !Number.isFinite(place.lat) || Math.abs(place.lat) > 90 || !Number.isFinite(place.lng) || Math.abs(place.lng) > 180) fail('MAPS_INPUT_INVALID');
  const [a, b] = place.fid.split(':').map(x => BigInt.asIntN(64, BigInt(x)).toString());
  const name = Buffer.from(place.name).toString('base64url');
  return `!1m4!1s${id}!2e1!3m1!1e1!2m14!2m6!6m2!3d${place.lat}!4d${place.lng}!7m2!1y${a}!2y${b}!3z${name}!9m5!1m1!1e1!2m2!1y${a}!2y${b}!3m3!1s${context}!7e81!28e2!4s${xsrf}`;
}

export function mapsNotePb(id, fid, note, context, xsrf) {
  if (!listId(id) || !contextValue(context) || !contextValue(xsrf) || typeof note !== 'string' || note.length > 400
      || /[\x00-\x09\x0b-\x1f\x7f]/.test(note) || !/^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i.test(fid ?? '')) fail('MAPS_INPUT_INVALID');
  const [a,b] = fid.split(':').map(x => BigInt.asIntN(64, BigInt(x)).toString());
  return `!1m4!1s${id}!2e1!3m1!1e1!2m7!1m5!1m1!1e1!2m2!1y${a}!2y${b}!2z${Buffer.from(note).toString('base64url')}!3m3!1s${context}!7e81!28e2!4s${xsrf}`;
}

export function mapsCoordinateNotePb(id, coordinate, note, context, xsrf) {
  if (!listId(id) || !validCoordinate(coordinate) || !contextValue(context) || !contextValue(xsrf)
      || typeof note !== 'string' || note.length > 400 || /[\x00-\x09\x0b-\x1f\x7f]/.test(note)) fail('MAPS_INPUT_INVALID');
  return `!1m4!1s${id}!2e1!3m1!1e1!2m7!1m5!1m1!1e1!3m2!3d${coordinate.lat}!4d${coordinate.lng}!2z${Buffer.from(note).toString('base64url')}!3m3!1s${context}!7e81!28e2!4s${xsrf}`;
}

export function validateMapsState(input) {
  if (!object(input) || input.version !== 1 || !ownerId(input.expectedOwnerId)
      || !bounded(input.expectedEmail, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expectedEmail)
      || !listId(input.listId) || !contextValue(input.clientContext) || !contextValue(input.xsrf)
      || input.noteXsrf !== undefined && !contextValue(input.noteXsrf)
      || !Number.isSafeInteger(input.authuser) || input.authuser < 0 || input.authuser > 9
      || !Number.isFinite(Date.parse(input.importedAt)) || !object(input.session) || !object(input.searchParameters)) fail('MAPS_STATE_INVALID');
  const p = input.searchParameters;
  const allowed = ['tbm','gs_ri','suggest','authuser','hl','gl','psi','q','ech','pb'];
  if (Object.keys(p).some(k => !allowed.includes(k)) || Object.values(p).some(v => typeof v !== 'string' || v.length > 20000 || /[\0\r\n]/.test(v))
      || p.tbm !== 'map' || p.gs_ri !== 'maps' || p.suggest !== 'p' || !/^!2i\d+!/.test(p.pb ?? '')
      || p.authuser !== String(input.authuser)) fail('MAPS_SEARCH_CONTEXT_INVALID');
  const t = input.session;
  if (JSON.stringify(t.allowedOrigins) !== JSON.stringify([MAPS_ORIGIN]) || JSON.stringify(t.cookieOrigins) !== JSON.stringify([MAPS_ORIGIN])
      || t.allowLoopbackHttp !== false || t.maxRedirects !== 0 || t.timeoutMs !== 25000 || t.maxResponseBytes !== 8 * 1024 * 1024
      || t.maxRequestBytes !== 1024 || JSON.stringify(t.headersByOrigin) !== '{}'
      || JSON.stringify(t.defaultHeaders) !== JSON.stringify({ accept: '*/*' })) fail('MAPS_TRANSPORT_STATE_INVALID');
  return structuredClone(input);
}

export function importMapsState(input, { now = Date.now, fetchImpl } = {}) {
  const session = new ScopedSession({ allowedOrigins: [MAPS_ORIGIN], cookieOrigins: [MAPS_ORIGIN], cookies: input.cookies,
    defaultHeaders: { accept: '*/*' }, timeoutMs: 25000, maxResponseBytes: 8 * 1024 * 1024, maxRequestBytes: 1024, maxRedirects: 0, fetchImpl });
  return validateMapsState({ version: 1, expectedOwnerId: input.expectedOwnerId, expectedEmail: input.expectedEmail,
    listId: input.listId, clientContext: input.clientContext, xsrf: input.xsrf, authuser: input.authuser,
    importedAt: new Date(now()).toISOString(), ...(input.noteXsrf === undefined ? {} : { noteXsrf: input.noteXsrf }),
    searchParameters: input.searchParameters, session: session.toJSON() });
}

export function createGoogleMapsClient({ state, fetchImpl, now = Date.now, journalRoot, saveState = () => {},
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)), onReceipt = () => {} } = {}) {
  const s = validateMapsState(state);
  const session = ScopedSession.fromJSON(s.session, { fetchImpl });
  const journal = journalRoot ? new WriteJournal({ root: journalRoot, service: 'google-maps' }) : null;
  const checkAge = () => {
    const age = now() - Date.parse(s.importedAt);
    if (age < 0 || age > MAX_CONTEXT_AGE_MS) fail('MAPS_CONTEXT_REIMPORT_REQUIRED');
  };
  const hasAuthCookie = () => session.toJSON().cookieJar.cookies.some(c => /^(?:SID|__Secure-1PSID)$/.test(c.key)
    && c.value && (c.expires === undefined || c.expires === 'Infinity' || Date.parse(c.expires) > now()));
  async function request(path, parameters) {
    checkAge();
    if (!hasAuthCookie()) fail('MAPS_REAUTH_REQUIRED');
    const url = new URL(path, MAPS_ORIGIN); url.search = new URLSearchParams(parameters).toString();
    let r;
    try { r = await session.request(url.href, { method: 'GET' }); }
    catch { fail('MAPS_TRANSPORT_FAILED'); }
    s.session = session.toJSON(); await saveState(structuredClone(s));
    await onReceipt({ method: 'GET', origin: MAPS_ORIGIN, path, httpStatus: r.status,
      semantics: ['createitem','updateitem'].some(op => path.endsWith('/' + op)) ? 'write' : 'read',
      mime: (r.headers['content-type'] ?? '').split(';')[0], responseBytes: Buffer.byteLength(r.raw),
      responseSha256: createHash('sha256').update(r.raw).digest('hex'), checkedAt: new Date(now()).toISOString(), browserUsed: false });
    if (!hasAuthCookie() || r.status === 401) fail('MAPS_REAUTH_REQUIRED');
    if (r.status === 403) fail('MAPS_FORBIDDEN');
    if (r.status === 429) fail('MAPS_THROTTLED');
    if (r.status !== 200) fail(`MAPS_HTTP_${r.status}`);
    if (!/^(?:application\/json|text\/javascript)(?:;|$)/i.test(r.headers['content-type'] ?? '')) fail('MAPS_RESPONSE_INVALID');
    return parseMapsJson(r.raw);
  }
  const rpc = (operation, pb) => request(`/maps/preview/entitylist/${operation}`, {
    authuser: String(s.authuser), hl: 'ko', gl: 'kr', pb,
  });
  async function readList(id = s.listId) {
    if (!listId(id)) fail('MAPS_INPUT_INVALID');
    return decodeMapsList(await rpc('getlist', mapsListPb(id, s.clientContext)), id, s.expectedOwnerId);
  }
  async function search(query) {
    if (!bounded(query, 400)) fail('MAPS_INPUT_INVALID');
    const parameters = { ...s.searchParameters, q: query, oe: 'utf-8', pb: s.searchParameters.pb.replace(/^!2i\d+/, `!2i${query.length}`) };
    const data = await request('/s', parameters);
    const candidates = decodeMapsSearch(data, query);
    return { query, candidates, skippedUnsaveablePredictions: data[0][1].length - candidates.length, complete: false,
      scope: 'autocomplete_predictions', mode: 'pure_http' };
  }
  async function mutationReadback(list, matches) {
    let current;
    // Maps ACKs before all getlist replicas expose the update. Retry only reads.
    for (const delay of [0, 250, 500, 1000, 2000]) {
      if (delay) await sleepImpl(delay);
      current = await readList(list);
      if (current.complete && current.items.some(matches)) return { current, found: true };
    }
    return { current, found: false };
  }
  async function addPlace({ list = s.listId, place, confirm } = {}) {
    const pb = mapsAddPb(list, place, s.clientContext, s.xsrf);
    if (confirm !== 'CONFIRM') fail('MAPS_CONFIRM_REQUIRED');
    if (!journal) fail('MAPS_JOURNAL_REQUIRED');
    const before = await readList(list);
    if (!before.complete) fail('MAPS_INCOMPLETE_READBACK');
    if (before.items.some(x => x.fid?.toLowerCase() === place.fid.toLowerCase())) return { status: 'already_saved', itemCount: before.items.length, mode: 'pure_http' };
    const key = journal.key('add-place', { owner: s.expectedOwnerId, list }, { fid: place.fid.toLowerCase() });
    await journal.reserve(key, { operation: 'add-place', wireMethod: 'GET', browserUsed: false });
    let sent = false;
    try {
      sent = true;
      const ack = await rpc('createitem', pb);
      if (ack.length !== 0) fail('MAPS_WRITE_ACK_INVALID');
      await journal.finish(key, 'acknowledged_requires_readback', { httpStatus: 200 });
      const { current: after, found } = await mutationReadback(list, x => x.fid?.toLowerCase() === place.fid.toLowerCase());
      await journal.reconcile(key, { result: found ? 'found' : 'ambiguous', itemCount: after.items.length });
      if (!found) fail('MAPS_WRITE_OUTCOME_UNKNOWN');
      return { status: 'saved_verified', itemCount: after.items.length, mode: 'pure_http', journalKey: key };
    } catch (e) {
      if (sent && (await journal.read(key))?.status === 'reserved') await journal.finish(key, 'outcome_unknown', { reason: 'read_only_reconciliation_required' });
      throw e;
    }
  }
  async function updateNote({ list = s.listId, fid, coordinate, note, expectedNote, confirm, retryAfterVerifiedAbsence = false } = {}) {
    if (!s.noteXsrf) fail('MAPS_NOTE_CONTEXT_REQUIRED');
    if (coordinate !== undefined && fid !== undefined) fail('MAPS_INPUT_INVALID');
    const pb = coordinate === undefined ? mapsNotePb(list, fid, note, s.clientContext, s.noteXsrf)
      : mapsCoordinateNotePb(list, coordinate, note, s.clientContext, s.noteXsrf);
    const identity = coordinate === undefined ? { fid: fid.toLowerCase() } : { coordinateKey: coordinateKey(coordinate) };
    const matches = x => coordinate === undefined ? x.fid?.toLowerCase() === identity.fid
      : x.kind === 'coordinate' && x.lat === coordinate.lat && x.lng === coordinate.lng;
    if (confirm !== 'CONFIRM') fail('MAPS_CONFIRM_REQUIRED');
    if (!journal) fail('MAPS_JOURNAL_REQUIRED');
    const before = await readList(list);
    if (!before.complete) fail('MAPS_INCOMPLETE_READBACK');
    const item = before.items.find(matches);
    if (!item) fail('MAPS_ITEM_NOT_FOUND');
    if (item.note === note) return { status: 'already_set', mode: 'pure_http' };
    if (item.note !== expectedNote) fail('MAPS_NOTE_CONFLICT');
    let key = journal.key('update-note', { owner: s.expectedOwnerId, list, ...identity }, { note });
    let originalIntentKey;
    if (retryAfterVerifiedAbsence === true) {
      const previous = await journal.read(key);
      if (previous?.status !== 'reconciled' || previous.reconciliation?.result !== 'not-found') fail('MAPS_VERIFIED_ABSENCE_REQUIRED');
      originalIntentKey = key;
      // One explicit linked repair attempt. The original key/record is preserved;
      // a second invocation cannot reserve this attempt again.
      key = journal.key('update-note-retry', { originalIntentKey }, { note });
    }
    await journal.reserve(key, { operation: 'update-note', wireMethod: 'GET', browserUsed: false, ...(originalIntentKey ? { originalIntentKey } : {}) });
    try {
      const ack = await rpc('updateitem', pb);
      if (ack.length !== 0) {
        const e = Object.assign(new Error('MAPS_WRITE_ACK_INVALID'), { code: 'MAPS_WRITE_ACK_INVALID',
          detail: { responseShape: ack.slice(0,8).map(x => Array.isArray(x) ? x.slice(0,8).map(y => typeof y === 'string' ? `string:${y.length}` : typeof y === 'number' || y === null ? y : typeof y) : typeof x) } });
        throw e;
      }
      await journal.finish(key, 'acknowledged_requires_readback', { httpStatus: 200 });
      const { found } = await mutationReadback(list, x => matches(x) && x.note === note);
      await journal.reconcile(key, { result: found ? 'found' : 'ambiguous' });
      if (!found) fail('MAPS_WRITE_OUTCOME_UNKNOWN');
      return { status: 'note_verified', mode: 'pure_http', journalKey: key };
    } catch (e) {
      if ((await journal.read(key))?.status === 'reserved') await journal.finish(key, 'outcome_unknown', { reason: 'read_only_reconciliation_required' });
      throw e;
    }
  }
  async function reconcile({ operation, list = s.listId, fid, coordinate, note } = {}) {
    if (!journal) fail('MAPS_JOURNAL_REQUIRED');
    const isCoordinate = coordinate !== undefined;
    if (!['add-place','update-note'].includes(operation) || isCoordinate && (operation !== 'update-note' || fid !== undefined || !validCoordinate(coordinate))
      || !isCoordinate && !/^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i.test(fid ?? '')
      || operation === 'update-note' && typeof note !== 'string') fail('MAPS_INPUT_INVALID');
    const identity = isCoordinate ? { coordinateKey: coordinateKey(coordinate) } : { fid: fid.toLowerCase() };
    const key = operation === 'add-place'
      ? journal.key(operation, { owner: s.expectedOwnerId, list }, { fid: fid.toLowerCase() })
      : journal.key(operation, { owner: s.expectedOwnerId, list, ...identity }, { note });
    const record = await journal.read(key);
    if (!record) fail('MAPS_INTENT_NOT_FOUND');
    const current = await readList(list);
    if (!current.complete) fail('MAPS_INCOMPLETE_READBACK');
    const item = current.items.find(x => isCoordinate ? x.kind === 'coordinate' && x.lat === coordinate.lat && x.lng === coordinate.lng
      : x.fid?.toLowerCase() === identity.fid);
    const found = Boolean(item && (operation === 'add-place' || item.note === note));
    const result = found ? 'found' : 'not-found';
    if (record.status !== 'reconciled') await journal.reconcile(key, { result, itemCount: current.items.length });
    return { result, journalKey: key, complete: true, mode: 'pure_http' };
  }
  return { readList, search, addPlace, updateNote, reconcile, mode: 'pure_http', bootstrapMode: 'owner_verified_browser_context_import', renewalVerified: false };
}
