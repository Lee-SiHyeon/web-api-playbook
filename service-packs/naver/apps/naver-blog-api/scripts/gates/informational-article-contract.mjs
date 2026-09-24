import {isAiResearchArticle, evaluateAiResearchArticle, aiResearchReadbackChecks} from './ai-research-article-contract.mjs';
import {isMarketAnalysisArticle, evaluateMarketAnalysisArticle, marketAnalysisReadbackChecks} from './market-analysis-article-contract.mjs';

// These are separate, fully validated publication contracts. A format name alone
// never grants a commercial job permission to omit its affiliate/product gates.
export const isInformationalArticle = job => isAiResearchArticle(job) || isMarketAnalysisArticle(job);
export function evaluateInformationalArticle(job, options) {
  if (isAiResearchArticle(job)) return evaluateAiResearchArticle(job, options);
  if (isMarketAnalysisArticle(job)) return evaluateMarketAnalysisArticle(job, options);
  return {passed: false, checks: {informationalContractKnown: false}, failedChecks: ['informationalContractKnown']};
}
export function informationalReadbackChecks(job, observation) {
  if (isAiResearchArticle(job)) return aiResearchReadbackChecks(job, observation);
  if (isMarketAnalysisArticle(job)) return marketAnalysisReadbackChecks(job, observation);
  return {informationalContractKnown: false};
}
