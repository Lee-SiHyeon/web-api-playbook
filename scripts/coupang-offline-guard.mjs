// Regression children must never read the real provider or make a live request.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const deny = code => { throw Object.assign(new Error(code), { code }); };
globalThis.fetch = async () => deny('COUPANG_REGRESSION_NETWORK_FORBIDDEN');
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, options) {
  if (Array.isArray(args) && args.some(arg => /(?:^|[/\\])dpapi-store\.ps1$/i.test(String(arg))))
    deny('COUPANG_REGRESSION_PROTECTED_STORE_FORBIDDEN');
  return execFileSync.call(this, file, args, options);
};
syncBuiltinESMExports();
