import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { ScopedSession } from '../scoped-session.mjs';

const ORIGIN = 'https://www.amazon.com';
const FIRST = '/nav/ajax/hMenuDesktopFirstLayer';
const SECOND = '/nav/ajax/hamburgerMainContent';
const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, ...(receipt ? { receipt } : {}) }); };
const clean = value => value?.replace(/\s+/g, ' ').trim() ?? '';
const sha = value => createHash('sha256').update(value).digest('hex');
const ID = /^\d{1,5}$/;

// Parse the JSON argument of the observed declaration, without executing scripts.
export function amazonSecondLayerInput(html) {
  const document = parseHTML(html).document;
  for (const script of document.querySelectorAll('script')) {
    const source = script.textContent;
    const marker = /(?:window\.\$Nav\s*&&\s*)?\$Nav\.declare\(['"]HMenuSecondLayerVariables['"]\s*,\s*/.exec(source);
    if (!marker) continue;
    const start = marker.index + marker[0].length;
    if (source[start] !== '{') fail('AMAZON_MENU_INPUT_INVALID');
    let depth = 0; let quoted = false; let escape = false;
    for (let at = start; at < Math.min(source.length, start + 100_000); at++) {
      const char = source[at];
      if (quoted) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        let value;
        try { value = JSON.parse(source.slice(start, at + 1)); } catch { fail('AMAZON_MENU_INPUT_INVALID'); }
        const names = value.secondLayerTreeName;
        if (!Array.isArray(names) || names.length < 1 || names.length > 100
          || names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(name))
          || new Set(names).size !== names.length || !['0', '1'].includes(value.isPrime)
          || !['0', '1'].includes(value.isSmile)) fail('AMAZON_MENU_INPUT_INVALID');
        // Other declaration fields can contain credentials; never return them.
        return { names, isPrime: value.isPrime, isSmile: value.isSmile };
      }
    }
    fail('AMAZON_MENU_INPUT_INVALID');
  }
  fail('AMAZON_MENU_INPUT_MISSING');
}

export function amazonNavigationDestination(href) {
  let url;
  try { url = new URL(href, ORIGIN); } catch { return null; }
  if (!href || href.startsWith('#') || url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.origin !== ORIGIN) return { origin: url.origin, path: url.pathname, kind: 'external', fetchAllowed: false };
  const path = url.pathname.replace(/\/ref=[^/]*(?:\/.*)?$/, '').replace(/\/$/, '') || '/';
  const unlocalized = path.replace(/^\/-\/[a-z]{2}(?:-[A-Z]{2})?(?=\/)/, '');
  const params = new URLSearchParams();
  for (const key of ['node', 'rh', 'bbn', 'i', 'k']) {
    const value = url.searchParams.get(key);
    if (value !== null && value.length <= 500 && !/[\r\n\0]/.test(value)) params.set(key, value);
  }
  const isListing = ['/s', '/b', '/gp/browse.html'].includes(unlocalized);
  const asin = /^\/dp\/([A-Z0-9]{10})$/.exec(unlocalized)?.[1];
  const kind = isListing ? 'listing' : asin ? 'product' : 'other';
  return { url: ORIGIN + path + (params.size ? `?${params}` : ''), kind,
    nodeId: params.get('node'), asin: asin ?? null, fetchAllowed: isListing || Boolean(asin) };
}

export function parseAmazonNavigation(firstHtml, secondHtml) {
  if ([firstHtml, secondHtml].some(value => typeof value !== 'string' || Buffer.byteLength(value) > 2 * 1024 * 1024)) fail('AMAZON_MENU_RESPONSE_INVALID');
  const docs = [parseHTML(firstHtml).document, parseHTML(secondHtml).document];
  const menus = new Map(); const destinations = new Map(); const edges = []; const seenEdges = new Set();
  for (const doc of docs) for (const container of doc.querySelectorAll('div.hmenu[data-menu-id], ul.hmenu[data-menu-id]')) {
    const menuId = container.getAttribute('data-menu-id');
    if (!ID.test(menuId)) fail('AMAZON_MENU_LAYOUT_CHANGED');
    const parentMenuId = container.getAttribute('data-parent-menu-id');
    if (parentMenuId !== null && !ID.test(parentMenuId)) fail('AMAZON_MENU_LAYOUT_CHANGED');
    const heading = clean(container.querySelector('.hmenu-title')?.textContent);
    const node = { id: `menu:${menuId}`, menuId, parentMenuId, title: heading || (menuId === '1' ? 'Home navigation' : null) };
    if (menus.has(node.id)) fail('AMAZON_MENU_LAYOUT_CHANGED');
    menus.set(node.id, node);
    for (const link of container.querySelectorAll('a.hmenu-item')) {
      if (link.closest('.hmenu[data-menu-id]') !== container || link.classList.contains('hmenu-back-button')) continue;
      const label = clean(link.textContent);
      if (!label || label.length > 500) continue;
      const childId = link.getAttribute('data-menu-id');
      let to; let type;
      if (childId && ID.test(childId)) { to = `menu:${childId}`; type = 'menu_to_submenu'; }
      else {
        const destination = amazonNavigationDestination(link.getAttribute('href'));
        if (!destination) continue;
        to = `destination:${sha(JSON.stringify(destination)).slice(0, 20)}`;
        destinations.set(to, { id: to, ...destination });
        type = `menu_to_${destination.kind}`;
      }
      const key = `${node.id}\0${to}\0${label}`;
      if (!seenEdges.has(key)) { seenEdges.add(key); edges.push({ from: node.id, to, label, type }); }
    }
  }
  if (!menus.has('menu:1') || menus.size < 2 || edges.length < 2) fail('AMAZON_MENU_LAYOUT_CHANGED');
  const missingMenuIds = [...new Set(edges.filter(e => e.type === 'menu_to_submenu' && !menus.has(e.to)).map(e => e.to))];
  const rootBranches = edges.filter(e => e.from === 'menu:1');
  if (!rootBranches.length) fail('AMAZON_MENU_LAYOUT_CHANGED');
  return { root: `${ORIGIN}/`, rootMenuId: 'menu:1', rootDiscoveryComplete: true,
    menus: [...menus.values()], destinations: [...destinations.values()], edges,
    rootBranchCount: rootBranches.length, unresolvedMenuIds: missingMenuIds,
    returnedMenuReferencesResolved: missingMenuIds.length === 0,
    completeCatalog: false, listingTraversalComplete: false,
    context: { session: 'anonymous_cookie_free', browserLocaleMatched: false,
      note: 'The server may return a default menu different from the browser delivery/locale context.' } };
}

export function createAmazonNavigationClient({ fetchImpl } = {}) {
  const session = new ScopedSession({ allowedOrigins: [ORIGIN], cookieOrigins: [],
    ...(fetchImpl ? { fetchImpl } : {}), defaultHeaders: { accept: 'application/json' },
    maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 20000, maxRedirects: 0 });
  async function read(path, params) {
    const url = new URL(path, ORIGIN); url.search = new URLSearchParams(params).toString();
    const receipt = { checkedAt: new Date().toISOString(), method: 'GET', origin: ORIGIN, path,
      queryFields: [...url.searchParams.keys()], browserUsed: false, cookieSent: false, credentialsUsed: false, readOnly: true };
    let response;
    try { response = await session.request(url.href); } catch (error) { fail(error?.code ?? 'AMAZON_MENU_TRANSPORT_FAILED', receipt); }
    Object.assign(receipt, { httpStatus: response.status, mime: response.headers['content-type']?.split(';')[0] ?? '',
      responseBytes: Buffer.byteLength(response.raw), responseSha256: sha(response.raw) });
    if (response.status !== 200 || receipt.mime !== 'application/json') fail('AMAZON_MENU_HTTP_FAILED', receipt);
    let body; try { body = JSON.parse(response.raw); } catch { fail('AMAZON_MENU_RESPONSE_INVALID', receipt); }
    if (typeof body?.data !== 'string' || body.data.length < 20) fail('AMAZON_MENU_RESPONSE_INVALID', receipt);
    return { html: body.data, receipt };
  }
  return { async getNavigation() {
    const common = { pageType: 'exports-gateway-desktop', hmDataAjaxHint: '1', navDeviceType: 'desktop',
      isBackup: 'false', languageCode: 'ko_KR', customerCountryCode: 'KR' };
    const first = await read(FIRST, { ajaxTemplate: 'hMenuDesktopFirstLayer', ...common,
      isFreshRegion: 'false', isFreshCustomer: 'false', isPrimeMember: 'false', isPrimeDay: 'false' });
    const input = amazonSecondLayerInput(first.html);
    const second = await read(SECOND, { ajaxTemplate: 'hamburgerMainContent', ...common,
      isSmile: input.isSmile, isPrime: input.isPrime, secondLayerTreeName: input.names.join('+') });
    return { ...parseAmazonNavigation(first.html, second.html), transport: 'anonymous_xhr_http',
      receipts: [first.receipt, second.receipt] };
  } };
}
