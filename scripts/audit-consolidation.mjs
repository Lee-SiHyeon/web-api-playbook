import { fileURLToPath } from 'node:url';
import { auditConsolidation } from '../lib/consolidation-audit.mjs';

if (process.argv.length !== 2) throw Error('CONSOLIDATION_ARGUMENT_INVALID');
const result = await auditConsolidation(fileURLToPath(new URL('../', import.meta.url)));
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.ok ? 0 : 1;
