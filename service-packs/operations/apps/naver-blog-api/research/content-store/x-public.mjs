import { fetchXXhr } from './x-xhr.mjs';

// Compatibility export for older configs. The collector now uses the observed
// GraphQL JSON path and never parses profile HTML or oEmbed markup.
export async function fetchXPublic(handle, limit, options = {}) {
  return fetchXXhr(handle, limit, options);
}
