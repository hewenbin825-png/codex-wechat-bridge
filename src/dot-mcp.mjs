import readline from 'node:readline';
import {createBootstrap} from './bootstrap.mjs';

// Private stdio target for Secure MCP Tunnel. The inherited, owner-restricted
// tunnel is the caller boundary. Never register this target in a shared workspace
// or expose its private HTTP control endpoint publicly.
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const api=createBootstrap().request;
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',async line=>{
  let message;
  try {
    if(Buffer.byteLength(line)>65536)throw new Error('Request too large');
    message=JSON.parse(line);
    if(message.id===undefined)return;
    const value=await api('/api/dot/rpc',message,{timeout:25000});if(value)send(value);
  }catch{send({jsonrpc:'2.0',id:message?.id??null,error:{code:-32000,message:'Local Dot bridge unavailable; no work was dispatched.'}});}
});
