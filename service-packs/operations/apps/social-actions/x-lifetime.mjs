export function workerDeadline({start=Date.now(),indefinite=false,burstExpiresAt}={}) {
 if(burstExpiresAt)return Date.parse(burstExpiresAt);
 return indefinite?Infinity:start+86400000;
}
