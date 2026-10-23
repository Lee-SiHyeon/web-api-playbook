// Local readiness only: decrypt inside the provider and emit metadata, never values.
// No browser, login, network requests, cookie rotation or store mutation.
import { pathToFileURL } from 'node:url';
import { shoppingOrigins, shoppingSessionStatus } from '../lib/shopping-session-store.mjs';

export function inspectShoppingSessions(services = Object.keys(shoppingOrigins)) {
  if (!Array.isArray(services) || !services.length || services.some(service => !Object.hasOwn(shoppingOrigins, service)))
    throw Object.assign(new Error('SERVICE_SCOPE'), { code: 'SERVICE_SCOPE' });
  const statuses = [...new Set(services)].map(service => shoppingSessionStatus(service));
  return {
    kind: 'shopping_session_readiness', schemaVersion: 1, checkedAt: new Date().toISOString(),
    browserUsed: false, networkRequests: 0, credentialValuesReturned: false,
    liveReplayPerformed: false, services: statuses,
    readyForAttemptCount: statuses.filter(status => status.usableForAttempt).length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const services = process.argv.slice(2);
    console.log(JSON.stringify(inspectShoppingSessions(services.length ? services : undefined), null, 2));
  } catch {
    console.log(JSON.stringify({ ok: false, code: 'SHOPPING_STATUS_INPUT_OR_PROVIDER_FAILED' }));
    process.exitCode = 2;
  }
}
