import { openMetaContext, withMetaSessionLock } from './meta-bootstrap.mjs';

// Startup needs the protected owner's identity, not a saved timeline GraphQL
// request. The maintained document bootstrap verifies viewer ID/handle and
// rotates only observed first-party cookies. No GraphQL hold is bypassed.
export async function verifyThreadsRuntimeOwner() {
  return withMetaSessionLock('threads', async () => {
    const context = await openMetaContext('threads', 'lifehack__ailab');
    return { authenticated: context.documentReceipt?.ownerVerified === true,
      ownerVerified: context.documentReceipt?.ownerVerified === true,
      httpStatus: context.documentReceipt?.httpStatus, verificationSource: 'fresh_authenticated_owner_document' };
  });
}
