const fail = code => { throw Object.assign(new Error(code), { code }); };
const SECRET_FIELD = /secret|token|accesskey|apikey|appkey|appid|applicationid|clientid|credentialid|authorization|password/i;

/** Inspect only credential fields; session origin/name metadata is not a secret. */
export function assertCredentialFreeResult(result, credentials) {
  const secrets = new Set();
  function visit(value, key = '', ancestry = '', depth = 0) {
    if (depth > 16) fail('COMMERCE_CREDENTIAL_INPUT_INVALID');
    if (typeof value === 'string') {
      if ((SECRET_FIELD.test(key) || key === 'value' && /cookies/i.test(ancestry) || key === 'cookie') && value.length >= 8) secrets.add(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, key, ancestry + '.' + key, depth + 1); return; }
    if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey, ancestry + '.' + key, depth + 1);
  }
  visit(credentials);
  const serialized = JSON.stringify(result);
  if ([...secrets].some(secret => serialized.includes(secret))) fail('COMMERCE_SECRET_IN_RESULT');
}
