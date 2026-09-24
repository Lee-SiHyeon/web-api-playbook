import {createHash} from 'node:crypto';
// Scoped research comparison; does not grant a commercial publishing route.
export const FRONTIER_TOPIC='frontier-six-models-20260922';
export const FRONTIER_UPDATE_SCOPE=Object.freeze({blogId:'aicandoanything',existingLogNo:'224419454535',categoryId:12,title:'Grok 4.7 출시: 무엇이 달라졌나, 공식 벤치마크와 X·Reddit 반응'});
export const isFrontierUpdate=job=>job?.publicationBundle?.format==='ai_research_article'&&isFrontierComparison(job.publicationBundle)&&job.blogId===FRONTIER_UPDATE_SCOPE.blogId&&job.target?.type==='update'&&job.target.logNo===FRONTIER_UPDATE_SCOPE.existingLogNo&&job.publicationBundle.document?.logNo===FRONTIER_UPDATE_SCOPE.existingLogNo&&job.publicationBundle.document?.title===FRONTIER_UPDATE_SCOPE.title;
export const isFrontierComparison=b=>b?.research?.topicKey===FRONTIER_TOPIC;
const hosts=new Set(['x.ai','docs.x.ai','developers.openai.com','openai.com','help.openai.com','www.anthropic.com','platform.claude.com','claude.com','support.claude.com','blog.google','ai.google.dev','one.google.com','www.qwencloud.com','docs.qwencloud.com','qwen.ai','api-docs.deepseek.com','huggingface.co','arena.ai']);
export function frontierSourcePublicUrl(s){if(s.id==='grokSubscriptions')return 'https://grok.com/supergrok?referrer=pricing&target=supergrok';try{const u=new URL(s.url);return u.hostname==='huggingface.co'?u.href.replace('/raw/main/README.md',''):u.href;}catch{return null;}}
export function frontierSourceOwnerScope(s){if(s.id==='grokSubscriptions')return s.url==='https://grok.com/rest/products?provider=SUBSCRIPTION_PROVIDER_STRIPE'&&s.publicUrl===frontierSourcePublicUrl(s)&&s.sourceKind==='official_documentation'&&s.collectionMethod==='browser_network_capture'&&s.representation==='normalized_capture';if(['community_social','official_social'].includes(s.sourceKind))return frontierReactionSource(s);try{const u=new URL(s.url);return expectedSourceUrls[s.id]===u.href&&hosts.has(u.hostname)&&!u.search&&!u.hash&&!u.username&&!u.password&&(!s.publicUrl||s.publicUrl===frontierSourcePublicUrl(s))&&(u.hostname!=='huggingface.co'||u.pathname==='/deepseek-ai/DeepSeek-V4.1-Flash/raw/main/README.md')&&s.sourceKind==='official_documentation';}catch{return false;}}
const expectedSourceUrls={"grok":"https://x.ai/news/grok-4-7","grokSpecs":"https://docs.x.ai/developers/models/grok-4.7","astraSpecs":"https://developers.openai.com/api/docs/models/gpt-6-astra","fable":"https://www.anthropic.com/claude-fable-and-mythos-5-1","fableSpecs":"https://platform.claude.com/docs/en/models/fable-5-1/overview","gemini":"https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/","geminiSpecs":"https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash","qwen":"https://www.qwencloud.com/models/qwen3.8-max-0902","qwenReleases":"https://docs.qwencloud.com/changelog/models","deepseek":"https://api-docs.deepseek.com/updates/","deepseekPricing":"https://api-docs.deepseek.com/quick_start/pricing","deepseekWeights":"https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/raw/main/README.md","claudePlans":"https://claude.com/pricing","claudeFableAccess":"https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan","googlePlansUS":"https://one.google.com/intl/en_us/about/google-ai-plans/","deepseekApp":"https://api-docs.deepseek.com/news/news250115/","openaiLearnPricingDE":"https://developers.openai.com/de-DE/docs/pricing","arena-text":"https://arena.ai/leaderboard/text","arena-code-webdev":"https://arena.ai/leaderboard/code/webdev","arena-search":"https://arena.ai/leaderboard/search"};
const expectedModels={"grok":{"modelId":"grok-4.7","sourceId":"grokSpecs","input":2,"output":6,"currency":"USD","perTokens":1000000},"gpt":{"modelId":"gpt-6-astra","sourceId":"astraSpecs","input":10,"output":50,"currency":"USD","perTokens":1000000},"claude":{"modelId":"claude-fable-5-1","sourceId":"fableSpecs","input":10,"output":50,"currency":"USD","perTokens":1000000},"gemini":{"modelId":"gemini-3.8-flash","sourceId":"gemini","input":0.75,"output":3.75,"currency":"USD","perTokens":1000000},"qwen":{"modelId":"qwen3.8-max-2026-09-02","sourceId":"qwen","input":2,"output":6,"currency":"USD","perTokens":1000000},"deepseek":{"modelId":"deepseek-flash","sourceId":"deepseekPricing","input":0.15,"output":0.6,"currency":"USD","perTokens":1000000}};
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const originalSources={
 'images/original-grok-cost.png':['https://x.com/SpaceXAI/status/2102069817893150777','https://pbs.twimg.com/media/HSwLemqWoAAP4EW?format=jpg&name=4096x4096','a70ca1298f486e9c8cdf50fc6a7df528b3417673753c6fa4233ea99a18daaaf6'],
 'images/original-grok-table.png':['https://x.com/SpaceXAI/status/2102069815225586149','https://pbs.twimg.com/media/HSwLcNqXIAAwNtz?format=png&name=900x900','f2ad782fb2fde0358ffe3fd2ba180391f4886d7f4399c3a961af436d1c6c77a8'],
 'images/original-gemini.png':['https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/','https://storage.googleapis.com/gweb-uniblog-publish-prod/images/gemini-3.8-flash__evals__table_l.width-1200.format-webp_2pLdBp5.webp','3343387ccc4ea5219f6ef38f568b18d78e8488459309de6572e30c83e81bfd3a']
};
const originalOutputs={"images/original-grok-cost.png": {"sha256": "d8286b390d748d475b1b26a456e704bec8113771adffae0f4000995406e782f8", "decodedPixelSha256": "94059b6238d6846585521b3fc9a17b3328254ec784445c7a7f1fba08f1bb916a", "width": 3062, "height": 1960, "transformation": "lossless_png_transcode_same_decoded_pixels", "sourceFile": "images/original-grok-cost.jpg"}, "images/original-grok-table.png": {"sha256": "f2ad782fb2fde0358ffe3fd2ba180391f4886d7f4399c3a961af436d1c6c77a8", "decodedPixelSha256": "b35d9ed58220f9c19a942566ae1e7dfb39d04afa804d4f3712aac3e3e9eff11e", "width": 900, "height": 739, "transformation": "none", "sourceFile": "images/original-grok-table.png"}, "images/original-gemini.png": {"sha256": "4c244169fdae00cffdf325881aaf82fe1621b7f324dc05bbf5c477fc1bf384fb", "decodedPixelSha256": "2413fc024d34ec639a7cd8de0f3898b663b559771dbe6ed2ad2c6f7bfe863751", "width": 1200, "height": 1470, "transformation": "lossless_png_transcode_same_decoded_pixels", "sourceFile": "images/original-gemini.webp"}};
// Dated analytical quotations, not an assertion of ownership or an open licence.
export function frontierOriginalQuotation(document,b){
 const expected=originalSources[b.file],a=b.sourceArtifact,index=document.blocks?.indexOf(b),caption=document.blocks?.[index+1];
 return document.blogId==='aicandoanything'&&((!document.logNo&&document.title==='Grok 4.7, 최신 AI 6종과 비교: 공식 벤치마크·API 요금·구독 조건')||(document.logNo===FRONTIER_UPDATE_SCOPE.existingLogNo&&document.title===FRONTIER_UPDATE_SCOPE.title))&&!!expected&&b.rights?.basis==='editorial_quotation'&&
 Object.entries(originalOutputs[b.file]).every(([k,v])=>a?.[k]===v)&&a?.sourceUrl===expected[0]&&a.assetUrl===expected[1]&&a.sourceSha256===expected[2]&&a.sha256===b.sha256&&a.width>500&&a.height>300&&
 ['none','lossless_png_transcode_same_decoded_pixels'].includes(a.transformation)&&/^[a-f0-9]{64}$/.test(a.decodedPixelSha256||'')&&
 b.sourceRepresentation===(a.transformation==='none'?'official_original':'official_original_transcoded')&&b.rights.source===a.sourceUrl&&b.rights.attribution===a.attribution&&b.rights.purpose?.length>15&&
 caption?.type==='paragraph'&&caption.text.startsWith(a.attribution)&&document.blocks[index+2]?.type==='link'&&document.blocks[index+2].url===a.sourceUrl&&
 (!b.tableId||b.bindingRole==='extracted_reference');
}
const tableHash=t=>{const {dataSha256,...data}=t;return createHash('sha256').update(JSON.stringify(stable(data))).digest('hex');};
export function frontierComparisonChecks(b){
 const rows=b?.research?.comparison?.models??[],tables=b?.research?.comparison?.tables??[],claims=b?.claimLedger?.claims??[];
 const sources=new Set((b?.research?.sources??[]).map(s=>s.id)),families=['grok','gpt','claude','gemini','qwen','deepseek'];
 const images=(b?.document?.blocks??[]).filter(x=>x.type==='image');
 return {
  frontierSixFamilies:rows.length===6&&families.every(f=>rows.filter(r=>r.family===f).length===1),
  frontierExactModels:rows.every(r=>expectedModels[r.family]&&Object.entries(expectedModels[r.family]).every(([k,v])=>r[k]===v)&&sources.has(r.sourceId)),
  frontierPriceUnits:rows.every(r=>r.currency==='USD'&&r.perTokens===1000000&&Number.isFinite(r.input)&&Number.isFinite(r.output)&&r.input>=0&&r.output>=0&&typeof r.priceConditions==='string'&&r.priceConditions.length>10),
  frontierResearchPriceClaims:claims.filter(c=>['api_pricing','subscription_pricing'].includes(c.claimType)).every(c=>c.currency==='USD'&&c.unit&&c.conditions&&c.sources.every(s=>sources.has(s))),
  frontierTableSources:tables.length>=3&&tables.every(t=>t.id&&t.title&&/^[a-f0-9]{64}$/.test(t.dataSha256||'')&&tableHash(t)===t.dataSha256&&t.columns?.length>=2&&t.rows?.every(row=>Array.isArray(row)&&row.length===t.columns.length)&&t.rows?.length&&t.sourceIds?.length&&t.sourceIds.every(s=>sources.has(s))&&t.conditions?.length>20&&t.claimIds?.length&&t.claimIds.every(id=>claims.some(c=>c.claimId===id&&c.publishable))),
  frontierTableImages:tables.every(t=>images.some(i=>i.tableId===t.id&&i.tableDataSha256===t.dataSha256&&JSON.stringify(i.claimIds)===JSON.stringify(t.claimIds))),
  frontierApiTableMatchesModels:JSON.stringify(tables.find(t=>t.id==='api-pricing')?.rows)===JSON.stringify(rows.map(r=>[r.name,String(r.input),String(r.output)])),
  frontierNoUniversalRank:b?.research?.comparison?.universalRanking===false&&tables.every(t=>!('rank' in t)),
 };
}
export function frontierLayoutChecks(b){const blocks=b?.document?.blocks??[],images=blocks.map((b,i)=>({b,i})).filter(x=>x.b.type==='image'),headings=blocks.map((b,i)=>({b,i})).filter(x=>x.b.type==='heading');return {
 researchLayoutProfile:b?.layoutReference?.id==='naver-frontier-comparison-v1',
 researchNoticeFirst:blocks[0]?.type==='notice'&&/2026.*공식|공식.*2026/.test(blocks[0].text),
 researchImageFloor:images.length>=4&&images.length<=10,
 researchImageRoles:images[0]?.b.role==='cover'&&images.slice(1).every(x=>['benchmark_table','api_pricing','subscription_plans','model_overview'].includes(x.b.role)),
 researchUnlinkedImages:images.every(x=>!x.b.href),researchLeadImage:images[0]?.i===1,
 researchQuotationSections:headings.length>=4&&headings.every(x=>x.b.presentation==='quotation'),
 researchSectionImages:images.slice(1).every(x=>headings.some(h=>h.i<x.i)),researchNoImageStrips:blocks.every(x=>x.type!=='imageStrip'),
};}

const reactionUrls={
 xOfficial:'https://x.com/SpaceXAI/status/2102069815225586149',
 xEffort:'https://x.com/ibrahim64k/status/2102074696539763073',
 xUi:'https://x.com/friezedev/status/2102173802108977610',
 redditCost:'https://www.reddit.com/r/singularity/comments/1wmgudm/comment/pb6qu7d/',
 redditEffort:'https://www.reddit.com/r/singularity/comments/1wmgudm/comment/pb6tnbw/',
 redditWriting:'https://www.reddit.com/r/grok/comments/1wmgpvw/comment/pb6tfj5/'
};
const reactionIdentities={xOfficial:['SpaceXAI','2102069815225586149'],xEffort:['ibrahim64k','2102074696539763073'],xUi:['friezedev','2102173802108977610'],redditCost:['I_Am_Zyzz_AMA','pb6qu7d'],redditEffort:['RideOrDieRemember','pb6tnbw'],redditWriting:['Creative_Ad6288','pb6tfj5']};
function frontierReactionSource(s){return reactionUrls[s.id]===s.url&&s.publicUrl===s.url&&s.sourceKind===(s.id==='xOfficial'?'official_social':'community_social')&&s.author===reactionIdentities[s.id]?.[0]&&s.postId===reactionIdentities[s.id]?.[1]&&s.collectionMethod===(s.id.startsWith('reddit')?'web_public_excerpt':'pure_http')&&s.representative===false;}
export function frontierReactionChecks(bundle){
 const social=(bundle?.research?.sources||[]).filter(s=>['community_social','official_social'].includes(s.sourceKind));
 if(!social.length)return {};
 return {frontierReactionUpdateOnly:bundle?.document?.logNo===FRONTIER_UPDATE_SCOPE.existingLogNo&&bundle.document.title===FRONTIER_UPDATE_SCOPE.title,
 frontierOpinionsAttributed:(bundle.claimLedger?.claims||[]).filter(c=>c.sources?.some(id=>social.some(s=>s.id===id)&&id!=='xOfficial')).every(c=>c.claimType==='attributed_opinion'&&c.attribution?.length>0&&c.representative===false),
 frontierSampleLimitations:(bundle.research?.reactionSampling?.limitations||'').length>40&&bundle.research.reactionSampling.representative===false};
}
