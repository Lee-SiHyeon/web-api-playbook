import { verifyAgyRecordedEvidence } from '../lib/agy-remote-evidence.mjs';
import { safeError } from '../lib/cli.mjs';
try { console.log(JSON.stringify(await verifyAgyRecordedEvidence())); }
catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error), networkUsed: false })); process.exitCode = 1; }
