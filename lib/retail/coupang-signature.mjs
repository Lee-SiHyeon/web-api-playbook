import { createHash, randomUUID } from 'node:crypto';

// Observed first-party sec-g/1.2.9 signing calculation. No SDK execution, DOM,
// navigator emulation, network, or fingerprint fabrication. c4/c6 are opaque
// context from the authorized bootstrap and are not renewed by this module.
export const SIGNATURE_SOURCE = Object.freeze({
  url: 'https://assets.coupangcdn.com/customjs/sec-g/1.2.9/sec.min.js',
  sha256: '89e49f470add7ac804a7fc1696324a0841bc3403c1d78c99ed9304588edaa1dc',
  sdkVersion: '1.2.9', signatureVersion: '1.1.0', refreshIntervalMs: 60000, cookieLifetimeMs: 300000,
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
const keys = ['c1','c2','c3','c4','c5','c6','c7','c8','c9','s1','s2'];
const sha = bytes => new Uint8Array(createHash('sha256').update(bytes).digest());
const utf8 = value => new TextEncoder().encode(value);
const canonical = fields => keys.slice(0,8).map(k => `${k}=${fields[k]}`).join('&');

function byteTransform(bytes, operation) {
  const length = bytes.length;
  let previous, temp, a = 1, b = 1;
  const mask = [171,205,239,18,52,86,120,144,31,46,61,76,91,106,121,136,1,16,35,50,69,84,103,118,137,152,160,177,194,211,228,245];
  if (operation === 3) { [bytes[0],bytes[length-1]] = [bytes[length-1],bytes[0]]; return; }
  if (operation === 7) {
    for (let i=0;i<length-1;i+=2) { [bytes[i],bytes[i+1]]=[bytes[i+1],bytes[i]]; if (!bytes[i]) bytes[i]=1; }
    return;
  }
  previous=bytes[0];
  for (let i=0;i<length;i++) {
    temp=bytes[i];
    switch(operation) {
      case 0: bytes[i]=~temp & 255; break;
      case 1: bytes[i]=(temp ^ (i & 255)) & 255; break;
      case 2: bytes[i]=((temp<<1)|(temp>>7)) & 255; break;
      case 4: if(i===0)continue; bytes[i]=(temp+previous)&255; previous=temp; break;
      case 5: bytes[i]=((temp<<4)|(temp>>4))&255; break;
      case 6: { let add=1;if(i>1){add=(a+b)&255;a=b;b=add;}bytes[i]=(temp+add)&255;break; }
      case 8: bytes[i]=(temp^mask[i%mask.length])&255; break;
      case 9: if(i===0)continue;bytes[i]=(temp^previous)&255;previous=temp;break;
      default: fail('COUPANG_SIGNATURE_OPERATION');
    }
    if(bytes[i]===0)bytes[i]=1;
  }
}

function signedTransform(bytes, operation) {
  const values = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), n=values.length;
  if(operation===0 || operation===1) {
    const width=operation===0?3:2, fill=operation===0?8:6, before=new Int8Array(values);
    for(let i=0;i<n;i++) values[i]=i+width<=n ? Math.max(...before.subarray(i,i+width)) : fill;
  } else if(operation===2) {
    let pivot=n-2;while(pivot>=0 && values[pivot]>=values[pivot+1])pivot--;
    if(pivot>=0){let j=n-1;while(values[pivot]>=values[j])j--;[values[pivot],values[j]]=[values[j],values[pivot]];}
    for(let l=pivot+1,r=n-1;l<r;l++,r--)[values[l],values[r]]=[values[r],values[l]];
  } else if(operation===3) {
    const result=new Int8Array(n).fill(8), stack=[];
    for(let i=0;i<2*n-1;i++){const at=i%n;while(stack.length && values[stack.at(-1)]<values[at])result[stack.pop()]=values[at];stack.push(at);}
    values.set(result);
  } else if(operation===4) {
    const result=new Int8Array(n).fill(6), first=[], second=[];
    for(let i=0;i<n;i++) {
      while(second.length && values[second.at(-1)]<values[i])result[second.pop()]=values[i];
      let k=first.length-1;while(k>=0 && values[first[k]]<values[i])k--;
      second.push(...first.splice(k+1));first.push(i);
    }
    values.set(result);
  } else fail('COUPANG_SIGNATURE_OPERATION');
}

function crc32(...arrays) {
  let crc=0xffffffff;
  for(const bytes of arrays)for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}
  return (crc^0xffffffff)>>>0;
}
function timedHash(text,time) {const bytes=utf8(text);if(time&1)bytes.reverse();return sha(bytes);}
function xorUnlessEqual(bytes,seed){for(let i=0;i<bytes.length;i++){const key=seed[i%seed.length];if(bytes[i]!==key)bytes[i]^=key;}}

export function calculateCoupangSignatureDigest(payload, query, time) {
  if(typeof payload!=='string'||!payload||typeof query!=='string'||query.length>8192||!Number.isSafeInteger(time)||time<1000)
    fail('COUPANG_SIGNATURE_INPUT');
  const ts=String(time), left=timedHash(payload,time), right=timedHash(query,time);
  xorUnlessEqual(left,[left[0]]);xorUnlessEqual(left,utf8(ts.slice(-4)));
  for(const op of [6,1,7,0,4,3,2,5,8,9])byteTransform(left,op);
  for(const op of [0,1,4,2,3])signedTransform(left,op);
  xorUnlessEqual(right,[right[31]]);
  for(const op of [2,4,8,5,9,6,3,1,0,7])byteTransform(right,op);
  for(const op of [2,3,0,4,1])signedTransform(right,op);
  const word=((right[0]<<24)|(right[1]<<16)|(right[2]<<8)|right[3])>>>0;
  const combined=(utf8(payload).length^word^ts.length)>>>0, checksum=crc32(left,right);
  return Buffer.from(sha(Buffer.concat([left,Buffer.from([(combined>>8)&255,combined&255]),
    Buffer.from([checksum&255,(checksum>>8)&255,(checksum>>16)&255,(checksum>>24)&255]),right]))).toString('base64');
}

export function parseCoupangSignature(value, { verify=true }={}) {
  if(typeof value!=='string'||value.length>12000||!value.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail('COUPANG_SIGNATURE_FORMAT');
  const decoded=Buffer.from(value,'base64').toString('utf8');
  if(Buffer.from(decoded).toString('base64')!==value)fail('COUPANG_SIGNATURE_FORMAT');
  const parts=decoded.split('&');
  if(parts.length!==keys.length||parts.some((s,i)=>!s.startsWith(keys[i]+'=')))fail('COUPANG_SIGNATURE_FORMAT');
  const fields=Object.fromEntries(parts.map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));
  if(fields.c1!=='3'||fields.c2!==SIGNATURE_SOURCE.sdkVersion||fields.c5!=='com.coupang.web'||fields.s2!==SIGNATURE_SOURCE.signatureVersion
    ||!/^\d{13}$/.test(fields.c3)||!/^\d{1,10}$/.test(fields.c9)||Number(fields.c9)<1||fields.c7!==''
    ||!/^[a-f0-9]{32}$/.test(fields.c8)||!fields.c4||fields.c4.length>4096||!/^[A-Za-z0-9+/=]+$/.test(fields.c4)
    ||!/^[A-Za-z0-9.]{1,64}$/.test(fields.c6)||!/^[A-Za-z0-9+/]{43}=$/.test(fields.s1))fail('COUPANG_SIGNATURE_CONTEXT');
  if(verify && calculateCoupangSignatureDigest('global',canonical(fields),Number(fields.c3))!==fields.s1)fail('COUPANG_SIGNATURE_MISMATCH');
  return fields;
}

export function renewCoupangSignature(value, { now=Date.now(), nonce=randomUUID().replaceAll('-','') }={}) {
  const fields=parseCoupangSignature(value);
  if(!Number.isSafeInteger(now)||String(now).length!==13||!Number.isSafeInteger(Number(fields.c9)+1)||!/^[a-f0-9]{32}$/.test(nonce))fail('COUPANG_SIGNATURE_INPUT');
  const next={...fields,c3:String(now),c8:nonce,c9:String(Number(fields.c9)+1)};
  const query=canonical(next), digest=calculateCoupangSignatureDigest('global',query,now);
  const renewed=Buffer.from(`${query}&c9=${next.c9}&s1=${digest}&s2=${next.s2}`).toString('base64');
  return { value:renewed,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+SIGNATURE_SOURCE.cookieLifetimeMs).toISOString(),
    opaqueContextPreserved:next.c4===fields.c4 && next.c6===fields.c6,contextRenewed:false };
}
