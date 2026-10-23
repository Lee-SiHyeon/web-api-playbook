import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspectOnboarding } from './api-only-onboarding.mjs';

const manifestPath = fileURLToPath(new URL('../references/api-only-onboarding.json', import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const result = await inspectOnboarding({ manifest, allowRenewal: false });
console.log(JSON.stringify({
  checkedAt: result.checkedAt,
  mode: 'direct_http_check_only',
  allowRenewal: false,
  browserUsed: false,
  credentialValuesPrinted: false,
  coverage: result.services.map(({ id, authentication }) => ({ id, authentication })),
  services: result.services,
}, null, 2));
