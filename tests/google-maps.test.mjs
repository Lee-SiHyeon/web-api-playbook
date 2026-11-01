import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGoogleMapsClient, importMapsState, parseMapsJson, decodeMapsSearch, decodeMapsList, mapsListPb, mapsAddPb } from '../lib/google-maps.mjs';

const makeClient = options => createGoogleMapsClient({ ...options, sleepImpl: async () => {} });
const time = Date.now();
const id = 'synthetic-list-00000001';
const owner = '100000000000000000001';
const place = { name: '합성 장소 !1s injection', address: 'Synthetic address', fid: '0xffffffffffffffff:0xe7d7d3c2b753738d', lat: 41.9, lng: 12.5 };
function state() {
  return importMapsState({ expectedOwnerId: owner, expectedEmail: 'owner@example.invalid', listId: id, authuser: 0,
    clientContext: 'synthetic-context', xsrf: 'synthetic-antiforgery', noteXsrf: 'synthetic-note-antiforgery',
    cookies: [{ name: 'SID', value: 'synthetic-cookie', domain: '.google.com', path: '/', secure: true }],
    searchParameters: { tbm: 'map', gs_ri: 'maps', suggest: 'p', authuser: '0', hl: 'ko', gl: 'kr', q: 'seed', pb: '!2i4!10b1' } }, { now: () => time });
}
function listData(items = [], { count = items.length, ownerId = owner, list = id } = {}) {
  const d = []; d[0] = [list, 1, null, 1, 1]; d[1] = 1; d[2] = [1, 1]; d[3] = ['Synthetic owner', '', ownerId];
  d[4] = 'Synthetic trip'; d[5] = 'Synthetic description'; d[8] = items.map(p => {
    const r = []; r[1] = []; r[1][5] = [null, null, p.lat, p.lng]; r[1][6] = p.fid.split(':').map(x => BigInt(x).toString());
    r[2] = p.name; r[3] = ''; return r;
  }); d[12] = count; return [d, ''];
}
function searchData(query, p = place) {
  const d = []; d[1] = [p.name, []]; d[11] = [null, null, p.lat, p.lng]; d[14] = [p.address, p.fid];
  const row = []; row[22] = d; return [[query, [row]]];
}
const response = (data, headers = {}) => new Response(
  ")]}'\n" + JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } });
async function temporary(fn) {
  const root = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, 'maps-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('XSSI JSON parser rejects HTML, objects, oversized responses and malformed prefixes', () => {
  assert.deepEqual(parseMapsJson(")]}'\n[]"), []);
  for (const raw of ['<html>Sign in</html>', '{}', 'prefix []', '[' + ' '.repeat(8 * 1024 * 1024) + ']']) {
    assert.throws(() => parseMapsJson(raw), { code: 'MAPS_RESPONSE_INVALID' });
  }
});
test('search decoder binds the echoed query, feature identity, coordinates and valid Unicode', () => {
  assert.deepEqual(decodeMapsSearch(searchData('q'), 'q'), [place]);
  assert.throws(() => decodeMapsSearch(searchData('wrong'), 'q'), { code: 'MAPS_SEARCH_SCHEMA_INVALID' });
  for (const bad of [{ ...place, name: '\uFFFD' }, { ...place, lat: 95 }, { ...place, fid: 'javascript:bad' }]) {
    assert.throws(() => decodeMapsSearch(searchData('q', bad), 'q'), { code: 'MAPS_SEARCH_CANDIDATE_INVALID' });
  }
});
test('list decoder preserves unsigned 64-bit IDs and reports incomplete lists', () => {
  assert.equal(decodeMapsList(listData([place]), id, owner).items[0].fid, place.fid);
  const signed = listData([place]); signed[0][8][0][1][6] = place.fid.split(':').map(x => BigInt.asIntN(64, BigInt(x)).toString());
  assert.equal(decodeMapsList(signed, id, owner).items[0].fid, place.fid, 'the live backend returns signed int64 values');
  assert.equal(decodeMapsList(listData([], { count: 501 }), id, owner).complete, false);
  assert.throws(() => decodeMapsList(listData([], { ownerId: '100000000000000000002' }), id, owner), { code: 'MAPS_OWNER_MISMATCH' });
  assert.throws(() => decodeMapsList(listData([], { list: 'other-list-00000001' }), id, owner), { code: 'MAPS_LIST_SCHEMA_INVALID' });
});
test('coordinate pins use their observed location identity without pretending to be a business feature', () => {
  const data = listData([place]); const row = data[0][8][0];
  row[1][6] = null; row[8] = [[1], null, [null, null, place.lat, place.lng]];
  const result = decodeMapsList(data, id, owner).items[0];
  assert.equal(result.fid, null); assert.equal(result.kind, 'coordinate');
  assert.equal(result.coordinateKey, '419000000,125000000');
  row[8][2][2] = place.lat + 1;
  assert.throws(() => decodeMapsList(data, id, owner), { code: 'MAPS_LIST_ITEM_SCHEMA_INVALID' });
});
test('coordinate notes use the observed coordinate key and cannot edit a nearby pin', async () => temporary(async directory => {
  let note = '', writes = 0;
  const coordinate = { lat: place.lat, lng: place.lng };
  const c = makeClient({ state: state(), journalRoot: directory, now: () => time, fetchImpl: async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/updateitem')) {
      const pb = u.searchParams.get('pb'); assert.ok(pb.includes('!1m5!1m1!1e1!3m2!3d41.9!4d12.5!2z'));
      writes++; note = 'Coordinate note'; return response([]);
    }
    const data = listData([place]); const row = data[0][8][0];
    row[1][6] = null; row[8] = [[1], null, [null, null, place.lat, place.lng]]; row[3] = note;
    return response(data);
  } });
  await assert.rejects(c.updateNote({ coordinate: { ...coordinate, lat: coordinate.lat + 1e-9 }, note: 'Coordinate note', expectedNote: '', confirm: 'CONFIRM' }), { code: 'MAPS_ITEM_NOT_FOUND' });
  assert.equal((await c.updateNote({ coordinate, note: 'Coordinate note', expectedNote: '', confirm: 'CONFIRM' })).status, 'note_verified');
  assert.equal(writes, 1);
}));
test('delayed replication causes only bounded readback polls, never another mutation', async () => temporary(async directory => {
  let writes = 0, afterReads = 0; const waits = [];
  const c = createGoogleMapsClient({ state: state(), journalRoot: directory, now: () => time,
    sleepImpl: async ms => waits.push(ms), fetchImpl: async url => {
      if (new URL(url).pathname.endsWith('/createitem')) { writes++; return response([]); }
      if (writes && ++afterReads >= 3) return response(listData([place]));
      return response(listData());
    } });
  assert.equal((await c.addPlace({ place, confirm: 'CONFIRM' })).status, 'saved_verified');
  assert.equal(writes, 1); assert.equal(afterReads, 3); assert.deepEqual(waits, [250, 500]);
}));
test('street-only autocomplete predictions are counted separately from saveable features', async () => {
  const data = searchData('q'); const street = structuredClone(data[0][1][0]); street[22][14] = ['Synthetic street'];
  data[0][1].push(street);
  assert.deepEqual(decodeMapsSearch(data, 'q'), [place]);
});
test('note writes use their own observed action token and preserve Unicode and newlines', async () => temporary(async directory => {
  let savedNote = '', writes = 0;
  const note = '합성 날짜 · 후보\n확정 예약이 아님';
  const c = makeClient({ state: state(), journalRoot: directory, now: () => time, fetchImpl: async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/updateitem')) {
      const pb = u.searchParams.get('pb'); assert.ok(pb.endsWith('!4ssynthetic-note-antiforgery'));
      assert.ok(!pb.endsWith('!4ssynthetic-antiforgery')); assert.ok(pb.includes('!2z' + Buffer.from(note).toString('base64url')));
      writes++; savedNote = note; return response([]);
    }
    const list = listData([place]); list[0][8][0][3] = savedNote; return response(list);
  } });
  await assert.rejects(c.updateNote({ fid: place.fid, note, expectedNote: 'wrong', confirm: 'CONFIRM' }), { code: 'MAPS_NOTE_CONFLICT' });
  assert.equal((await c.updateNote({ fid: place.fid, note, expectedNote: '', confirm: 'CONFIRM' })).status, 'note_verified');
  assert.equal(writes, 1);
}));
test('explicit note repair requires independent absence reconciliation and retains the original intent', async () => temporary(async directory => {
  let failWrite = true, savedNote = '', writes = 0;
  const note = 'Synthetic note';
  const c = makeClient({ state: state(), journalRoot: directory, now: () => time, fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/updateitem')) {
      writes++; if (failWrite) return new Response('rejected', { status: 400 }); savedNote = note; return response([]);
    }
    const list = listData([place]); list[0][8][0][3] = savedNote; return response(list);
  } });
  const input = { fid: place.fid, note, expectedNote: '', confirm: 'CONFIRM' };
  await assert.rejects(c.updateNote(input), { code: 'MAPS_HTTP_400' });
  await assert.rejects(c.updateNote({ ...input, retryAfterVerifiedAbsence: true }), { code: 'MAPS_VERIFIED_ABSENCE_REQUIRED' });
  const r = await c.reconcile({ operation: 'update-note', fid: place.fid, note }); assert.equal(r.result, 'not-found');
  failWrite = false;
  assert.equal((await c.updateNote({ ...input, retryAfterVerifiedAbsence: true })).status, 'note_verified');
  assert.equal(writes, 2);
  const records = await readdir(path.join(directory, 'google-maps')); assert.equal(records.length, 2);
  const retry = await Promise.all(records.map(f => readFile(path.join(directory, 'google-maps', f), 'utf8')));
  assert.ok(retry.some(x => x.includes(r.journalKey) && x.includes('originalIntentKey')));
}));
test('wire builders prevent protobuf delimiter injection and retain full integer precision', () => {
  const pb = mapsAddPb(id, place, 'context', 'xsrf');
  assert.ok(pb.includes('!1y-1!2y-1740689897702591603'));
  assert.ok(pb.includes('!3z' + Buffer.from(place.name).toString('base64url')));
  assert.throws(() => mapsListPb('bad!4stoken', 'context'), { code: 'MAPS_INPUT_INVALID' });
  assert.throws(() => mapsAddPb(id, place, 'context!2i9', 'xsrf'), { code: 'MAPS_INPUT_INVALID' });
});
test('search sends UTF-8 output negotiation and UTF-16 cursor position without a browser', async () => {
  const query = '지도 😀';
  const client = makeClient({ state: state(), now: () => time, fetchImpl: async (url, init) => {
    const u = new URL(url); assert.equal(u.origin, 'https://www.google.com'); assert.equal(u.pathname, '/s');
    assert.equal(u.searchParams.get('q'), query); assert.equal(u.searchParams.get('oe'), 'utf-8');
    assert.equal(u.searchParams.get('pb'), `!2i${query.length}!10b1`);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.ok(init.headers.get('cookie').includes('SID=synthetic-cookie'));
    return response(searchData(query));
  } });
  assert.equal((await client.search(query)).mode, 'pure_http');
});
test('confirmation, journal, expiry and altered origin are rejected before any request', async () => {
  let called = 0; const fetchImpl = async () => { called++; throw Error('not reached'); };
  const c = makeClient({ state: state(), now: () => time, fetchImpl });
  await assert.rejects(c.addPlace({ place }), { code: 'MAPS_CONFIRM_REQUIRED' });
  await assert.rejects(c.addPlace({ place, confirm: 'CONFIRM' }), { code: 'MAPS_JOURNAL_REQUIRED' });
  const expired = makeClient({ state: state(), now: () => time + 3600001, fetchImpl });
  await assert.rejects(expired.readList(), { code: 'MAPS_CONTEXT_REIMPORT_REQUIRED' });
  const altered = state(); altered.session.allowedOrigins.push('https://example.invalid');
  assert.throws(() => makeClient({ state: altered, fetchImpl }), { code: 'MAPS_TRANSPORT_STATE_INVALID' });
  assert.equal(called, 0);
});
test('wrong owner and incomplete pre-read block GET mutations', async () => temporary(async directory => {
  for (const [data, code] of [[listData([], { ownerId: '100000000000000000002' }), 'MAPS_OWNER_MISMATCH'],
    [listData([], { count: 501 }), 'MAPS_INCOMPLETE_READBACK']]) {
    let writes = 0;
    const c = makeClient({ state: state(), journalRoot: directory, now: () => time, fetchImpl: async url => {
      if (new URL(url).pathname.endsWith('/createitem')) writes++;
      return response(data);
    } });
    await assert.rejects(c.addPlace({ place, confirm: 'CONFIRM' }), { code }); assert.equal(writes, 0);
  }
}));
test('a GET write needs independent readback; subsequent calls skip existing items', async () => temporary(async directory => {
  let written = false, mutations = 0;
  const c = makeClient({ state: state(), journalRoot: directory, now: () => time, fetchImpl: async (url, init) => {
    assert.equal(init.method, 'GET');
    if (new URL(url).pathname.endsWith('/createitem')) { written = true; mutations++; return response([]); }
    return response(listData(written ? [place] : []));
  } });
  assert.equal((await c.addPlace({ place, confirm: 'CONFIRM' })).status, 'saved_verified');
  assert.equal((await c.addPlace({ place, confirm: 'CONFIRM' })).status, 'already_saved'); assert.equal(mutations, 1);
  const journalFiles = await readdir(path.join(directory, 'google-maps'));
  const record = await readFile(path.join(directory, 'google-maps', journalFiles[0]), 'utf8');
  assert.ok(record.includes('reconciled')); assert.ok(!record.includes('synthetic-cookie')); assert.ok(!record.includes('synthetic-antiforgery'));
}));
test('an acknowledged but missing item remains unknown and cannot be blindly resent', async () => temporary(async directory => {
  let writes = 0;
  const c = makeClient({ state: state(), journalRoot: directory, now: () => time, fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/createitem')) { writes++; return response([]); } return response(listData());
  } });
  await assert.rejects(c.addPlace({ place, confirm: 'CONFIRM' }), { code: 'MAPS_WRITE_OUTCOME_UNKNOWN' });
  await assert.rejects(c.addPlace({ place, confirm: 'CONFIRM' }), { code: 'WRITE_JOURNAL_EXISTS' }); assert.equal(writes, 1);
}));
test('a transport timeout after mutation transmission leaves a journal and never retries', async () => temporary(async directory => {
  let writes = 0;
  const c = makeClient({ state: state(), journalRoot: directory, now: () => time, fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/createitem')) { writes++; throw new Error('network'); } return response(listData());
  } });
  await assert.rejects(c.addPlace({ place, confirm: 'CONFIRM' }), { code: 'MAPS_TRANSPORT_FAILED' });
  await assert.rejects(c.addPlace({ place, confirm: 'CONFIRM' }), { code: 'WRITE_JOURNAL_EXISTS' }); assert.equal(writes, 1);
}));
test('a trusted response deleting authentication invalidates even a 200 list read', async () => {
  const c = makeClient({ state: state(), now: () => time, fetchImpl: async () =>
    response(listData(), { 'set-cookie': 'SID=; Max-Age=0; Domain=.google.com; Path=/; Secure' }) });
  await assert.rejects(c.readList(), { code: 'MAPS_REAUTH_REQUIRED' });
});
test('cross-origin redirects are not followed and a login page never counts as a list', async () => {
  for (const make of [() => new Response('', { status: 302, headers: { location: 'https://example.invalid/' } }),
    () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
    let calls = 0;
    const c = makeClient({ state: state(), now: () => time, fetchImpl: async () => { calls++; return make(); } });
    await assert.rejects(c.readList()); assert.equal(calls, 1);
  }
});
