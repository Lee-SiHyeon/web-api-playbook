import { loadWebAuth } from './web-auth-provider.mjs';
export async function authenticateMyrealtrip(){return (await loadWebAuth('myrealtrip')).ensure();}
export async function checkMyrealtripSession(){return (await loadWebAuth('myrealtrip')).health();}
export async function myrealtripAuthStatus(){return (await loadWebAuth('myrealtrip')).status();}
export async function withMyrealtripSession(callback){return (await loadWebAuth('myrealtrip')).withSession(callback);}
