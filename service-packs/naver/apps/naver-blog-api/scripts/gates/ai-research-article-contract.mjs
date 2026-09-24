import {isDynamicResearch,dynamicSourceKinds,dynamicPrimaryKinds,dynamicSourceContract,dynamicSourceOwnerScope,evaluateDynamicPlan,dynamicLayoutChecks,evaluateAdaptiveReceipt} from './dynamic-article-gates.mjs';
import {isExistingAiUpdate} from './existing-article-update-scope.mjs';
import {FRONTIER_TOPIC,isFrontierUpdate,frontierReactionChecks,isFrontierComparison,frontierSourcePublicUrl,frontierSourceOwnerScope,frontierComparisonChecks,frontierLayoutChecks,frontierOriginalQuotation} from './frontier-model-comparison-contract.mjs';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {text} from './publication-document.mjs';
import {isJevApplications,applicationSourceKinds,jevApplicationSourcePublicUrl,jevApplicationSourceOwnerScope,jevApplicationChecks} from './jev-applications-contract.mjs';
import {editorialProvenanceAllowed} from './editorial-provenance.mjs';

// A separately scoped, noncommercial adapter. No commerce job can select this
// route while retaining products, an affiliate link, or promotional language.
export const AI_RESEARCH_SCOPE = Object.freeze({
  format:'ai_research_article', blogId:'aicandoanything', categoryName:'AI', categoryId:12,
  topicKey:'jev-judgment-workflow-20260921', minImages:3,
});
export const MIMO_TOPIC='mimo-v26-followup-20260922';
export const GPT6_OPUS_TOPIC='gpt6-sol-luna-vs-opus55-20260923';
// This article has a reviewed, fixed source set. Keep the public URL, source
// kind, and observed collection method bound together for this topic.
const gpt6OpusSourceContracts=Object.freeze({
  'openai-release':['https://openai.com/index/introducing-gpt-6-sol-and-luna/','official_documentation','web_public_excerpt'],
  'openai-community-chart':['https://community.openai.com/t/announcing-gpt-6-sol-and-gpt-6-luna-in-the-api-codex-and-chatgpt/1399925','community_forum','official_http'],
  'openai-pricing':['https://developers.openai.com/api/docs/pricing','official_documentation','official_http'],
  'openai-luna-model':['https://developers.openai.com/api/docs/models/gpt-6-luna','official_documentation','official_http'],
  'anthropic-release':['https://www.anthropic.com/claude-opus-5-5','official_documentation','official_http'],
  'zapier-automationbench':['https://zapier.com/benchmarks','official_documentation','web_public_excerpt'],
  'reddit-launch':['https://www.reddit.com/r/codex/comments/1wnkoh8/anyone_tried_gpt6_sol_yet/','community_forum','web_public_excerpt'],
  'x-upgrade-opinion':['https://x.com/LuminaBench/status/2102461027757769105','community_social','public_oembed'],
  'threads-usage-tip':['https://www.threads.com/@choi.openai/post/DdnFJbfj6G4','community_social','public_http'],
});
const mimoSourceContracts=Object.freeze({
  'mimo-pro':['https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/raw/main/README.md','official_documentation'],
  'mimo-flash':['https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL/raw/main/README.md','official_documentation'],
  'hn-mimo':['https://news.ycombinator.com/item?id=49792730','community_forum'],
  'mimo-release':['https://mimo.mi.com/docs/en-US/news/latest/v2-6','official_documentation'],
  'mimo-pro-api':['https://mimo.mi.com/models/en-US/mimo-v2.6-pro','official_documentation'],
  'mimo-batch-api':['https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/batch-api','official_documentation'],
  'mimo-token-plan':['https://mimo.mi.com/docs/zh-CN/news/latest/token-plan-release','official_documentation'],
  'mimo-token-plan-faq':['https://mimo.mi.com/docs/en-US/quick-start/faq/token-plan/Plans&Pricing','official_documentation'],
  'aa-comparison':['https://artificialanalysis.ai/ja/models/comparisons/grok-4-7-high-vs-mimo-v2-6-pro','official_documentation'],
  'aa-leaderboard':['https://artificialanalysis.ai/leaderboards/models','official_documentation'],
  'grok-api':['https://docs.x.ai/developers/models/grok-4.7','official_documentation'],
  'grok-release-notes':['https://docs.x.ai/developers/release-notes','official_documentation'],
  'grok-plans':['https://x.ai/pricing','official_documentation'],
  'reddit-local':['https://www.reddit.com/r/LocalLLaMA/comments/1wmnw89/xiaomimimomimov26flashrl_hugging_face/','community_forum'],
  'reddit-serving':['https://www.reddit.com/r/LocalLLaMA/comments/1wnjbwn/mimov26flash_on_vllm_fixes_for_empty_responses/','community_forum'],
  'reddit-roleplay':['https://www.reddit.com/r/SillyTavernAI/comments/1wmp2qc/mimo_26_pro_is_out_anyone_else_trying_it_for_rp/','community_forum'],
  'reddit-coding':['https://www.reddit.com/r/DeepSeek/comments/1wn3p6b/mimo_26_pro_feedback_after_7_hours_of_testing/','community_forum'],
});
const hash=v=>/^[a-f0-9]{64}$/.test(v||'');
const recent=(v,now,minutes)=>Number.isFinite(Date.parse(v))&&Date.parse(v)<=now.getTime()&&now.getTime()-Date.parse(v)<=minutes*60000;
const finish=checks=>({passed:Object.values(checks).every(v=>v===true),checks,failedChecks:Object.keys(checks).filter(k=>checks[k]!==true)});
const primaryKinds=new Set(['official_documentation','official_repository']);
const sourceKinds=new Set([...primaryKinds,'official_social','official_trending']);
export const isAiResearchArticle=job=>job?.publicationBundle?.format===AI_RESEARCH_SCOPE.format;
const isMiMo=bundle=>bundle?.research?.topicKey===MIMO_TOPIC;
const isGpt6Opus=bundle=>bundle?.research?.topicKey===GPT6_OPUS_TOPIC;
export function gpt6BenchmarkChecks(bundle) {
  const sources=sourcesOf(bundle),claims=bundle?.claimLedger?.claims??[],blocks=blocksOf(bundle);
  const tables=blocks.filter(block=>block.type==='table');
  const required=['zapier-automationbench','openai-release','anthropic-release'];
  const benchmarkClaim=sourceId=>claims.find(claim=>claim.claimType==='benchmark'&&claim.publishable===true&&
    claim.support==='supports'&&claim.sources?.includes(sourceId));
  const tableFor=(claim,terms)=>tables.some(table=>Array.isArray(table.claimIds)&&table.claimIds.includes(claim?.claimId)&&
    Array.isArray(table.columns)&&table.columns.length>=3&&Array.isArray(table.rows)&&table.rows.length>=2&&
    table.rows.every(row=>Array.isArray(row)&&row.length===table.columns.length)&&
    /\d+(?:\.\d+)?\s*%/.test(table.rows.flat().join(' '))&&
    terms.every(term=>term.test([table.columns,...table.rows].flat().join(' '))));
  const scope=claims.find(claim=>claim.claimType==='benchmark_scope'&&claim.publishable===true&&
    claim.support==='supports'&&['openai-release','anthropic-release'].every(id=>claim.sources?.includes(id)));
  const zapierClaim=benchmarkClaim('zapier-automationbench');
  return {
    gpt6BenchmarkSourcesPresent:required.every(id=>sources.some(source=>source.id===id)),
    gpt6BenchmarkClaimsBound:required.every(id=>Boolean(benchmarkClaim(id))),
    gpt6IndependentBenchmarkTable:tableFor(zapierClaim,[/성공률/,/작업당\s*비용/]) &&
      blocks.some((block,index)=>block.type==='table'&&block.claimIds?.includes(zapierClaim?.claimId)&&
        ((/Zapier/i.test([block.columns,...block.rows].flat().join(' '))&&/1\.0\.6/.test([block.columns,...block.rows].flat().join(' ')))||
          blocks.slice(Math.max(0,index-2),index).some(prior=>/Zapier/i.test(prior.text||'')&&/1\.0\.6/.test(prior.text||'')))),
    gpt6OpenAiPerformanceTable:tableFor(benchmarkClaim('openai-release'),[/GPT-6\s*Sol/i,/GPT-6\s*Luna/i,/평가/]),
    gpt6AnthropicPerformanceTable:tableFor(benchmarkClaim('anthropic-release'),[/Opus\s*5\.5/i,/Terminal-Bench/i,/표기\s*조건/]),
    gpt6BenchmarkScopeExplained:Boolean(scope)&&blocks.some(block=>block.claimIds?.includes(scope.claimId)&&
      /비교|같은\s*시험/.test(block.text||'')),
    gpt6BenchmarkSourceLinks:required.every(id=>{
      const source=sources.find(item=>item.id===id);
      return blocks.some(block=>block.type==='link'&&block.url===source?.url);
    }),
  };
}
const sourcesOf=bundle=>Array.isArray(bundle?.research?.sources)?bundle.research.sources:[];
const blocksOf=bundle=>Array.isArray(bundle?.document?.blocks)?bundle.document.blocks:[];
const cleanUrl=value=>{
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&!/(?:^|\.)(?:myrealt\.rip|myrealtrip\.com|coupang\.com|linktr\.ee|bit\.ly)$/.test(u.hostname)&&
    ![...u.searchParams.keys()].some(k=>/^(?:ref|referral|affiliate|aff|tag|lptag|partner|mylink)$/i.test(k));} catch {return false;}
};
export function researchSourcePublicUrl(source,topicKey) {
  if(topicKey===FRONTIER_TOPIC)return frontierSourcePublicUrl(source);
  if(topicKey==='jev-applications-20260921'&&applicationSourceKinds.has(source?.sourceKind))return jevApplicationSourcePublicUrl(source);
  if(topicKey===MIMO_TOPIC)return source?.url||null;
  try {
    const u=new URL(source.url);
    if(u.hostname==='docs.typesafe.ai')return u.href.replace(/\.md$/,'');
    if(u.hostname==='raw.githubusercontent.com') {
      const match=/^\/typesafe-ai\/(typesafe-sdk-python|system-one-adapter-python)\/main\/README\.md$/.exec(u.pathname);
      return match?`https://github.com/typesafe-ai/${match[1]}`:null;
    }
    if(u.hostname==='publish.twitter.com')return u.searchParams.get('url');
    return u.href;
  } catch {return null;}
}
function sourceOwnerScope(source,bundle) {
  if(isDynamicResearch(bundle))return dynamicSourceOwnerScope(source,bundle);
  if(isFrontierComparison(bundle))return frontierSourceOwnerScope(source);
  if(isJevApplications(bundle)&&(applicationSourceKinds.has(source?.sourceKind)||source?.projectId))return jevApplicationSourceOwnerScope(source);
  if(isGpt6Opus(bundle)){try{const expected=gpt6OpusSourceContracts[source?.id],u=new URL(source.url);return !!expected&&u.href===expected[0]&&source.sourceKind===expected[1]&&source.collectionMethod===expected[2]&&source.publicUrl===source.url&&!u.username&&!u.password&&!u.hash;}catch{return false;}}
  if(isMiMo(bundle)){try{const expected=mimoSourceContracts[source?.id],u=new URL(source.url);return !!expected&&u.href===expected[0]&&source.sourceKind===expected[1]&&source.publicUrl===source.url&&!u.username&&!u.password&&!u.hash;}catch{return false;}}
  try {
    const u=new URL(source.url),publicUrl=researchSourcePublicUrl(source);
    if(source.publicUrl!=null&&source.publicUrl!==publicUrl)return false;
    if(source.sourceKind==='official_documentation')return ['typesafe.ai','docs.typesafe.ai'].includes(u.hostname)&&!u.search;
    if(source.sourceKind==='official_repository')return u.hostname==='raw.githubusercontent.com'&&!!publicUrl;
    if(source.sourceKind==='official_social')return u.hostname==='publish.twitter.com'&&u.pathname==='/oembed'&&
      /^https:\/\/x\.com\/typesafeai\/status\/\d+$/.test(publicUrl||'')&&u.searchParams.getAll('url').length===1;
    return source.sourceKind==='official_trending'&&u.href==='https://github.com/trending';
  } catch {return false;}
}
export function aiResearchNoticeValid(value) {
  return /공식|원문/.test(text(value))&&/확인|기준/.test(text(value))&&/\d{4}[.\-/년]/.test(text(value))&&
    !/제휴|수수료|파트너스|협찬/.test(text(value));
}

export function evaluateAiResearchSnapshot(bundle,{now=new Date()}={}) {
  const research=bundle?.research,sources=sourcesOf(bundle),ledger=bundle?.claimLedger;
  const claims=Array.isArray(ledger?.claims)?ledger.claims:[];
  const bindings=Array.isArray(research?.claimBindings)?research.claimBindings:[];
  const sourceMap=new Map(sources.map(s=>[s.id,s]));
  const trend=research?.trendAssessment;
  const scopedPrimaryKinds=isDynamicResearch(bundle)?dynamicPrimaryKinds:isJevApplications(bundle)?new Set([...primaryKinds,...applicationSourceKinds]):isMiMo(bundle)||isGpt6Opus(bundle)?new Set(['official_documentation']):primaryKinds;
  const scopedSourceKinds=isDynamicResearch(bundle)?dynamicSourceKinds:isJevApplications(bundle)?new Set([...sourceKinds,...applicationSourceKinds]):isFrontierComparison(bundle)?new Set([...sourceKinds,'community_social']):isMiMo(bundle)?new Set(['official_documentation','community_forum']):isGpt6Opus(bundle)?new Set(['official_documentation','community_forum','community_social']):sourceKinds;
  const checks={
    researchSchema:research?.schemaVersion===1,
    researchTopicScope:isDynamicResearch(bundle)?evaluateDynamicPlan(bundle).passed:research?.topicKey===AI_RESEARCH_SCOPE.topicKey||isJevApplications(bundle)||isFrontierComparison(bundle)||isMiMo(bundle)||isGpt6Opus(bundle),
    researchFresh:recent(research?.checkedAt,now,1440),
    researchSourcesPresent:sources.length>=(isDynamicResearch(bundle)?1:2),
    researchSourceIdsUnique:new Set(sources.map(s=>s.id)).size===sources.length,
    researchPrimarySources:sources.filter(s=>scopedPrimaryKinds.has(s.sourceKind)).length>=(isDynamicResearch(bundle)?1:2),
    researchSourceContracts:sources.every(s=>text(s.id)&&cleanUrl(s.url)&&scopedSourceKinds.has(s.sourceKind)&&(isDynamicResearch(bundle)?dynamicSourceContract(s):(isFrontierComparison(bundle)||isMiMo(bundle)||isGpt6Opus(bundle))&&s.collectionMethod==='web_public_excerpt'?s.status===null&&s.httpStatus===null&&s.readerReturnedContent===true:isGpt6Opus(bundle)?s.status===200&&s.httpStatus===200&&s.readerReturnedContent===true:s.status===200)&&
      recent(s.checkedAt,now,1440)&&text(s.evidenceFile)&&hash(s.sha256)),
    researchOfficialSourceScope:sources.every(source=>sourceOwnerScope(source,bundle)),
    researchLedgerSourcesBound:sources.every(s=>{const e=ledger?.evidence?.[s.id];return e&&['url','checkedAt','evidenceFile','sha256'].every(k=>e[k]===s[k]);}),
    researchEvidenceDeclared:Object.keys(ledger?.evidence||{}).every(id=>sourceMap.has(id)),
    researchClaimsNotCommercial:claims.every(c=>!['price','stock','shipping','rating','review_count'].includes(c.claimType)),
    researchClaimBindings:claims.filter(c=>c.publishable===true).every(c=>Array.isArray(c.sources)&&c.sources.every(id=>
      bindings.some(b=>b.claimId===c.claimId&&b.sourceId===id&&text(b.locator).length>=3&&text(b.excerpt).length>=12))),
    researchBindingsResolve:bindings.length>0&&bindings.every(b=>sourceMap.has(b.sourceId)&&claims.some(c=>c.claimId===b.claimId&&c.sources?.includes(b.sourceId))),
    researchTrendBasis:['curated_primary_sources','verified_trending_snapshot'].includes(trend?.basis)&&recent(trend?.checkedAt,now,1440)&&text(trend?.limitations).length>=20,
    researchTrendNotInvented:trend?.basis==='verified_trending_snapshot'
      ? sources.some(s=>s.sourceKind==='official_trending'&&s.id===trend.sourceId)&&recent(sourceMap.get(trend.sourceId)?.checkedAt,now,60)
      : claims.every(c=>c.claimType!=='trend_rank')&&!/트렌딩\s*(?:전체\s*)?(?:[1-9]\d*위|TOP\s*\d+)|인기\s*급등|오늘\s*(?:의\s*)?깃허브\s*\d+위/i.test(blocksOf(bundle).map(b=>b.text||'').join('\n')),
    researchVolatileClaimsExpire:claims.every(c=>!['stars','forks','trend_rank','release'].includes(c.claimType)||
      Number.isFinite(Date.parse(c.expiresAt))&&Date.parse(c.expiresAt)>=now.getTime()&&Date.parse(c.expiresAt)-now.getTime()<=60*60000),
  };
  return finish(checks);
}

export function aiResearchLayoutChecks(bundle) {
  if(isDynamicResearch(bundle))return dynamicLayoutChecks(bundle);
  if(isFrontierComparison(bundle))return frontierLayoutChecks(bundle);
  const blocks=blocksOf(bundle),images=blocks.map((b,i)=>({b,i})).filter(({b})=>b.type==='image');
  const headings=blocks.map((b,i)=>({b,i})).filter(({b})=>b.type==='heading');
  const roles=new Set(images.map(({b})=>b.role));
  return {
    researchLayoutProfile:bundle?.layoutReference?.id==='naver-ai-research-v1',
    researchNoticeFirst:blocks[0]?.type==='notice'&&aiResearchNoticeValid(blocks[0].text),
    researchImageFloor:images.length>=AI_RESEARCH_SCOPE.minImages&&images.length<=(isGpt6Opus(bundle)?5:4),
    researchImageRoles:['cover','workflow','decision_checklist'].every(role=>roles.has(role))&&roles.size===images.length&&
      images.every(({b})=>(isGpt6Opus(bundle)?['cover','workflow','decision_checklist','concept_comparison','openai_official_benchmark','anthropic_official_benchmark']:['cover','workflow','decision_checklist','concept_comparison']).includes(b.role)),
    researchUnlinkedImages:images.every(({b})=>!b.href),
    researchLeadImage:images[0]?.b.role==='cover'&&images[0].i===1,
    researchQuotationSections:headings.length>=3&&headings.every(({b})=>b.presentation==='quotation'),
    researchSectionImages:images.slice(1).every(({i})=>headings.some(h=>h.i<i)),
    researchNoImageStrips:blocks.every(b=>b.type!=='imageStrip'),
  };
}

export function evaluateAiResearchArticle(job,{now=new Date()}={}) {
  const bundle=job?.publicationBundle,research=bundle?.research,blocks=blocksOf(bundle);
  const scopedPrimaryKinds=isDynamicResearch(bundle)?dynamicPrimaryKinds:isJevApplications(bundle)?new Set([...primaryKinds,...applicationSourceKinds]):isMiMo(bundle)||isGpt6Opus(bundle)?new Set(['official_documentation']):primaryKinds;
  const sourceUrls=new Set(sourcesOf(bundle).flatMap(s=>[s.url,isDynamicResearch(bundle)?s.publicUrl||s.url:researchSourcePublicUrl(s,research?.topicKey)]));
  if(isMiMo(bundle))sourceUrls.add('https://blog.naver.com/aicandoanything/224419454535');
  if(isFrontierComparison(bundle)) for(const image of blocks.filter(b=>b.type==='image')) if(frontierOriginalQuotation(bundle.document,image))sourceUrls.add(image.sourceArtifact.sourceUrl);
  const links=blocks.filter(b=>['link','oglink'].includes(b.type));
  const submitted=job?.bodyBlocks||job?.blocks||[];
  const checkLinks=list=>list.filter(b=>['link','oglink'].includes(b.type)).every(b=>(b.type==='link'&&b.display==='label'&&text(b.label).length>=4||isDynamicResearch(bundle)&&b.type==='oglink')&&sourceUrls.has(b.url));
  return finish({
    ...evaluateAiResearchSnapshot(bundle,{now}).checks,
    ...(isJevApplications(bundle)?jevApplicationChecks(bundle):{}),
    ...(isFrontierComparison(bundle)?{...frontierComparisonChecks(bundle),...frontierReactionChecks(bundle)}:{}),
    ...(isGpt6Opus(bundle)&&!isDynamicResearch(bundle)?gpt6BenchmarkChecks(bundle):{}),
    ...(isDynamicResearch(bundle)?{...evaluateDynamicPlan(bundle).checks,...evaluateAdaptiveReceipt(bundle,{now}).checks}:{}),
    researchArticleFormat:isAiResearchArticle(job),
    researchArticleScope:(isFrontierUpdate(job)||isExistingAiUpdate(job)||isDynamicResearch(bundle)&&job.target?.type==='update'&&String(bundle.gatePlan.target?.logNo)===String(job.target?.logNo)&&bundle.gatePlan.target?.blogId===job.blogId&&job.blogId===AI_RESEARCH_SCOPE.blogId)?job.inputProvider==='independent_http'&&job.executionMode==='independent_http':job?.blogId===AI_RESEARCH_SCOPE.blogId&&job?.target?.type==='create'&&!job.target.logNo&&
      bundle?.document?.blogId===job.blogId&&!bundle?.document?.logNo&&job.inputProvider==='headless_sdk'&&job.executionMode==='independent_http',
    researchCategoryScope:research?.category?.id===AI_RESEARCH_SCOPE.categoryId&&research.category.name===AI_RESEARCH_SCOPE.categoryName&&
      job?.publishSettings?.categoryId===research.category.id&&job?.publishSettings?.categoryName===AI_RESEARCH_SCOPE.categoryName,
    researchPublicationScope:job?.publishSettings?.visibility==='public'&&job.publishSettings.timing==='current'&&job.publishSettings.searchAllowed===true,
    researchSnapshotBound:fingerprint(job?.researchSnapshot??null)===fingerprint(research??null),
    researchNoCommercePayload:job?.affiliate==null&&job?.commercialSnapshot==null&&Array.isArray(bundle?.products)&&bundle.products.length===0,
    researchNoAffiliateText:!/(?:제휴.*수수료|쿠팡\s*파트너스|할인쿠폰|구매\s*링크|판매\s*링크)/.test(blocks.map(b=>b.text||b.label||(b.type==='table'?[b.columns,...(b.rows||[])].flat().join(' '):'')).join('\n')),
    researchPrimarySourceLinks:links.length>=(isDynamicResearch(bundle)?1:2)&&links.filter(b=>sourcesOf(bundle).some(s=>[s.url,isDynamicResearch(bundle)?s.publicUrl||s.url:researchSourcePublicUrl(s,research?.topicKey)].includes(b.url)&&scopedPrimaryKinds.has(s.sourceKind))).length>=(isDynamicResearch(bundle)?1:2),
    researchLinksScoped:checkLinks(blocks)&&checkLinks(submitted)&&blocks.every(b=>!b.href)&&submitted.every(b=>!b.href),
    researchNoRawUrlProse:[...blocks,...submitted].filter(b=>['paragraph','notice','quote','heading','list','numbered','table'].includes(b.type)).every(b=>!/https?:\/\//i.test(b.text||(b.type==='table'?[b.columns,...(b.rows||[])].flat().join(' '):(b.items||[]).join(' ')))),
    researchEditorialReviewProvenance:editorialProvenanceAllowed(bundle,{now}),
  });
}

function strings(value) {
  if(typeof value==='string')return [value];
  if(Array.isArray(value))return value.flatMap(strings);
  if(value&&typeof value==='object')return Object.values(value).flatMap(strings);
  return [];
}
export async function verifyAiResearchEvidence(bundle,{read}={}) {
  const checks={},corpus=new Map();
  for(const source of sourcesOf(bundle)) {
    try {const bytes=await read(source.evidenceFile,source.sha256),raw=bytes.toString('utf8');let content=[raw];
      try {content.push(...strings(JSON.parse(raw)));} catch {}
      corpus.set(source.id,content.map(text));checks[`researchSource_${source.id}`]=true;
    } catch {checks[`researchSource_${source.id}`]=false;}
  }
  for(const [i,binding] of (bundle?.research?.claimBindings||[]).entries())
    checks[`researchExcerpt_${i}`]=corpus.get(binding.sourceId)?.some(raw=>raw.includes(text(binding.excerpt)))===true;
  checks.researchEvidenceArtifactsPresent=corpus.size>=(isDynamicResearch(bundle)?1:2);
  return finish(checks);
}

// Exact ordered text is checked separately; source links also need independent
// href verification because labeled-link text alone does not bind the href.
export function aiResearchReadbackChecks(job,observation) {
  const blocks=blocksOf(job?.publicationBundle),links=blocks.filter(b=>['link','oglink'].includes(b.type)).map(b=>b.url);
  return {
    researchNoticeFirst:blocks[0]?.type==='notice'&&aiResearchNoticeValid(blocks[0].text)&&text(observation?.units?.[0]?.value)===text(blocks[0].text),
    researchSourceLinksClickable:links.length>=(isDynamicResearch(job?.publicationBundle)?1:2)&&links.every(url=>observation?.links?.includes(url)),
    researchNoUnplannedLinks:(observation?.links||[]).every(url=>links.includes(url)),
    researchImagesUnlinked:(observation?.units||[]).filter(u=>u.type==='image').every(u=>!u.href),
  };
}
