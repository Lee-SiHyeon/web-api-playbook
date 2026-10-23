export const capabilities = Object.freeze({
  naver: ['neighbor', 'request'],
  tistory: ['subscribe', 'unsubscribe'],
  x: ['follow', 'unfollow'],
  threads: ['follow', 'unfollow'],
  instagram: ['follow', 'unfollow'],
});

export async function providerFor(service) {
  if (service === 'instagram' || service === 'threads') {
    const m = await import('./providers/meta.mjs');
    return { prepare: (input, options) => m.prepareMetaAction({ ...input, service }, options),
      execute: (input, options) => m.executeMetaAction({ ...input, service }, options) };
  }
  if (service === 'naver') {
    const m = await import('./providers/naver.mjs');
    return { prepare: m.prepareNaverAction, execute: m.executeNaverAction };
  }
  if (service === 'tistory') {
    const m = await import('./providers/tistory.mjs');
    return { prepare: m.prepareTistoryAction, execute: m.executeTistoryAction };
  }
  if (service === 'x') {
    const m = await import('./providers/x.mjs');
    return { prepare: m.prepareXAction, execute: m.executeXAction };
  }
  throw Object.assign(new Error('SOCIAL_SERVICE_INVALID'), { code: 'SOCIAL_SERVICE_INVALID' });
}

export async function prepareAction(input) {
  return (await providerFor(input?.service)).prepare(input);
}

export async function executeAction(input, options) {
  const { executeJournaled } = await import('./lib/journal.mjs');
  return executeJournaled(input, await providerFor(input?.service), options);
}

export async function reconcileAction(journalPath, overrides) {
  const { reconcileJournal } = await import('./lib/journal.mjs');
  return reconcileJournal(journalPath, providerFor, overrides);
}
