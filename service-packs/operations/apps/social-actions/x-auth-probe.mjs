import { createXAuth } from '../../../../lib/web-auth/x.mjs';
import { withXReadContext } from './providers/x.mjs';
for (let i = 0; i < 5; i++) {
  try { const result = process.argv.includes('--scoped') ? await withXReadContext(async () => ({ authenticated: true, ownerVerified: true })) : await createXAuth().health(); console.log(JSON.stringify({ attempt: i + 1, authenticated: result.authenticated, ownerVerified: result.ownerVerified })); }
  catch (error) { console.log(JSON.stringify({ attempt: i + 1, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'X_PROBE_FAILED', httpStatus: error.receipt?.httpStatus || null, mime: error.receipt?.mime || null, errorCodes: error.receipt?.errorCodes || [] })); break; }
}
