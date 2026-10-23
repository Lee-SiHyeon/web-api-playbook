import assert from "node:assert/strict";
import test from "node:test";
import { authorized, run, clientFrom } from "../src/http.js";
import { AdpickSdk } from "../src/sdk.js";
import sdkLink from "../api/sdk-link.js";

const token = "s".repeat(48);
function response() {
  return { statusCode: 0, headers: {}, body: "", setHeader(k,v) { this.headers[k]=v; }, end(v) { this.body=v; } };
}
test("authorization fails closed before provider dispatch and never trusts inbound Adpick cookies", async () => {
  const previous = process.env.ADPICK_SERVICE_TOKEN;
  try {
    delete process.env.ADPICK_SERVICE_TOKEN;
    let dispatched=false;
    const absent=response(); await run({headers:{}},absent,async()=>{dispatched=true;});
    assert.equal(absent.statusCode,503); assert.equal(dispatched,false);
    process.env.ADPICK_SERVICE_TOKEN=token;
    const denied=response(); await run({headers:{}},denied,async()=>{dispatched=true;});
    assert.equal(denied.statusCode,401); assert.equal(dispatched,false);
    const accepted=response(); await run({headers:{authorization:`Bearer ${token}`}},accepted,async()=>{dispatched=true;});
    assert.equal(dispatched,true);
    assert.equal(authorized({headers:{authorization:`Bearer ${token}x`}},token),false);
    assert.throws(() => clientFrom({headers:{cookie:'ADPICK_LOGIN_EVENT=attacker'}}), error => error.outcome === 'provider_missing');
  } finally { if(previous===undefined) delete process.env.ADPICK_SERVICE_TOKEN; else process.env.ADPICK_SERVICE_TOKEN=previous; }
});
test("link creation rejects GET before dispatch; unsafe and HTML provider responses are failures", async () => {
  const previous=process.env.ADPICK_SERVICE_TOKEN; process.env.ADPICK_SERVICE_TOKEN=token;
  try {
    const res=response(); await sdkLink({method:'GET',headers:{authorization:`Bearer ${token}`},url:'/api/sdk-link'},res);
    assert.equal(res.statusCode,405);
  } finally { if(previous===undefined) delete process.env.ADPICK_SERVICE_TOKEN; else process.env.ADPICK_SERVICE_TOKEN=previous; }
  for (const raw of ['<html>Login</html>',JSON.stringify({link:'https://deg.kr/path?apikey=SECRET'}),JSON.stringify({link:'https://deg.kr@evil.example/path'}),JSON.stringify({status:-1})]) {
    const sdk=new AdpickSdk({apiKey:'SECRET',fetchImpl:async()=>new Response(raw,{status:200})});
    await assert.rejects(sdk.profitLink({url:'https://shop.example/product/1'}), error=>!error.message.includes('SECRET'));
  }
});
