import path from 'node:path';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { options, stdinJsonNoEcho, safeError, jsonFile } from '../lib/cli.mjs';
import { createGoogleMapsClient, importMapsState, MAPS_STORE } from '../lib/google-maps.mjs';

try {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (command === 'help') {
    console.log('google-maps.mjs session-import|status|list|search|add|note|reconcile --store-dir=<private-directory> [--query=<text>] [--input=<place-or-note.json>] [--confirm=CONFIRM] [--journal-dir=<private-directory>]');
  } else {
    const args = options(rest, ['store-dir','query','input','confirm','journal-dir']);
    if (!['session-import','status','list','search','add','note','reconcile'].includes(command) || typeof args['store-dir'] !== 'string') throw Object.assign(new Error(), { code: 'MAPS_ARGUMENT_INVALID' });
    const store = new ProtectedStore({ directory: args['store-dir'] });
    if (command === 'status') {
      console.log(JSON.stringify({ service: 'google-maps', storage: await store.status(MAPS_STORE), authenticated: 'not_probed' }));
    } else {
      const state = command === 'session-import'
        ? importMapsState(await stdinJsonNoEcho(512 * 1024))
        : JSON.parse(store.read(MAPS_STORE) || 'null');
      let verifiedState = state;
      const client = createGoogleMapsClient({ state, journalRoot: args['journal-dir'],
        saveState: s => { if (command === 'session-import') verifiedState = s; else store.write(MAPS_STORE, JSON.stringify(s)); } });
      let result;
      if (command === 'session-import') {
        const list = await client.readList();
        store.write(MAPS_STORE, JSON.stringify(verifiedState));
        result = { imported: true, ownerVerified: true, itemCount: list.items.length, mode: 'pure_http', loginAcquisition: 'existing_browser_session', renewalVerified: false };
      } else if (command === 'list') result = await client.readList();
      else if (command === 'search') result = await client.search(args.query);
      else if (command === 'reconcile') result = await client.reconcile(await jsonFile(args.input));
      else if (command === 'note') result = await client.updateNote({ ...await jsonFile(args.input), confirm: args.confirm });
      else result = await client.addPlace({ place: await jsonFile(args.input), confirm: args.confirm });
      console.log(JSON.stringify({ ok: true, ...result }));
    }
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, code: safeError(e) }));
  process.exitCode = 1;
}
