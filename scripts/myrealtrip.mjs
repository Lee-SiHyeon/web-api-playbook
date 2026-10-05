import { createMyrealtripAuth, WebAuthError } from '../lib/web-auth/myrealtrip.mjs';
import { createMyrealtripClient, MyrealtripError, runMyrealtripEnvelope, marketingErrorResult } from '../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs';
import { createDefaultMyrealtripLinkJournal, createMyrealtripLinkFlow } from '../lib/myrealtrip-link-flow.mjs';
import { stdinJson } from '../lib/cli.mjs';

const COMPOSITE_LINK_COVERAGE = 'uncovered_composite_createLink';
let input;

function validCreateLinkInput(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && Object.hasOwn(value, 'operation') && Object.hasOwn(value, 'input')
    && value.operation === 'createLink'
    && value.input && typeof value.input === 'object' && !Array.isArray(value.input)
    && Object.keys(value.input).length === 1 && Object.hasOwn(value.input, 'targetUrl');
}

function execution(authentication, writeJournalCoverage) {
  return {
    mode: 'pure_http',
    browserUsed: false,
    credentialProvider: 'Windows DPAPI CurrentUser',
    renewal: authentication.renewal,
    ...(writeJournalCoverage ? { writeJournalCoverage } : {}),
  };
}

try {
  input = await stdinJson(64 * 1024);
  if (input.session || input.services) throw Error();
  const result = await createMyrealtripAuth().withSession(async (session, authentication) => {
    if (input.operation === 'createLink') {
      if (!validCreateLinkInput(input)) throw new MyrealtripError('INPUT');
      const client = await createMyrealtripClient(session);
      try {
        const flow = createMyrealtripLinkFlow({ client, ownerId: session.expectedPartnerId, journal: createDefaultMyrealtripLinkJournal() });
        const linked = await flow.create({ targetUrl: input.input.targetUrl });
        return { ...linked, execution: execution(authentication, 'createLink_only') };
      } finally { client.close(); }
    }
    const output = await runMyrealtripEnvelope({
      ...input, schemaVersion: 1, acquiredAt: new Date().toISOString(), session,
    });
    return {
      ...output,
      execution: execution(authentication, input.operation === 'createFlightLink' ? COMPOSITE_LINK_COVERAGE : undefined),
    };
  });
  console.log(JSON.stringify(result));
  if (result?.ok === false) process.exitCode = 2;
} catch (error) {
  const isCreateLink = input?.operation === 'createLink';
  const isFlightLink = input?.operation === 'createFlightLink';
  const base = error instanceof WebAuthError ? { ok: false, code: error.code } : marketingErrorResult(error);
  console.log(JSON.stringify({
    ...base,
    ...(isCreateLink ? {
      outcome: error?.outcome === 'unknown' ? 'unknown' : error?.outcome === 'rejected' ? 'rejected' : 'not_sent',
      writeAttempted: error?.outcome === 'unknown' ? null : error?.outcome === 'rejected' ? true : false,
    } : {}),
    ...(isFlightLink ? { writeJournalCoverage: COMPOSITE_LINK_COVERAGE } : {}),
  }));
  process.exitCode = 2;
} finally {
  input = null;
}
