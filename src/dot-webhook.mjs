import crypto from 'node:crypto';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const openAIHost=host=>['openai.com','chatgpt.com'].some(d=>host===d||host.endsWith('.'+d));
const fakeProxyAddress=address=>net.isIP(address)===4&&/^198\.(18|19)\./.test(address);

async function publicDnsAddresses(host) {
  // Query only the public callback hostname. No event data, key, or URL path is sent.
  const response=await fetch('https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(host)+'&type=A',{
    headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(8000)
  });
  if(!response.ok)throw new Error('Public callback DNS lookup failed');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();throw new Error('Public callback DNS response too large');}chunks.push(Buffer.from(part.value));}
  }finally{reader.releaseLock();}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(data.Status!==0||data.Question?.[0]?.name?.replace(/\.$/,'').toLowerCase()!==host)throw new Error('Public callback DNS response mismatch');
  return (data.Answer||[]).filter(r=>r.type===1&&net.isIP(r.data)===4).map(r=>({address:r.data,family:4}));
}

export async function resolveCallbackAddresses(host,{lookup=name=>dns.lookup(name,{all:true,verbatim:true}),doh=publicDnsAddresses}={}) {
  if(!openAIHost(host))throw new Error('OpenAI callback host required');
  const addresses=await lookup(host);
  if(addresses.length&&addresses.every(x=>publicAddress(x.address)))return addresses;
  // A known Fake-IP proxy range is never accepted as a callback destination.
  // Replace it with independently resolved public addresses, then validate again.
  if(addresses.length&&addresses.every(x=>fakeProxyAddress(x.address))){
    const resolved=await doh(host);
    if(resolved.length&&resolved.every(x=>publicAddress(x.address)))return resolved;
  }
  throw new Error('Callback address is not public');
}

export function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return ![0,10,127].includes(a) && a < 224 && !(a===100&&b>=64&&b<=127)
      && !(a===169&&b===254) && !(a===172&&b>=16&&b<=31) && !(a===192&&(b===168||b===0||b===2))
      && !(a===198&&(b===18||b===19||(b===51&&c===100))) && !(a===203&&b===0&&c===113);
  }
  if (net.isIP(address) !== 6) return false;
  // Restrict to IPv6 global unicast. Reject special-use, mapped and tunnelling ranges.
  const value = address.toLowerCase();
  return /^[23][0-9a-f]{0,3}:/.test(value) && !value.startsWith('2001:') && !value.startsWith('2002:') && !value.startsWith('3fff:');
}
export function callbackUrl(raw) {
  let url; try {url=new URL(raw);} catch {throw new Error('Invalid callback URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||net.isIP(url.hostname)||!url.hostname.includes('.'))throw new Error('Public HTTPS callback required');
  // This private connector only accepts callbacks hosted by OpenAI. A new official
  // hostname must be reviewed explicitly; arbitrary destinations are not a tool.
  if(!openAIHost(url.hostname))throw new Error('OpenAI callback host required');
  return url;
}
export function webhookKey(secret) {
  if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw new Error('Invalid webhook signing key');
  const key=Buffer.from(secret.slice(6),'base64');
  if(key.length<24||key.length>64||key.toString('base64').replace(/=+$/,'')!==secret.slice(6).replace(/=+$/,''))throw new Error('Invalid webhook signing key');
  return key;
}
export function signedHeaders(secret,id,body,at=Date.now(),subscription='') {
  const timestamp=String(Math.floor(at/1000));
  const signature=crypto.createHmac('sha256',webhookKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`,'X-MCP-Subscription-Id':subscription};
}
export class WebhookClient {
  constructor({lookup=resolveCallbackAddresses,request=https.request}={}) {Object.assign(this,{lookup,request});}
  async post(raw,body,headers) {
    const url=callbackUrl(raw), addresses=await this.lookup(url.hostname);
    if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('Callback address is not public');
    // Pin the validated lookup result for this connection, retaining hostname for
    // certificate validation and SNI. No redirect or ambient proxy is followed.
    const lookup=(hostname,options,cb)=>{
      if(hostname!==url.hostname)return cb(new Error('Callback host changed'));
      return options?.all ? cb(null,addresses) : cb(null,addresses[0].address,addresses[0].family);
    };
    return new Promise((resolve,reject)=>{
      const req=this.request(url,{method:'POST',agent:false,lookup,servername:url.hostname,headers:{...headers,'Content-Length':Buffer.byteLength(body)},timeout:10000},res=>{
        let text='',size=0;res.on('data',b=>{size+=b.length;if(size>8192)res.destroy(new Error('Callback response too large'));else text+=b.toString('utf8');});
        res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:text}));
      });
      req.on('timeout',()=>req.destroy(new Error('Callback timeout')));req.on('error',reject);req.end(body);
    });
  }
}
