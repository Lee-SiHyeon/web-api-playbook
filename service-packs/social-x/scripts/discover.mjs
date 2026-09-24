// Public metadata only; never save script bodies, tokens, cookies or application state.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const html = await (await fetch('https://x.com/manifest.js', {redirect:'error'})).text();
const asset = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[A-Za-z0-9]+\.js/)?.[0];
if (!asset) throw Error('ASSET_CHANGED');
const source = await (await fetch(asset, {redirect:'error'})).text();
const state = JSON.parse(html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/)?.[1]);
const defaults = {...state.featureSwitch?.defaultConfig,...state.featureSwitch?.user?.config};
// Value explicitly observed in authenticated X timeline request on 2026-09-22.
defaults.rweb_conversational_replies_downvote_enabled = {value:false};
const operations = {};
for (const name of ['UserByScreenName','UserOriginalsTimeline','TweetDetail','CreateTweet']) {
  const match = source.match(new RegExp('queryId:"([A-Za-z0-9_-]+)",operationName:"'+name+'",operationType:"(query|mutation)",metadata:\\{featureSwitches:(\\[[^\\]]*\\]),fieldToggles:(\\[[^\\]]*\\])'));
  if (!match) throw Error('CONTRACT_CHANGED:'+name);
  const features = {};
  for (const key of JSON.parse(match[3])) {
    if(typeof defaults[key]?.value !== 'boolean') throw Error('FEATURE_UNRESOLVED:'+key);
    features[key] = defaults[key].value;
  }
  operations[name] = {queryId:match[1],type:match[2],features,fieldToggles:{},evidence:['UserByScreenName','UserOriginalsTimeline'].includes(name)?'browser_request_observed':'public_source_only'};
}
operations.UserByScreenName.fieldToggles = {withPayments:false,withAuxiliaryUserLabels:true};
operations.UserOriginalsTimeline.fieldToggles = {withPayments:false,withArticlePlainText:false};
await mkdir('contracts',{recursive:true});
await writeFile('contracts/x.json',JSON.stringify({checkedAt:new Date().toISOString(),asset,sha256:createHash('sha256').update(source).digest('hex'),operations},null,2)+'\n');
console.log('Saved public operation metadata; no credentials saved.');
