import {readFollowers} from './x-followers.mjs';
import {withXReadContext} from './providers/x.mjs';
import {observeFollowers} from './x-relationship-state.mjs';
const ttl=120000;
const fresh=(at,now)=>Number.isFinite(Date.parse(at))&&now>=Date.parse(at)&&now-Date.parse(at)<ttl;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function followerSnapshot(state,{reader=readFollowers,now=Date.now()}={}) {
 const cached=state.followerSnapshot;
 if(cached?.ownerHandle==='lifehack__ailab'&&cached.complete===true&&fresh(cached.checkedAt,now))return {...cached,cached:true};
 const scan=await reader();
 if(scan.ownerHandle!=='lifehack__ailab'||scan.complete!==true)fail('X_BOT_OWNER_OR_SCAN_UNVERIFIED');
 state.followerSnapshot=scan;observeFollowers(state,scan);
 return {...scan,cached:false};
}
export async function participationSnapshots(state,promotionIds,{reader,now=Date.now()}={}) {
 const cached=state.promotionObservations;
 if(Array.isArray(cached)&&cached.length===promotionIds.length&&cached.every(s=>Array.isArray(s.likes)&&Array.isArray(s.reposts))
  &&promotionIds.every(id=>cached.some(s=>s.tweetId===id&&fresh(s.checkedAt,now))))return cached;
 const result=await reader();
 if(!Array.isArray(result)||result.length!==promotionIds.length||!promotionIds.every(id=>result.some(s=>s.tweetId===id&&Array.isArray(s.likes)&&Array.isArray(s.reposts))))fail('X_BOT_PARTICIPATION_SCAN_UNVERIFIED');
 // Preserve cursor exhaustion as part of the evidence. Positive membership is
 // usable from a partial list; absence is unknown until both lists exhaust.
 const observed=result.map(row=>({...row,serverListExhausted:row.serverListExhausted===true}));
 state.promotionObservations=observed;return observed;
}
export async function confirmFollower(user,state,{reader=handle=>withXReadContext(c=>c.lookupUser(handle)),now=Date.now()}={}) {
 const profile=await reader(user.handle);
 if(profile.userId!==user.id||profile.handle?.toLowerCase()!==user.handle.toLowerCase()){
  // The cached follower row is stale. Never let the old handle reach a writer;
  // force a new complete follower scan so a rename can be re-planned safely.
  delete state.followerSnapshot;
  fail('X_BOT_FOLLOWER_IDENTITY_CHANGED');
 }
 if(typeof profile.relation?.followsMe!=='boolean')fail('X_BOT_FOLLOWER_RELATIONSHIP_UNVERIFIED');
 state.relationships||={};
 state.relationships[user.id]={...state.relationships[user.id],handle:user.handle,followsMe:profile.relation.followsMe,following:profile.relation.following,pending:profile.relation.followRequestSent,checkedAt:new Date(now).toISOString()};
 return profile.relation.followsMe;
}
