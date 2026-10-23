// Anonymous, read-only collector for public ranking data embedded by the provider.
// No DOM/layout scraping: Social Blade's page serializes its tRPC result in __NEXT_DATA__.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const COUNTRY = /^[A-Z]{2}$/;

export function extractNextData(html) {
  const match = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('SOCIALBLADE_NEXT_DATA_NOT_FOUND');
  return JSON.parse(match[1]);
}

export function parseSocialBlade(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const queries = data?.props?.pageProps?.trpcState?.json?.queries;
  if (!Array.isArray(queries)) throw new Error('SOCIALBLADE_QUERY_STATE_NOT_FOUND');
  const query = queries.find(item => JSON.stringify(item?.queryKey?.[0]) === JSON.stringify(['youtube', 'top']));
  const creators = query?.state?.data?.creators;
  if (!Array.isArray(creators)) throw new Error('SOCIALBLADE_CREATORS_NOT_FOUND');
  return creators.map((creator, index) => ({
    rank: index + 1,
    channelId: creator.id ?? null,
    name: creator.displayName ?? null,
    handle: creator.identifiers?.find(identifier => identifier.type === 'custom')?.identifier
      ?? creator.identifiers?.find(identifier => identifier.type === 'cusername')?.identifier ?? null,
    country: creator.country ?? null,
    category: creator.channelType ?? null,
    subscribers: Number.isFinite(creator.subscribers) ? creator.subscribers : null,
    views: creator.views == null ? null : Number(creator.views),
    videos: Number.isFinite(creator.videos) ? creator.videos : null,
    recentGrowth: null,
    recentVideos: null,
    url: creator.pathname ? `https://socialblade.com${creator.pathname}` : null,
  }));
}

export function parseArgs(argv) {
  return Object.fromEntries(argv.filter(arg => arg.startsWith('--')).map(arg => {
    const [key, ...value] = arg.slice(2).split('=');
    return [key, value.join('=')];
  }));
}

export async function collect({ source, country, limit = 50, fetchImpl = globalThis.fetch }) {
  if (source !== 'socialblade') throw new Error(`UNSUPPORTED_SOURCE:${source}`);
  country = String(country ?? '').toUpperCase();
  limit = Number(limit);
  if (!COUNTRY.test(country)) throw new Error('COUNTRY_MUST_BE_ISO_3166_1_ALPHA_2');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('LIMIT_MUST_BE_1_TO_100');
  const url = `https://socialblade.com/youtube/lists/top/${limit}/subscribers/all/${country}`;
  const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8' } });
  if (!response.ok) throw new Error(`SOCIALBLADE_HTTP_${response.status}`);
  const rows = parseSocialBlade(extractNextData(await response.text()));
  return { source, country, requestedLimit: limit, collectedAt: new Date().toISOString(), url, rows: rows.slice(0, limit) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !args.country || !args.out) throw new Error('USAGE: node rank-collect.mjs --source=socialblade --country=KR --limit=50 --out=<file>');
  const result = args.fixture
    ? { source: args.source, country: args.country.toUpperCase(), requestedLimit: Number(args.limit ?? 50), collectedAt: null,
        url: null, rows: parseSocialBlade(await readFile(args.fixture, 'utf8')).slice(0, Number(args.limit ?? 50)) }
    : await collect({ source: args.source, country: args.country, limit: args.limit ?? 50 });
  await writeFile(args.out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${result.rows.length} rows -> ${args.out}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
