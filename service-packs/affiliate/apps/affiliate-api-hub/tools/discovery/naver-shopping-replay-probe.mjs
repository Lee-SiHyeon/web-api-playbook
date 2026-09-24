import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const allowed = new Map([
  ['/ns/v1/search/paged-composite-cards', 'GET'],
  ['/ns/v1/channel-products/by-ids', 'GET'],
  ['/ns/v1/product-benefits/list', 'POST'],
]);

export function runShoppingReplay(envelope, { nodeExecutable, spawnImpl = spawn } = {}) {
  const url = new URL(envelope.url);
  if (url.origin !== 'https://search.shopping.naver.com' || allowed.get(url.pathname) !== envelope.method)
    throw Error('OPERATION_NOT_OBSERVED');
  const data = JSON.stringify(envelope);
  if (Buffer.byteLength(data) > 262144) throw Error('INPUT_TOO_LARGE');
  const secrets = Object.entries(envelope.headers ?? {}).filter(([k]) => /cookie|token|session/i.test(k)).map(([,v]) => v).filter(Boolean);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(nodeExecutable, [fileURLToPath(import.meta.url), '--worker'], {
      shell: false, windowsHide: true, env: {}, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = ''; let failure;
    const timer = setTimeout(() => { failure = 'RUNNER_TIMEOUT'; child.kill(); }, 40000);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 65536) { failure = 'OUTPUT_LIMIT'; child.kill(); } });
    child.stdin.on('error', () => { failure ||= 'STDIN_FAILED'; });
    child.once('error', () => { failure = 'SPAWN_FAILED'; });
    child.once('close', () => {
      clearTimeout(timer);
      try {
        if (failure || secrets.some(s => output.includes(s))) throw Error();
        resolve(JSON.parse(output));
      } catch { reject(Error(failure || 'RUNNER_FAILED')); }
      finally { output = ''; secrets.fill(''); }
    });
    child.stdin.end(data);
  });
}

if (typeof process !== 'undefined' && process.argv.includes('--worker')) {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 262144) throw Error('INPUT_TOO_LARGE'); }
  const request = JSON.parse(input); input = '';
  const url = new URL(request.url);
  if (url.origin !== 'https://search.shopping.naver.com' || allowed.get(url.pathname) !== request.method) throw Error('OPERATION_NOT_OBSERVED');
  try {
    const response = request.transport === 'http2'
      ? await http2Request(url, request)
      : await fetch(url, { method: request.method, headers: request.headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    const text = await response.text();
    const result = { checkedAt: new Date().toISOString(), path: url.pathname, status: response.status, contentType: response.headers.get('content-type'), bytes: Buffer.byteLength(text), mode: request.mode };
    if (response.ok && result.contentType?.includes('json')) {
      const parsed = JSON.parse(text); result.rootKeys = Object.keys(parsed);
      const data = parsed.data;
      result.dataKeys = Array.isArray(data) ? Object.keys(data[0] ?? {}) : Object.keys(data ?? {});
      if (url.pathname.includes('paged-composite-cards')) {
        result.valid = Array.isArray(data?.data) && typeof data.total === 'number' && typeof data.hasMore === 'boolean';
        result.cardCount = data?.data?.length; result.total = data?.total; result.hasMore = data?.hasMore; result.cursor = data?.cursor;
        result.products = data?.data?.filter(c => c.card?.product).slice(0,3).map(c => {
          const p = c.card.product; return { keys: Object.keys(p), productId: p.productId, nvMid: p.nvMid, title: p.productName, price: p.price, salePrice: p.salePrice };
        });
      } else if (url.pathname.includes('channel-products')) {
        result.valid = Array.isArray(data) && data.every(p => p.channelProductId && typeof p.salePrice === 'number');
        result.productCount = data?.length;
        result.products = data?.slice(0,3).map(p => ({id:p.channelProductId,title:p.productName,price:p.salePrice,discounted:p.discountedSalePrice,soldout:p.soldout}));
      } else { result.valid = !!data && typeof data === 'object' && !Array.isArray(data); result.productCount = Object.keys(data ?? {}).length; }
    } else { result.valid = false; result.responseTitle = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.slice(0,100); result.challengeText = /captcha|비정상|접근.*제한|일시.*제한/i.test(text); }
    console.log(JSON.stringify(result));
  } catch (error) { console.log(JSON.stringify({ok:false,code:error.name==='TimeoutError'?'TIMEOUT':'TRANSPORT_OR_SCHEMA_ERROR'})); }
  finally { request.headers = {}; request.body = ''; }
}

async function http2Request(url, request) {
  const { connect } = await import('node:http2');
  const { brotliDecompressSync, gunzipSync, inflateSync } = await import('node:zlib');
  return new Promise((resolve,reject) => {
    const session = connect(url.origin); let finished = false;
    const timer = setTimeout(() => fail(Error('TIMEOUT')), 25000);
    const fail = error => { if (finished) return; finished = true; clearTimeout(timer); session.destroy(); reject(error); };
    session.on('error',fail);
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([k]) => !['connection','host','transfer-encoding'].includes(k.toLowerCase())));
    const stream = session.request({ ...headers, ':method':request.method, ':path':url.pathname+url.search });
    let responseHeaders; const chunks=[]; let bytes=0;
    stream.on('response',h=>{responseHeaders=h;});
    stream.on('error',fail);
    stream.on('data',c=>{bytes+=c.length;if(bytes>4*1024*1024)fail(Error('SIZE'));else chunks.push(c);});
    stream.on('end',()=>{
      if(finished)return;
      try{let data=Buffer.concat(chunks);const enc=responseHeaders['content-encoding'];if(enc==='gzip')data=gunzipSync(data);else if(enc==='br')data=brotliDecompressSync(data);else if(enc==='deflate')data=inflateSync(data);
        const status=responseHeaders[':status'];finished=true;clearTimeout(timer);session.close();resolve({status,ok:status>=200&&status<300,headers:{get:k=>responseHeaders[k]},text:async()=>data.toString('utf8')});
      }catch(error){fail(error);}
    });
    stream.end(request.body);
  });
}
