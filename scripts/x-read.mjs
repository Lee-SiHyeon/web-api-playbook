import { createXAuth } from '../lib/web-auth/x.mjs';
import { createXClient, collectXPages, XApiError } from '../lib/web-auth/x-read-client.mjs';
import { WebAuthError } from '../lib/web-auth/myrealtrip.mjs';

try {
  const [handle, rawLimit = '10'] = process.argv.slice(2);
  const limit = Number(rawLimit);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle || '') || !Number.isInteger(limit) || limit < 1 || limit > 30) {
    throw new WebAuthError('X_INPUT');
  }
  const result = await createXAuth().withSession(async session => {
    const client = await createXClient({ session, fetchImpl: session.fetchImpl });
    try { return await collectXPages(client, handle, { limit, maxPages: 2 }); }
    finally { client.close(); }
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  const known = error instanceof WebAuthError || error instanceof XApiError;
  console.log(JSON.stringify({ ok: false, code: known ? error.code : 'X_READ_FAILED' }));
  process.exitCode = 2;
}
