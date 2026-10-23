// Anonymous, read-only YouTube channel activity collector.
// Reuses the repository's parsers and only calls public page/API surfaces.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFeed } from '../../youtuber-watch.mjs';
import { parseSearch, parseAgeDays, parseViews } from '../../youtube-hook-scout.mjs';
import { parseWatch } from '../../shopping-shorts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const YT = 'https://www.youtube.com';
const DEFAULT_CAPTURE_ROOT = path.join(process.env.LOCALAPPDATA ?? 'C:/Users/User/AppData/Local', 'Temp', 'creator-xhr-captures', 'creator-youtube-firstparty');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = x => typeof x === 'string' || typeof x === 'number' ? String(x)
  : x?.simpleText ?? x?.content ?? (x?.runs ?? []).map(r => r.text ?? '').join('') ?? '';
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function walk(root, visit, trail = '$') {
  if (!root || typeof root !== 'object') return;
  visit(root, trail);
  for (const [key, value] of Object.entries(root)) {
    if (Array.isArray(value)) value.forEach((child, i) => walk(child, visit, `${trail}.${key}[${i}]`));
    else if (value && typeof value === 'object') walk(value, visit, `${trail}.${key}`);
  }
}

export function parseInitialData(html) {
  const raw = String(html).match(/(?:var|let) ytInitialData\s*=\s*(\{[\s\S]*?\});(?:var |let |<\/script>)/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function parseBrowseTabs(data) {
  const tabs = [];
  walk(data, node => {
    const t = node.tabRenderer ?? node.tabViewModel;
    if (!t) return;
    const endpoint = t.endpoint ?? t.navigationEndpoint ?? t.content?.endpoint;
    const browse = endpoint?.browseEndpoint ?? endpoint?.commandMetadata?.webCommandMetadata;
    const title = compact(textOf(t.title) || t.title);
    if (!title) return;
    tabs.push({ title, browseId: browse?.browseId ?? null, params: browse?.params ?? null, selected: Boolean(t.selected) });
  });
  return [...new Map(tabs.map(t => [`${t.title}|${t.browseId}|${t.params}`, t])).values()];
}

export function parseChannelIdentity(data) {
  const found = { browseId: null, title: null, subscriberText: null, videoCountText: null, viewCountText: null,
    joinedDateText: null, country: null, links: [], description: null, paths: {} };
  walk(data, (node, trail) => {
    const c4 = node.c4TabbedHeaderRenderer;
    if (c4) {
      found.title ??= textOf(c4.title);
      found.subscriberText ??= textOf(c4.subscriberCountText) || c4.subscriberCountText?.accessibility?.accessibilityData?.label || null;
      found.videoCountText ??= textOf(c4.videosCountText) || textOf(c4.videoCountText) || null;
      found.paths.header = trail;
    }
    const pageHeader = node.pageHeaderViewModel;
    if (pageHeader) {
      found.title ??= textOf(pageHeader.title?.dynamicTextViewModel?.text) || textOf(pageHeader.title) || null;
      // 2025+ header (observed 2026-10-03, hl=ko): metadataRows parts "@handle", "구독자 373만명", "동영상 2.3천개".
      for (const row of pageHeader.metadata?.contentMetadataViewModel?.metadataRows ?? []) for (const part of row.metadataParts ?? []) {
        const t = compact(textOf(part.text));
        if (/^@/.test(t)) found.handle ??= t;
        else if (/구독자|subscribers?/i.test(t)) found.subscriberText ??= t;
        else if (/동영상|videos?/i.test(t)) found.videoCountText ??= t;
      }
      found.paths.pageHeader = trail;
    }
    const meta = node.channelMetadataRenderer;
    if (meta) {
      found.browseId ??= meta.externalId ?? null;
      found.title ??= meta.title ?? null;
      found.description ??= meta.description ?? null;
      found.paths.channelMetadata = trail;
    }
    const about = node.aboutChannelRenderer ?? node.aboutChannelViewModel;
    if (about) {
      found.viewCountText ??= textOf(about.viewCountText) || textOf(about.viewCount) || null;
      found.joinedDateText ??= textOf(about.joinedDateText) || null;
      found.country ??= textOf(about.country) || textOf(about.countryName) || null;
      found.description ??= textOf(about.description) || null;
      const rawLinks = about.primaryLinks ?? about.links ?? [];
      for (const link of rawLinks) {
        const r = link.channelExternalLinkViewModel ?? link;
        const label = compact(textOf(r.title) || textOf(r.link) || String(r.title ?? ''));
        const url = r.link?.commandRuns?.[0]?.onTap?.innertubeCommand?.urlEndpoint?.url ?? r.navigationEndpoint?.urlEndpoint?.url ?? r.url ?? null;
        if (label || url) found.links.push({ label: label || null, url });
      }
      found.paths.about = trail;
    }
    const text = textOf(node.viewCountText) || textOf(node.videoCountText) || textOf(node.subscriberCountText) || '';
    if (/views?/i.test(text)) { found.viewCountText ??= text; found.paths.viewCount ??= trail; }
    if (/videos?/i.test(text)) { found.videoCountText ??= text; found.paths.videoCount ??= trail; }
    if (/subscribers?/i.test(text)) { found.subscriberText ??= text; found.paths.subscribers ??= trail; }
  });
  found.links = [...new Map(found.links.map(l => [`${l.label}|${l.url}`, l])).values()];
  return found;
}

export function parseTabVideos(data, tabName = 'Videos', now = Date.now()) {
  const out = [], seen = new Set();
  const add = v => {
    if (!v?.id || seen.has(v.id)) return;
    seen.add(v.id);
    const ageText = v.ageText ?? null;
    const viewsText = v.viewsText ?? null;
    out.push({ videoId: v.id, title: compact(v.title), publishedAge: ageText, ageDays: parseAgeDays(ageText),
      viewsText, views: parseViews(viewsText), duration: v.duration ?? null,
      type: v.isLive ? 'live' : v.isPremiere ? 'premiere' : tabName === 'Shorts' || v.isShort ? 'short' : 'video',
      liveNow: Boolean(v.isLiveNow), url: `https://www.youtube.com/watch?v=${v.id}` });
  };
  walk(data, node => {
    const vr = node.videoRenderer ?? node.gridVideoRenderer ?? node.reelItemRenderer;
    if (vr) {
      const id = vr.videoId ?? vr.navigationEndpoint?.reelWatchEndpoint?.videoId;
      const title = textOf(vr.title) || textOf(vr.headline) || vr.accessibility?.accessibilityData?.label;
      const badges = [...(vr.badges ?? []), ...(vr.thumbnailOverlays ?? [])].map(x => JSON.stringify(x)).join(' ');
      const live = /LIVE|LIVE_NOW|liveBadge/i.test(badges) || Boolean(vr.upcomingEventData);
      const premiere = /PREMIERE|premiere/i.test(badges);
      add({ id, title, ageText: textOf(vr.publishedTimeText) || null,
        viewsText: textOf(vr.viewCountText) || textOf(vr.shortViewCountText) || null,
        duration: textOf(vr.lengthText) || null, isShort: Boolean(vr.isShort), isLive: live, isLiveNow: /LIVE_NOW|liveBadge/i.test(badges), isPremiere: premiere });
    }
    // 2025+ grid card (observed 2026-10-03 in the Videos/Live tabs): lockupViewModel with metadata parts
    // "조회수 75만회" / "18시간 전" and the duration as a thumbnail badge ("26:06", or a live badge).
    const card = node.lockupViewModel;
    if (card && /VIDEO/.test(card.contentType ?? '')) {
      const meta = card.metadata?.lockupMetadataViewModel;
      const parts = (meta?.metadata?.contentMetadataViewModel?.metadataRows ?? [])
        .flatMap(row => row.metadataParts ?? []).map(part => compact(textOf(part.text))).filter(Boolean);
      const badges = [];
      walk(card.contentImage, n => { if (n.thumbnailBadgeViewModel) badges.push(compact(n.thumbnailBadgeViewModel.text)); });
      const duration = badges.find(b => /^\d{1,2}(?::\d{2}){1,2}$/.test(b)) ?? null;
      const liveBadge = badges.some(b => /실시간|LIVE/i.test(b));
      add({ id: card.contentId, title: textOf(meta?.title),
        viewsText: parts.find(p => /조회수|views?|시청/i.test(p)) ?? null,
        ageText: parts.find(p => /전$|ago$/i.test(p)) ?? null,
        duration, isLive: liveBadge || tabName === 'Live', isLiveNow: liveBadge,
        isPremiere: badges.some(b => /최초 공개|premiere/i.test(b)) });
    }
    const lockup = node.shortsLockupViewModel;
    if (lockup) add({ id: lockup.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId,
      title: lockup.overlayMetadata?.primaryText?.content,
      viewsText: lockup.overlayMetadata?.secondaryText?.content ?? null, isShort: true });
    const live = node.liveStreamOfflineSlateRenderer ?? node.upcomingEventRenderer;
    if (live?.videoId) add({ id: live.videoId, title: textOf(live.title), isLive: true, isLiveNow: Boolean(node.liveStreamOfflineSlateRenderer) });
  });
  return out;
}

export function parseVideoSignals(html) {
  const p = parseWatch(html);
  const initial = parseInitialData(html);
  const collabs = [], chapters = [];
  let merchShelfPresent = p.products.length > 0 ? true : null;
  let ownLanguage = null, liveStatus = null, premiere = false;
  if (initial) walk(initial, (node, trail) => {
    if (node.productListRenderer || node.merchandiseShelfRenderer || node.shoppingProductRenderer || node.productListItemRenderer) merchShelfPresent = true;
    const ch = node.collaboratorChannelRenderer ?? node.collaborationChannelRenderer ?? node.collabChannelRenderer;
    if (ch) collabs.push({ channelId: ch.channelId ?? ch.externalId ?? null, name: compact(textOf(ch.title) || textOf(ch.channelName) || '') || null });
    const chapter = node.macroMarkersListItemRenderer ?? node.chapterRenderer ?? node.expandableMetadataChapterRenderer;
    if (chapter) chapters.push({ title: compact(textOf(chapter.title) || textOf(chapter.timeDescription) || ''), path: trail });
    if (node.upcomingEventData) premiere = true;
  });
  const player = String(html).match(/(?:var|let) ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});(?:var |let |<\/script>)/)?.[1];
  let playerJson = null;
  try { playerJson = player ? JSON.parse(player) : null; } catch { /* the shared parser already checks the payload */ }
  const pd = playerJson?.videoDetails ?? {};
  const mf = playerJson?.microformat?.playerMicroformatRenderer ?? {};
  ownLanguage = pd.defaultAudioLanguage ?? mf.defaultLanguage ?? pd.defaultLanguage ?? null;
  liveStatus = pd.isLiveContent ? (pd.isUpcoming ? 'upcoming' : 'live_or_recorded') : 'not_marked_live';
  premiere ||= Boolean(mf.liveBroadcastDetails?.isUpcomingEvent || mf.liveBroadcastDetails?.isLiveNow);
  return { videoId: p.videoId, title: p.title, channelId: p.channelId, channel: p.channel,
    paidPromotion: p.paidPromotion, merchShelfPresent, productCount: p.products.length,
    collaborators: [...new Map(collabs.map(c => [`${c.channelId}|${c.name}`, c])).values()],
    chapters: [...new Map(chapters.map(c => [c.title, c])).values()], ownLanguage,
    keywords: p.keywords, liveStatus, premiere,
    evidencePaths: { paidPromotion: '$.ytInitialPlayerResponse.paidContentOverlay', keywords: '$.ytInitialPlayerResponse.videoDetails.keywords',
      defaultLanguage: '$.ytInitialPlayerResponse.videoDetails.defaultAudioLanguage', products: '$.ytInitialData product shelf renderers (or shared parseWatch productListItemRenderer)', chapters: 'ytInitialData chapter/macro marker renderers', collaborators: 'ytInitialData collab channel renderer (field name not yet observed)' } };
}

export function summarizeChannel({ channel, rss = [], tabs = {}, videoSignals = [], days = 30, now = Date.now() }) {
  const cutoff = now - days * 864e5;
  const recentRss = rss.filter(v => !v.publishedAt || Date.parse(v.publishedAt) >= cutoff);
  const merged = new Map();
  for (const v of recentRss) merged.set(v.videoId, { videoId: v.videoId, title: v.title, publishedAt: v.publishedAt, type: v.isShort ? 'short' : 'unknown' });
  for (const [tabName, result] of Object.entries(tabs)) for (const v of result.videos ?? []) {
    const existing = merged.get(v.videoId) ?? {};
    merged.set(v.videoId, { ...existing, ...v, type: v.type === 'video' && tabName === 'Videos' ? 'video' : v.type,
      tab: tabName });
  }
  // Tab cards carry a relative age ("3일 전"), not a date; Shorts cards carry neither, so undated items stay out of the window.
  for (const v of merged.values()) if (!v.publishedAt && Number.isFinite(v.ageDays)) v.publishedAt = new Date(now - v.ageDays * 864e5).toISOString();
  const undated = [...merged.values()].filter(v => !v.publishedAt);
  const uploads = [...merged.values()].filter(v => v.publishedAt && Date.parse(v.publishedAt) >= cutoff);
  const typed = { videos: uploads.filter(v => v.type === 'video').length, shorts: uploads.filter(v => v.type === 'short').length,
    live: uploads.filter(v => v.type === 'live').length, premiere: uploads.filter(v => v.type === 'premiere').length,
    unknown: uploads.filter(v => !['video', 'short', 'live', 'premiere'].includes(v.type)).length };
  const dates = uploads.map(v => Date.parse(v.publishedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const intervalsDays = dates.slice(1).map((date, i) => (date - dates[i]) / 864e5);
  const meanIntervalDays = intervalsDays.length ? Math.round(intervalsDays.reduce((a, b) => a + b, 0) / intervalsDays.length * 100) / 100 : null;
  const signals = videoSignals.filter(Boolean);
  const share = (predicate, denominator = signals.length) => denominator ? Math.round(signals.filter(predicate).length / denominator * 1000) / 1000 : null;
  const ranked = uploads.filter(v => Number.isFinite(v.views)).sort((a, b) => b.views - a.views).slice(0, 5);
  return { channel, windowDays: days, uploadCount: uploads.length, uploadsByType: typed,
    undatedByType: { shorts: undated.filter(v => v.type === 'short').length, other: undated.filter(v => v.type !== 'short').length },
    shareShortsAmongClassified: typed.videos + typed.shorts + typed.live + typed.premiere ? Math.round(typed.shorts / (typed.videos + typed.shorts + typed.live + typed.premiere) * 1000) / 1000 : null,
    cadence: { datedUploads: dates.length, meanIntervalDays },
    signalSample: { n: signals.length, paidPromoShare: share(v => v.paidPromotion), collabShare: share(v => v.collaborators?.length > 0), merchShare: share(v => v.merchShelfPresent === true) },
    topVideosByViews: ranked.map(v => ({ videoId: v.videoId, title: v.title, views: v.views, viewsText: v.viewsText ?? null, type: v.type })) };
}

function parseArgs(argv) {
  const get = name => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return { get, has: name => argv.includes(`--${name}`) };
}

function challengeMarker(text, finalUrl = '') {
  let host = '';
  try { host = new URL(finalUrl).hostname; } catch { /* preserve the content-only check */ }
  if (/^(?:consent\.youtube\.com|consent\.google\.com)$/i.test(host)
    || /before you continue to YouTube/i.test(text) && /consent/i.test(text)) return 'consent_wall';
  if (/(?:^|\.)google\.com$/i.test(host) && /^\/sorry\//.test(new URL(finalUrl).pathname)) return 'challenge_blocked';
  // Normal YouTube pages and JSON carry words like "captcha" in their client config, so a page with YouTube's own data
  // is only blocked when it says so in the player status ("Sign in to confirm you're not a bot").
  const youtubeData = /ytInitialData|ytInitialPlayerResponse|ytcfg\.set|"responseContext"/.test(text);
  if (youtubeData) return /confirm you(?:'|’|\\u0027)re not a bot/i.test(text) ? 'challenge_blocked' : null;
  if (/verify you are human|unusual traffic from your computer|automated requests|cf-chl-|_abck|datadome|g-recaptcha/i.test(text)) return 'challenge_blocked';
  return null;
}

export function createCollector({ fetchImpl = globalThis.fetch, captureDir = DEFAULT_CAPTURE_ROOT, delayMs = 2100, maxRequests = 40, now = Date.now() } = {}) {
  const lastByHost = new Map(), countsBySource = new Map(), captureSeq = new Map(), blockedHosts = new Map();
  mkdirSync(captureDir, { recursive: true });
  async function request({ url, method = 'GET', body = null, headers = {}, source = 'youtube', endpoint = 'page', capture = false, language = 'ko-KR,ko;q=0.9,en;q=0.8' }) {
    const host = new URL(url).host;
    const hostSource = /(^|\.)youtube\.com$/i.test(host) ? 'youtube.com' : host;
    if (blockedHosts.has(hostSource)) throw Object.assign(new Error(`SOURCE_ALREADY_BLOCKED:${hostSource}`), { code: 'SOURCE_ALREADY_BLOCKED', blockedRecord: blockedHosts.get(hostSource) });
    const count = (countsBySource.get(source) ?? 0) + 1;
    if (count > maxRequests) throw Object.assign(new Error(`SOURCE_REQUEST_LIMIT:${source}:${maxRequests}`), { code: 'SOURCE_REQUEST_LIMIT' });
    countsBySource.set(source, count);
    const due = (lastByHost.get(host) ?? 0) + delayMs - Date.now();
    if (due > 0) await wait(due);
    lastByHost.set(host, Date.now());
    const requestedAt = new Date().toISOString();
    const res = await fetchImpl(url, { method, redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': language, ...headers }, ...(body == null ? {} : { body: JSON.stringify(body) }) });
    const responseText = await res.text();
    const marker = challengeMarker(responseText, res.url);
    const record = { url, finalUrl: res.url, method, status: res.status, contentType: res.headers.get('content-type'), requestedAt, marker, body: null };
    if (body != null) record.body = body;
    if (res.status === 403 || res.status === 429) record.marker = 'challenge_blocked';
    if (record.marker === 'challenge_blocked') blockedHosts.set(hostSource, { host, url: record.url, finalUrl: record.finalUrl, method: record.method,
      status: record.status, contentType: record.contentType, time: record.requestedAt, marker: record.marker });
    let jsonBody = false;
    if (/json/i.test(record.contentType ?? '')) jsonBody = true;
    else { try { JSON.parse(responseText); jsonBody = true; } catch { /* HTML/XML is not a JSON API body */ } }
    if (capture && jsonBody) {
      const sourceKey = `${source}-${endpoint}`;
      const seq = (captureSeq.get(sourceKey) ?? 0) + 1;
      captureSeq.set(sourceKey, seq);
      const file = `${sourceKey}-${seq}.json`;
      writeFileSync(path.join(captureDir, file), responseText, 'utf8');
      writeFileSync(path.join(captureDir, `${sourceKey}-${seq}.meta.json`), JSON.stringify({ url, method, status: res.status,
        contentType: record.contentType, time: requestedAt, requestBody: body }, null, 2) + '\n', 'utf8');
      record.captureFile = file;
    }
    return { record, text: responseText, response: res };
  }
  async function getPage(url, { language, source = 'youtube-pages' } = {}) {
    return request({ url, language, source });
  }
  async function postJson(endpoint, body, { gl = 'KR', hl = 'ko', capture = true, source = 'youtube-api' } = {}) {
    const url = `${YT}/youtubei/v1/${endpoint}?prettyPrint=false`;
    const result = await request({ url, method: 'POST', body,
      headers: { 'content-type': 'application/json' }, capture, source, endpoint: endpoint.replaceAll('/', '-') });
    let json = null;
    try { json = JSON.parse(result.text); } catch { /* status/body marker is retained for the report */ }
    return { ...result, json };
  }
  return { request, getPage, postJson, countsBySource, blockedHosts };
}

function clientContext(clientVersion, { gl = 'KR', hl = 'ko' } = {}) {
  return { client: { clientName: 'WEB', clientVersion, hl, gl } };
}

function discoverClientVersion(html) {
  return String(html).match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1]
    ?? String(html).match(/"clientVersion"\s*:\s*"(2\.[^"]+)"/)?.[1] ?? null;
}

function findChannelId(data, preferred = '') {
  let id = null;
  walk(data, node => {
    const channel = node.channelRenderer ?? node.channelMetadataRenderer ?? node.c4TabbedHeaderRenderer;
    const found = channel?.channelId ?? channel?.externalId ?? channel?.browseId;
    if (found?.startsWith('UC') && (!id || String(textOf(channel?.title)).toLowerCase().includes(preferred.toLowerCase()))) id = found;
  });
  return id;
}

function extractContinuation(data) {
  let continuation = null, pathFound = null;
  walk(data, (node, trail) => {
    const token = node.continuationCommand?.token ?? node.nextContinuationData?.continuation ?? node.continuationEndpoint?.continuationCommand?.token;
    if (token && !continuation) { continuation = token; pathFound = trail; }
  });
  return { continuation, path: pathFound };
}

function selectTab(tabs, patterns) {
  return tabs.find(t => patterns.some(p => p.test(t.title))) ?? null;
}

async function resolveChannel(ref, collector, { gl = 'KR', hl = 'ko', clientVersion = null } = {}) {
  if (/^UC[\w-]{22}$/.test(ref)) return { channelId: ref, resolvedFrom: 'input' };
  const handle = ref.startsWith('@') ? ref : `@${ref}`;
  const lang = `${hl},${hl.split('-')[0]};q=0.9,en;q=0.8`;
  const r = await collector.getPage(`${YT}/${handle}?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`, { language: lang });
  const initial = parseInitialData(r.text);
  const id = findChannelId(initial) ?? /"externalId":"(UC[\w-]{22})"/.exec(r.text)?.[1] ?? null;
  return { channelId: id, resolvedFrom: handle, displayName: parseChannelIdentity(initial).title, pageStatus: r.record.status,
    clientVersion: clientVersion ?? discoverClientVersion(r.text),
    bundleCandidates: [...new Set([...r.text.matchAll(/<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)].map(m => new URL(m[1], r.record.finalUrl).href))],
    marker: r.record.marker };
}

async function browse(collector, body, opts) {
  const r = await collector.postJson('browse', body, opts);
  if (r.record.marker) return { record: r.record, data: null };
  return { record: r.record, data: r.json };
}

function parseChartHtml(html) {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const markers = [...new Set([...String(html).matchAll(/Trending Videos|Top Videos|Charts|consent|chartKey|chartId/gi)].map(m => m[0]))];
  return { title, markers };
}

export async function collect({ channels, days = 30, out = null, fetchImpl, captureDir, delayMs = 2100, maxRequests = 40,
  tabsMode = 'all', includeResearch = false, now = Date.now(), logger = () => {} } = {}) {
  if (!Array.isArray(channels) || !channels.length) throw new Error('USAGE: --channels=UC…,@handle --days=30 --out=<file>');
  const collector = createCollector({ fetchImpl, captureDir, delayMs, maxRequests, now });
  const channelRows = [];
  let stopReason = null;
  let clientVersion = null;
  const resolved = [];
  for (const ref of channels) {
    const r = await resolveChannel(ref, collector, { clientVersion });
    clientVersion ??= r.clientVersion;
    if (r.marker === 'challenge_blocked') {
      channelRows.push({ input: ref, error: 'challenge_blocked', resolution: r });
      stopReason = { host: 'www.youtube.com', marker: r.marker, status: r.pageStatus, url: r.resolvedFrom ? `${YT}/${r.resolvedFrom}?hl=ko&gl=KR` : null };
      break;
    }
    if (!r.channelId) { channelRows.push({ input: ref, error: 'CHANNEL_ID_NOT_FOUND', resolution: r }); continue; }
    resolved.push({ input: ref, ...r });
  }
  if (!stopReason && !clientVersion && resolved.length) {
    // One anonymous channel GET supplies the current public WEB client version. No API key is read or sent.
    const pg = await collector.getPage(`${YT}/channel/${resolved[0].channelId}?hl=ko&gl=KR`);
    if (pg.record.marker === 'challenge_blocked') stopReason = { host: 'www.youtube.com', marker: pg.record.marker, status: pg.record.status, url: pg.record.url };
    else clientVersion = discoverClientVersion(pg.text) ?? '2.20260101.00.00';
  }
  const ctx = clientContext(clientVersion ?? '2.20260101.00.00');
  let representativeTabData = null;
  for (const [idx, ch] of resolved.entries()) {
    if (stopReason) break;
    const root = await browse(collector, { context: ctx, browseId: ch.channelId }, { source: 'youtube-api' });
    if (!root.data) {
      channelRows.push({ input: ch.input, channelId: ch.channelId, status: root.record.status, marker: root.record.marker });
      if (root.record.marker === 'challenge_blocked') { stopReason = { host: 'www.youtube.com', marker: root.record.marker, status: root.record.status, url: root.record.url }; break; }
      continue;
    }
    const identity = parseChannelIdentity(root.data);
    identity.browseId ??= ch.channelId;
    const rootTabs = parseBrowseTabs(root.data);
    const profile = { channelId: ch.channelId, input: ch.input, title: identity.title, subscriberText: identity.subscriberText,
      videoCountText: identity.videoCountText, totalViewsText: identity.viewCountText, joinedDateText: identity.joinedDateText,
      country: identity.country, links: identity.links, identityPaths: identity.paths, browseStatus: root.record.status,
      aboutStatus: null, tabs: {}, rssStatus: null };
    const aboutTab = selectTab(rootTabs, [/^about$/i, /about/i, /정보/]);
    if (aboutTab?.params) {
      const about = await browse(collector, { context: ctx, browseId: ch.channelId, params: aboutTab.params }, { source: 'youtube-api' });
      profile.aboutStatus = about.record.status;
      if (about.data) {
        const aboutIdentity = parseChannelIdentity(about.data);
        profile.totalViewsText ??= aboutIdentity.viewCountText;
        profile.joinedDateText ??= aboutIdentity.joinedDateText;
        profile.country ??= aboutIdentity.country;
        profile.links = profile.links.length ? profile.links : aboutIdentity.links;
        profile.aboutPaths = aboutIdentity.paths;
        const more = extractContinuation(about.data);
        profile.aboutMoreContinuation = { found: Boolean(more.continuation), path: more.path };
        if (more.continuation && idx === 0) {
          const moreResult = await browse(collector, { context: ctx, continuation: more.continuation }, { source: 'youtube-api' });
          profile.aboutMoreContinuation.status = moreResult.record.status;
          if (moreResult.data) profile.aboutMoreContinuation.fields = parseChannelIdentity(moreResult.data);
          if (moreResult.record.marker === 'challenge_blocked') stopReason = { host: 'www.youtube.com', marker: moreResult.record.marker, status: moreResult.record.status, url: moreResult.record.url };
        }
      }
      if (about.record.marker === 'challenge_blocked' || stopReason) {
        channelRows.push({ ...profile, error: 'challenge_blocked' });
        stopReason ??= { host: 'www.youtube.com', marker: about.record.marker, status: about.record.status, url: about.record.url };
        break;
      }
    } else profile.aboutStatus = 'about_tab_params_not_found';
    const rss = await collector.getPage(`${YT}/feeds/videos.xml?channel_id=${encodeURIComponent(ch.channelId)}`, { source: 'youtube-rss', language: 'ko-KR,ko;q=0.9,en;q=0.8' });
    profile.rssStatus = rss.record.status;
    if (rss.record.marker === 'challenge_blocked') {
      channelRows.push({ ...profile, error: 'challenge_blocked' });
      stopReason = { host: 'www.youtube.com', marker: rss.record.marker, status: rss.record.status, url: rss.record.url };
      break;
    }
    const feed = rss.response.ok ? parseFeed(rss.text).map(v => ({ ...v, title: v.title ?? '', publishedAt: v.publishedAt ?? null })) : [];
    const tabs = {};
    const doTabs = tabsMode === 'all' || idx === 0;
    if (doTabs) {
      const choices = [ ['Videos', [/^videos?$/i, /동영상/]], ['Shorts', [/^shorts$/i, /쇼츠/]], ['Live', [/^live$/i, /livestreams?/i, /실시간/]] ];
      for (const [name, patterns] of choices) {
        const tab = selectTab(rootTabs, patterns);
        if (!tab?.params) { tabs[name] = { status: 'tab_params_not_found', tab: tab ?? null, videos: [] }; continue; }
        const result = await browse(collector, { context: ctx, browseId: ch.channelId, params: tab.params }, { source: 'youtube-api' });
        const videos = result.data ? parseTabVideos(result.data, name, now) : [];
        tabs[name] = { status: result.record.status, path: result.record.captureFile ?? null, tab, videos };
        if (result.record.marker === 'challenge_blocked') {
          stopReason = { host: 'www.youtube.com', marker: result.record.marker, status: result.record.status, url: result.record.url };
          break;
        }
        if (idx === 0 && name === 'Videos') representativeTabData = result.data;
      }
    }
    if (stopReason) { channelRows.push({ ...profile, tabResults: tabs, error: 'challenge_blocked' }); break; }
    const rssVideos = feed.filter(v => !v.publishedAt || now - Date.parse(v.publishedAt) <= days * 864e5);
    const signalVideos = [];
    // The sample is bounded to one latest public video per channel to stay within the anonymous request budget.
    const sample = rssVideos[0];
    if (sample) {
      const watch = await collector.getPage(`${YT}/watch?v=${encodeURIComponent(sample.videoId)}&hl=ko&gl=KR`, { source: 'youtube-watch' });
      if (watch.response.ok && !watch.record.marker) {
        try { signalVideos.push(parseVideoSignals(watch.text)); } catch (e) { logger({ channel: ch.channelId, watchParseError: e.message }); }
      }
      if (watch.record.marker === 'challenge_blocked') stopReason = { host: 'www.youtube.com', marker: watch.record.marker, status: watch.record.status, url: watch.record.url };
    }
    const activity = summarizeChannel({ channel: ch.channelId, rss: rssVideos, tabs, videoSignals: signalVideos, days, now });
    channelRows.push({ ...profile, displayTitle: profile.title ?? ch.displayName ?? null,
      activity, recentRss: rssVideos.slice(0, 15).map(v => ({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt, isShortInRss: v.isShort })),
      tabResults: tabs, videoSignalSample: signalVideos });
    if (stopReason) break;
  }
  let research = null;
  if (includeResearch && !stopReason) research = await runResearchProbes(collector, { clientVersion: clientVersion ?? '2.20260101.00.00',
    bundleCandidates: resolved.flatMap(ch => ch.bundleCandidates ?? []), logger });
  if (!stopReason && collector.blockedHosts.has('youtube.com')) stopReason = collector.blockedHosts.get('youtube.com');
  const result = { schemaVersion: 1, kind: 'youtube-channel-activity', checkedAt: new Date(now).toISOString(), days,
    method: 'anonymous public YouTube HTTP; JSON browse API and existing search/RSS/watch parsers; no login, API key, cookies, comments or viewer identities',
    requestBudget: { maxRequestsPerSource: maxRequests, countsBySource: Object.fromEntries(collector.countsBySource) }, clientVersion,
    channels: channelRows, research, sourceStopped: stopReason };
  if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return result;
}

const SEARCH_CASES = [
  { country: 'KR', hl: 'ko', query: '브이로그' }, { country: 'US', hl: 'en', query: 'vlog' },
  { country: 'JP', hl: 'ja', query: 'vlog' }, { country: 'IN', hl: 'hi', query: 'vlog' },
  { country: 'BR', hl: 'pt-BR', query: 'vlog' }, { country: 'ID', hl: 'id', query: 'vlog' },
  { country: 'MX', hl: 'es', query: 'vlog' }, { country: 'GB', hl: 'en-GB', query: 'vlog' },
  { country: 'DE', hl: 'de', query: 'vlog' },
];

async function runResearchProbes(collector, { clientVersion, bundleCandidates = [], logger }) {
  const results = { search: [], consent: [], trends: [], robots: null, terms: null, bundleTrace: null };
  for (const test of SEARCH_CASES) {
    const language = `${test.hl},${test.hl.split('-')[0]};q=0.9,en;q=0.8`;
    const url = `${YT}/results?search_query=${encodeURIComponent(test.query)}&hl=${encodeURIComponent(test.hl)}&gl=${test.country}`;
    const r = await collector.getPage(url, { source: 'youtube-search-consent', language });
    const html = r.text;
    const consent = challengeMarker(html, r.record.finalUrl) === 'consent_wall';
    const videos = r.response.ok && !consent && !r.record.marker ? parseSearch(html) : [];
    const client = discoverClientVersion(html);
    if (client) clientVersion = client;
    const search = { country: test.country, hl: test.hl, query: test.query, status: r.record.status, finalHost: new URL(r.record.finalUrl).host,
      resultCount: videos.length, topVideoIds: videos.slice(0, 5).map(v => v.id), consentWall: consent, marker: r.record.marker,
      method: 'GET /results; ytInitialData; existing parseSearch' };
    results.search.push(search);
    results.consent.push({ country: test.country, hl: test.hl, status: r.record.status, finalHost: search.finalHost, wall: consent, marker: r.record.marker });
    if (test.country === 'KR') {
      const id = findChannelId(parseInitialData(html), '쯔양');
      if (id) results.koreanTestChannelId = id;
    }
    if (r.record.marker === 'challenge_blocked' || r.record.status === 403 || r.record.status === 429) break;
  }
  if (collector.blockedHosts.has('youtube.com')) {
    results.sourceStopped = collector.blockedHosts.get('youtube.com');
    return results;
  }
  // The official WEB browse surface is tested separately from the retired feed.
  const ctx = clientContext(clientVersion);
  const explore = await browse(collector, { context: ctx, browseId: 'FEexplore' }, { source: 'youtube-api' });
  results.trends.push({ browseId: 'FEexplore', status: explore.record.status, capture: explore.record.captureFile ?? null,
    topLevelKeys: explore.data ? Object.keys(explore.data) : [], tabs: explore.data ? parseBrowseTabs(explore.data) : [], marker: explore.record.marker });
  if (collector.blockedHosts.has('youtube.com')) {
    results.sourceStopped = collector.blockedHosts.get('youtube.com');
    return results;
  }
  const retired = await collector.getPage(`${YT}/feed/trending?gl=US&hl=en`, { source: 'youtube-trending-page', language: 'en-US,en;q=0.9' });
  results.trends.push({ source: 'legacy-trending-page', status: retired.record.status, finalUrl: retired.record.finalUrl,
    redirected: retired.record.url !== retired.record.finalUrl, marker: retired.record.marker });
  if (collector.blockedHosts.has('youtube.com')) {
    results.sourceStopped = collector.blockedHosts.get('youtube.com');
    return results;
  }
  for (const gl of ['US', 'KR']) {
    const url = `https://charts.youtube.com/charts/TrendingVideos/${gl.toLowerCase()}/weekly?hl=${gl === 'KR' ? 'ko' : 'en'}`;
    const r = await collector.getPage(url, { source: 'youtube-charts', language: gl === 'KR' ? 'ko-KR,ko;q=0.9,en;q=0.8' : 'en-US,en;q=0.9' });
    results.trends.push({ source: 'charts.youtube.com', gl, url, status: r.record.status, finalUrl: r.record.finalUrl,
      page: parseChartHtml(r.text), marker: r.record.marker });
    if (collector.blockedHosts.has('youtube.com')) break;
  }
  if (collector.blockedHosts.has('youtube.com')) {
    results.sourceStopped = collector.blockedHosts.get('youtube.com');
    return results;
  }
  const robots = await collector.getPage(`${YT}/robots.txt`, { source: 'youtube-metadata' });
  results.robots = { status: robots.record.status, excerpt: robots.text.split(/\r?\n/).filter(line => /youtubei|browse|feed|search|disallow|allow/i.test(line)).slice(0, 30) };
  if (collector.blockedHosts.has('youtube.com')) {
    results.sourceStopped = collector.blockedHosts.get('youtube.com');
    return results;
  }
  const candidate = bundleCandidates.find(url => !/\/s\/player\//i.test(url)) ?? bundleCandidates[0] ?? null;
  if (candidate) {
    const bundle = await collector.getPage(candidate, { source: 'youtube-bundle', language: 'ko-KR,ko;q=0.9,en;q=0.8' });
    const js = bundle.text;
    const routeMatches = [...new Set([...js.matchAll(/youtubei\/v1\/[A-Za-z]+/g)].map(m => m[0]))].slice(0, 30);
    const browseAt = js.indexOf('youtubei/v1/browse');
    const wrapperAt = browseAt >= 0 ? js.slice(Math.max(0, browseAt - 260), browseAt + 260) : null;
    results.bundleTrace = { url: candidate, status: bundle.record.status, contentType: bundle.record.contentType,
      routeStrings: routeMatches, browseWrapperSnippet: wrapperAt, fetchWrapperPresent: /\bfetch\s*\(/.test(js), xhrWrapperPresent: /XMLHttpRequest/.test(js),
      endpointHostObserved: new URL(candidate).host };
  } else results.bundleTrace = { available: false, reason: 'No public page bundle URL was present in the handle page.' };
  results.terms = { checkedBy: 'official YouTube Terms of Service page inspected separately', url: 'https://www.youtube.com/t/terms',
    position: 'Automated means are restricted unless YouTube gives permission; see official terms link in report.' };
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channels = (args.get('channels') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!channels.length || !args.get('out')) throw new Error('Usage: node channel-activity.mjs --channels=UC…,@handle --days=30 --out=<file>');
  const result = await collect({ channels, days: Number(args.get('days') ?? 30), out: args.get('out'), tabsMode: args.get('tabs') ?? 'all',
    includeResearch: args.has('research'), maxRequests: Number(args.get('max-requests') ?? 40),
    logger: x => console.error(JSON.stringify(x)) });
  console.log(JSON.stringify({ ok: true, checkedAt: result.checkedAt, requests: result.requestBudget.countsBySource,
    channels: result.channels.map(c => ({ title: c.displayTitle, channelId: c.channelId, uploads: c.activity?.uploadCount, byType: c.activity?.uploadsByType,
      paidPromoShare: c.activity?.signalSample.paidPromoShare, collabShare: c.activity?.signalSample.collabShare, merchShare: c.activity?.signalSample.merchShare,
      topVideoIds: c.activity?.topVideosByViews.map(v => v.videoId) })) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code ?? error.message, observedBlock: error.blockedRecord ?? null }));
  process.exitCode = 1;
});
