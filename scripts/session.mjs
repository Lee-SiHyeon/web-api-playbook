import { ScopedSession } from '../lib/scoped-session.mjs';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { withSessionLock } from '../lib/session-lock.mjs';
import path from 'node:path';
import { validateProfile, serviceName } from '../lib/profile.mjs';
import { options, fail, jsonFile, stdinJson, safeError } from '../lib/cli.mjs';

try {
 const [command, ...argv] = process.argv.slice(2);
 const args = options(argv, ['name','profile','store-dir']);
 if (!['status','import'].includes(command) || !serviceName(args.name)) fail('SESSION_ARGUMENT_INVALID');
 const store = new ProtectedStore({ directory: typeof args['store-dir'] === 'string' ? args['store-dir'] : undefined });
 if (command === 'status') {
  const status = await store.status(args.name);
  console.log(JSON.stringify({ name: args.name, storage: status, serviceSessionVerified: false }));
 } else {
  const profile = validateProfile(await jsonFile(args.profile));
  const input = await stdinJson(512 * 1024);
  if (input.serviceId !== profile.serviceId || !input.session || !input.identity || typeof input.identity !== 'object' || Array.isArray(input.identity)) fail('SESSION_INPUT_INVALID');
  const session = new ScopedSession({ allowedOrigins: profile.allowedOrigins, cookieOrigins: profile.cookieOrigins ?? profile.allowedOrigins,
   allowLoopbackHttp: profile.allowLoopbackHttp === true,
   cookies: input.session.cookies ?? [], headersByOrigin: input.session.headersByOrigin ?? {}, defaultHeaders: input.session.defaultHeaders ?? {} });
  const value = JSON.stringify({ schemaVersion: 1, serviceId: profile.serviceId, session: session.toJSON(), identity: input.identity, importedAt: new Date().toISOString(), protectedProbeVerified: false });
  const result = await withSessionLock(() => store.write(args.name, value), { root: path.join(store.directory, 'locks'), key: args.name });
  console.log(JSON.stringify({ imported: true, name: args.name, storage: result, serviceSessionVerified: false, next: 'Run the named protected read through the same request runner' }));
 }
} catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error) })); process.exitCode = 1; }
