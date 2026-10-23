// SNS writing rules from the ontology (owner 2026-09-28: "X랑 스레드, 인스타 글 작성 어떻게할지 온톨로지 작업부터해 몇자
// 제한있는지, 어떻게 구성할지 무슨톤으로 할지 대댓글로 추가작성 어떻게 가져갈지"). The ontology file holds the limits
// (hard ones checked in each platform's web code), the chain structures per genre, the tone and the reply policy; this
// module turns them into the numbers and checks versions.mjs uses, packs overflow into self-replies instead of cutting,
// and fills the follow-up reply templates.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ONTOLOGY_FILE = path.resolve(HERE, '../../../naver-blog-api/research/content-store/sns-writing-ontology.v1.json');
export const loadOntology = (file = ONTOLOGY_FILE) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Structural checks: every limit says how it was verified, every structure uses known roles, chains are sane.
export function validateOntology(o) {
  const errors = [];
  const evidence = new Set((o.evidence || []).map(e => e.id));
  const roles = new Set(Object.keys(o.postRoles || {}));
  for (const [platform, p] of Object.entries(o.platforms || {})) {
    for (const [surface, s] of Object.entries(p.surfaces || {})) {
      for (const [name, l] of Object.entries(s.limits || {})) {
        if (l.value == null) errors.push(`LIMIT_VALUE_MISSING:${platform}.${surface}.${name}`);
        if (!['hard', 'policy'].includes(l.kind)) errors.push(`LIMIT_KIND_INVALID:${platform}.${surface}.${name}`);
        if (l.verification !== 'reported' && !evidence.has(l.verification)) errors.push(`LIMIT_EVIDENCE_UNKNOWN:${platform}.${surface}.${name}`);
      }
    }
    const c = p.chain;
    if (!c || !(c.minPosts >= 1 && c.maxPosts >= c.minPosts)) errors.push(`CHAIN_INVALID:${platform}`);
  }
  for (const [genre, s] of Object.entries(o.structures || {})) {
    for (const platform of ['x', 'threads']) {
      const seq = s[platform] || [];
      if (!seq.length) errors.push(`STRUCTURE_MISSING:${genre}.${platform}`);
      seq.filter(r => !roles.has(r)).forEach(r => errors.push(`ROLE_UNKNOWN:${genre}.${platform}.${r}`));
      if (seq[0] !== 'hook') errors.push(`STRUCTURE_HOOK_FIRST:${genre}.${platform}`);
      if (seq.includes('link') && seq.at(-1) !== 'link') errors.push(`STRUCTURE_LINK_LAST:${genre}.${platform}`);
      if (seq.length > o.platforms?.[platform]?.chain?.maxPosts) errors.push(`STRUCTURE_TOO_LONG:${genre}.${platform}`);
    }
  }
  for (const t of o.replyPolicy?.followUps?.triggers || []) if (!t.kind || !t.template || !(t.maxPerPost >= 1)) errors.push(`FOLLOWUP_INVALID:${t.kind}`);
  return errors;
}

// The numbers versions.mjs checks against. Hard limits come from the platforms; the hashtag cap is our policy (5) because
// Instagram's own limit was not found in its code.
export function limitsFrom(o = loadOntology()) {
  const P = o.platforms;
  return {
    xWeighted: P.x.surfaces.post.limits.weightedChars.value,
    xPosts: P.x.chain.maxPosts,
    threadsChars: P.threads.surfaces.post.limits.chars.value,
    threadsLinks: P.threads.surfaces.post.limits.links.value,
    threadsPosts: P.threads.chain.maxPosts,
    threadsHookChars: P.threads.surfaces.post.policy.hookChars[1],
    igCaption: P.instagram.surfaces.carouselCaption.limits.chars.value,
    igCaptionTarget: P.instagram.surfaces.carouselCaption.policy.chars[1],
    igHashtags: P.instagram.surfaces.carouselCaption.policy.hashtagsMax,
    igComment: P.instagram.surfaces.firstComment.limits.chars.value,
  };
}

// Overflow goes to the next self-reply instead of being cut (ontology replyPolicy.atPublish.overflow): a post that does not
// fit is split at sentence, then line, then word boundaries into consecutive posts. Fails when the chain gets too long.
export function spillPosts(posts, fits, maxPosts, code = 'SNS_CHAIN_TOO_LONG') {
  const out = [];
  for (const post of posts) {
    if (fits(post)) { out.push(post); continue; }
    const pieces = post.split(/\n+/).flatMap(line => (fits(line) ? [line] : line.split(/(?<=[.!?。])\s+/)))
      .flatMap(s => (fits(s) ? [s] : s.split(/\s+/)));
    if (pieces.some(p => !fits(p))) fail(code);
    let cur = '';
    for (const p of pieces) {
      const sep = cur && /\n/.test(post) ? '\n' : ' ';
      const next = cur ? `${cur}${sep}${p}` : p;
      if (fits(next)) cur = next; else { out.push(cur); cur = p; }
    }
    if (cur) out.push(cur);
  }
  if (out.length > maxPosts) fail(code);
  return out;
}

// Brand voice "never" list (ontology tone.brandVoice.never; owner feedback: no '못했습니다' tone, no hedging, no hype).
export const TONE_BANNED = [
  { code: 'excuse', re: /못했|못 했|하지 못|확인이 어렵/ },
  { code: 'hedge', re: /것 같아요|것 같습니다|듯해요|듯합니다/ },
  { code: 'hype', re: /역대급|무조건|미쳤다|대박/ },
  { code: 'affiliate_text', re: /제휴(?! 링크 포함)|협찬|수수료|파트너스/ },
];
// Affiliate reply (owner 2026-09-28): one reply after the chain with links of a network registered for that channel, its
// disclosure as the first line, at most links.affiliateReply.maxLinks links, all taken from the article's own affiliate
// links; the first post of the chain carries the "(제휴 링크 포함)" marker.
export function affiliateReplyErrors(platform, reply, { firstPost = '', articleLinks = [], o = loadOntology(), fits = () => true } = {}) {
  if (reply == null) return [];
  const L = o.links, errors = [];
  const text = String(reply).trim();
  const urls = text.match(/https?:\/\/\S+/g) || [];
  const nets = Object.entries(L.affiliateNetworks).filter(([, n]) => n.channels.includes(platform));
  const netOf = u => nets.find(([, n]) => new RegExp(n.link).test(u));
  if (!urls.length) errors.push('SNS_AFFILIATE_REPLY_NO_LINK');
  if (urls.length > L.affiliateReply.maxLinks) errors.push('SNS_AFFILIATE_REPLY_TOO_MANY_LINKS');
  if (urls.some(u => !netOf(u))) errors.push(`SNS_AFFILIATE_NETWORK_NOT_REGISTERED:${platform}`);
  if (urls.some(u => !articleLinks.includes(u))) errors.push('SNS_AFFILIATE_LINK_NOT_IN_ARTICLE');
  const used = [...new Set(urls.map(u => netOf(u)?.[1]).filter(Boolean))];
  if (used.some(n => !text.split('\n')[1]?.includes(n.disclosureMatch) && !text.split('\n')[0].includes(n.disclosureMatch))) errors.push('SNS_AFFILIATE_DISCLOSURE_NOT_FIRST');
  if (!String(firstPost).includes(L.affiliateReply.firstPostMarker)) errors.push('SNS_AFFILIATE_MARKER_MISSING');
  if (!fits(text)) errors.push(`SNS_AFFILIATE_REPLY_LIMIT:${platform}`);
  return errors;
}
// The disclosure sentences a channel is allowed to carry are removed before the tone check looks for affiliate wording.
const disclosureLines = (o = loadOntology()) => Object.values(o.links.affiliateNetworks).map(n => n.disclosureMatch);

export function toneErrors(texts) {
  const matches = disclosureLines();
  const all = texts.filter(Boolean).join('\n').split('\n').filter(l => !matches.some(m => l.includes(m))).join('\n');
  return TONE_BANNED.filter(t => t.re.test(all)).map(t => `SNS_TONE_${t.code.toUpperCase()}`);
}

// Hook gate (owner 2026-09-28 "훅 온톨로지 통과한거?"): the first X/Threads post is classified with the hook ontology's
// titleMatch patterns; feed channels need a pattern from channelPreferences.feed.prefer and none from avoidAsOpener.
export const HOOK_ONTOLOGY_FILE = path.resolve(HERE, '../../../naver-blog-api/research/content-store/hook-ontology.v1.json');
export function hookCheck(text, hooks = JSON.parse(readFileSync(HOOK_ONTOLOGY_FILE, 'utf8').replace(/^﻿/, ''))) {
  // Line-end patterns (community_question: "까요?$") are tested per line without trailing emoji, since a thread opener
  // usually ends with 🧵 or 👇 (2026-10-04: "…다를까요? 🧵" read as no hook at all).
  const lines = String(text ?? '').split('\n').slice(0, 2)
    .map(l => l.replace(/[\s\p{Extended_Pictographic}‍️]+$/u, ''));
  const candidates = [lines.join(' '), lines[0] ?? ''];
  const patterns = hooks.hookPatterns.filter(p => p.titleMatch && candidates.some(c => new RegExp(p.titleMatch, 'i').test(c))).map(p => p.id);
  const feed = hooks.channelPreferences.feed;
  const preferred = patterns.filter(p => feed.prefer.includes(p));
  const avoided = patterns.filter(p => feed.avoidAsOpener.includes(p));
  return { patterns, preferred, avoided, ok: preferred.length > 0 && avoided.length === 0 };
}

// Follow-up self-reply after publication (price change, sold out, deadline) from the ontology template. Only facts the
// caller verified go in; the ontology caps how many of each kind one post may get.
export function followUpText(kind, vars, { o = loadOntology(), sent = [] } = {}) {
  const f = o.replyPolicy.followUps;
  const t = f.triggers.find(x => x.kind === kind);
  if (!t) fail('SNS_FOLLOWUP_KIND_UNKNOWN');
  if (sent.length >= f.maxTotalPerPost || sent.filter(k => k === kind).length >= t.maxPerPost) fail('SNS_FOLLOWUP_LIMIT');
  const text = t.template.replace(/\{(\w+)\}/g, (_, k) => { if (vars[k] == null || vars[k] === '') fail(`SNS_FOLLOWUP_VAR_MISSING:${k}`); return String(vars[k]); });
  return text;
}
