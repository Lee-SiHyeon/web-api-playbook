// Refresh public operation metadata; values must already have been observed in the captured contract.
import {createHash} from 'node:crypto';
import { SOCIAL_REQUEST_TIMEOUTS } from '../../../../social-actions/lib/request-timeouts.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
let cached;

export function createContractFromSource(source,saved,operation='CreateTweet') {
 if(!['CreateTweet','CreateNoteTweet'].includes(operation))fail('X_CREATE_OPERATION_INVALID');
 const match=source.match(new RegExp(`queryId:"([A-Za-z0-9_-]+)",operationName:"${operation}",operationType:"mutation",metadata:\\{featureSwitches:(\\[[^\\]]*\\]),fieldToggles:(\\[[^\\]]*\\])`));
 if(!match)fail('X_CREATE_CURRENT_CONTRACT_MISSING');
 const keys=JSON.parse(match[2]),fields=JSON.parse(match[3]);
 const missingFeatures=keys.filter(k=>typeof saved.features?.[k]!=='boolean');
 if(missingFeatures.length)throw Object.assign(new Error('X_CREATE_CURRENT_CONTRACT_INCOMPLETE'),{code:'X_CREATE_CURRENT_CONTRACT_INCOMPLETE',receipt:{missingFeatures,writeSent:false}});
 // fieldToggles are optional call-site inputs. Preserve only captured inputs rather than inventing defaults from their names.
 return {...saved,queryId:match[1],features:Object.fromEntries(keys.map(k=>[k,saved.features[k]])),fieldToggles:Object.fromEntries(fields.filter(k=>typeof saved.fieldToggles?.[k]==='boolean').map(k=>[k,saved.fieldToggles[k]]))};
}

async function text(response) {
 if(!response.ok)throw Object.assign(new Error('X_CREATE_ASSET_UNAVAILABLE'),{code:'X_CREATE_ASSET_UNAVAILABLE',receipt:{httpStatus:response.status,writeSent:false}});
 let bytes=0;const chunks=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>5000000)fail('X_CREATE_ASSET_TOO_LARGE');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');
}
const publicGetOptions=()=>({redirect:'error',signal:AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.publicAsset)});
function mainAsset(html) {
 const normalized=html.replace(/\\u002f/gi,'/').replace(/\\\//g,'/');
 return normalized.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[A-Za-z0-9]+\.js/)?.[0]||null;
}
function bootstrapState(html) {
 const match=html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/);
 try{return JSON.parse(match?.[1]);}catch{fail('X_CREATE_BOOTSTRAP_SCHEMA');}
}
async function publicAssetPage(fetchImpl) {
 const manifest=await fetchImpl('https://x.com/manifest.js',publicGetOptions());
 if(manifest.status===404)return {html:await text(await fetchImpl('https://x.com/',publicGetOptions())),source:'homepage'};
 const html=await text(manifest);
 if(mainAsset(html))return {html,source:'manifest'};
 // A successful but asset-less manifest can still be recovered from the public homepage.
 return {html:await text(await fetchImpl('https://x.com/',publicGetOptions())),source:'homepage'};
}

export async function refreshCreateTweetContract(contracts,fetchImpl=fetch) {
 if(cached&&Date.now()-cached.at<300000)return {...contracts,operations:{...contracts.operations,...cached.operations},createEvidence:cached.createEvidence};
 const {html,source:discoverySource}=await publicAssetPage(fetchImpl);
 const asset=mainAsset(html);
 if(!asset)fail('X_CREATE_CURRENT_ASSET_MISSING');
 const source=await text(await fetchImpl(asset,publicGetOptions()));
 const state=bootstrapState(html);
 const defaults={...state.featureSwitch?.defaultConfig,...state.featureSwitch?.user?.config};
 const observed=Object.fromEntries(Object.entries(defaults).filter(([,v])=>typeof v?.value==='boolean').map(([k,v])=>[k,v.value]));
 const base=contracts.operations.CreateTweet;
 const createTweet=createContractFromSource(source,{...base,features:{...base.features,...observed}},'CreateTweet');
 const savedNote=contracts.operations.CreateNoteTweet||{};
 const noteSeed={...base,...savedNote,features:{...base.features,...savedNote.features,...observed},fieldToggles:savedNote.fieldToggles||{}};
 const createNoteTweet=createContractFromSource(source,noteSeed,'CreateNoteTweet');
 const operations={CreateTweet:createTweet,CreateNoteTweet:createNoteTweet};
 const createEvidence={sourceHash:createHash('sha256').update(source).digest('hex'),asset:new URL(asset).pathname.split('/').pop(),discoverySource,
  queryId:createTweet.queryId,noteQueryId:createNoteTweet.queryId};
 cached={at:Date.now(),operations,createEvidence};
 return {...contracts,operations:{...contracts.operations,...operations},createEvidence};
}
