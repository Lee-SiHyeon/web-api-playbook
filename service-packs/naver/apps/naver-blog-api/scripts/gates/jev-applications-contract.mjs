import {text} from './publication-document.mjs';

// This second article has its own evidence scope. It does not expand the
// earlier Jev introduction's official-source-only publication contract.
export const JEV_APPLICATIONS_SCOPE=Object.freeze({topicKey:'jev-applications-20260921',minApplications:2});
export const isJevApplications=bundle=>bundle?.research?.topicKey===JEV_APPLICATIONS_SCOPE.topicKey;
export const applicationSourceKinds=new Set(['verified_creator_post','project_repository','project_demo']);

// Exact observed source/canonical-reader pairs are added only after the current
// research capture establishes the author, project and Jev connection.
const repositorySource=(owner,repo,file='README.md')=>Object.freeze({
  url:`https://raw.githubusercontent.com/${owner}/${repo}/main/${file}`,
  publicUrl:`https://github.com/${owner}/${repo}${file==='README.md'?'':`/blob/main/${file}`}`,
  sourceKind:'project_repository',creatorIdentity:owner,projectId:repo,
});
const traderPost='https://x.com/jarrodwatts/status/2100356151468585346';
export const JEV_APPLICATION_SOURCES=Object.freeze([
  repositorySource('unicodeveloper','jevocks'),
  repositorySource('unicodeveloper','jevocks','src/lib/classify.ts'),
  repositorySource('unicodeveloper','jevocks','src/app/api/analyze/route.ts'),
  repositorySource('jarrodwatts','jev-trader'),
  repositorySource('jarrodwatts','jev-trader','src/config.ts'),
  repositorySource('browser-use','jev-ultrafast'),
  repositorySource('thruwire','foreman'),
  repositorySource('tamaratran','fast-jev-compaction'),
  ...['https://publish.twitter.com/oembed','https://publish.x.com/oembed'].map(base=>Object.freeze({
    url:`${base}?url=${encodeURIComponent(traderPost)}&omit_script=true`,publicUrl:traderPost,
    sourceKind:'verified_creator_post',creatorIdentity:'jarrodwatts',projectId:'jev-trader',
  })),
  Object.freeze({url:'https://jev-trader.vercel.app/',publicUrl:'https://jev-trader.vercel.app/',sourceKind:'project_demo',creatorIdentity:'jarrodwatts',projectId:'jev-trader'}),
  Object.freeze({url:'https://typesafe.ai/blog/introducing-system-one-models-and-jev',publicUrl:'https://typesafe.ai/blog/introducing-system-one-models-and-jev',
    sourceKind:'official_documentation',creatorIdentity:'typesafe-ai',projectId:'doom-demo'}),
]);
export function jevApplicationSource(source) {
  return JEV_APPLICATION_SOURCES.find(item=>item.url===source?.url&&item.sourceKind===source?.sourceKind);
}
export function jevApplicationSourcePublicUrl(source) {
  return jevApplicationSource(source)?.publicUrl||null;
}
export function jevApplicationSourceOwnerScope(source) {
  const known=jevApplicationSource(source);
  return !!known&&(!source.publicUrl||source.publicUrl===known.publicUrl)&&source.creatorIdentity===known.creatorIdentity&&
    source.projectId===known.projectId;
}

export function jevApplicationChecks(bundle) {
  const research=bundle?.research,applications=Array.isArray(research?.applications)?research.applications:[];
  const sources=Array.isArray(research?.sources)?research.sources:[],claims=Array.isArray(bundle?.claimLedger?.claims)?bundle.claimLedger.claims:[];
  const sourceMap=new Map(sources.map(s=>[s.id,s])),claimMap=new Map(claims.map(c=>[c.claimId,c]));
  const boundaries=research?.applicationBoundaries;
  const blocks=bundle?.document?.blocks||[],factualIds=new Set(blocks.filter(b=>b.claimClass==='factual').flatMap(b=>b.claimIds||[]));
  const levels=['creator_claim','public_demo','repository_example','official_demo_description'];
  const attributed=claim=>levels.includes(claim?.evidenceLevel)&&claim?.claimType==='application_observation';
  return {
    applicationsPresent:applications.length>=JEV_APPLICATIONS_SCOPE.minApplications,
    applicationsDistinct:new Set(applications.map(a=>a.id)).size===applications.length&&new Set(applications.map(a=>a.projectId)).size===applications.length,
    applicationsNamed:applications.every(a=>text(a.id)&&text(a.title).length>=3&&text(a.domain).length>=3&&text(a.projectId).length>=3),
    applicationsObservationLevel:applications.every(a=>levels.includes(a.observationLevel)&&text(a.limitations).length>=25),
    applicationsSourcesBound:applications.every(a=>Array.isArray(a.sourceIds)&&a.sourceIds.length>0&&a.sourceIds.every(id=>sourceMap.get(id)?.projectId===a.projectId)&&
      a.sourceIds.some(id=>!!jevApplicationSource(sourceMap.get(id)))),
    applicationsClaimsBound:applications.every(a=>Array.isArray(a.claimIds)&&a.claimIds.length>0&&a.claimIds.every(id=>{
      const c=claimMap.get(id);return attributed(c)&&c.evidenceLevel===a.observationLevel&&c.applicationId===a.id&&c.support==='supports'&&c.publishable===true&&
        c.sources?.some(sourceId=>a.sourceIds.includes(sourceId));
    })),
    applicationsCoverage:applications.every(a=>a.claimIds?.some(id=>factualIds.has(id))),
    applicationsEvidenceLevelSupported:applications.every(a=>a.observationLevel==='creator_claim'
      ? a.sourceIds?.some(id=>sourceMap.get(id)?.sourceKind==='verified_creator_post')
      : a.observationLevel==='public_demo'
        ? a.sourceIds?.some(id=>sourceMap.get(id)?.sourceKind==='project_demo')
        : a.observationLevel==='official_demo_description'
          ? a.sourceIds?.some(id=>sourceMap.get(id)?.sourceKind==='official_documentation'&&sourceMap.get(id)?.projectId==='doom-demo'&&!!jevApplicationSource(sourceMap.get(id)))
          : a.sourceIds?.some(id=>sourceMap.get(id)?.sourceKind==='project_repository')),
    applicationsExecutionBoundary:boundaries?.publicationPurpose==='informational_case_studies'&&boundaries?.authorExecutedProjects===false&&
      boundaries?.transactionExecution==='not_performed'&&boundaries?.financialPerformanceVerified===false,
    applicationsFinancialLimits:applications.filter(a=>['jevocks','jev-trader'].includes(a.projectId)||a.domain==='trading').every(a=>a.financialResults==='not_independently_verified'&&
      ['analysis_only','demo_only','creator_claim_live','unknown'].includes(a.tradingMode)&&Array.isArray(a.limitClaimIds)&&a.limitClaimIds.length>0&&
      a.limitClaimIds.every(id=>claimMap.get(id)?.claimType==='uncertainty'&&claimMap.get(id)?.publishable===true&&factualIds.has(id))),
    applicationsNoFinancialPerformanceClaims:claims.every(c=>!['investment_recommendation','trading_performance','profit','return','win_rate','guaranteed_return','live_trade_execution_verified'].includes(c.claimType)),
    applicationsNoFinancialGuarantees:!/수익이\s*보장됩니다|반드시\s*수익|무조건\s*돈을|원금이\s*보장|손실\s*없이\s*(?:투자|거래)|검증된\s*(?:수익률|승률)/.test(blocks.map(b=>b.text||'').join('\n')),
  };
}
