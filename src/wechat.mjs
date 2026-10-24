import crypto from 'node:crypto';

export const API_BASE = 'https://ilinkai.weixin.qq.com';
const INFO = { channel_version: '2.4.8', bot_agent: 'CodexWeChatBridge/0.1.0' };
export function trustedBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(/(^|\.)weixin\.qq\.com$/i.test(url.hostname)) || url.pathname !== '/' || url.search || url.hash) throw Object.assign(new Error('Untrusted WeChat API host'), { code: 'UNTRUSTED_API_HOST' });
  return url.origin;
}
// Preserve uint64 message identifiers before JSON.parse can round them. Strings,
// including strings containing escaped JSON, are never rewritten.
export function parseWireJson(input) {
  let out = '', i = 0;
  while (i < input.length) {
    if (input[i] !== '"') { out += input[i++]; continue; }
    const start = i++;
    while (i < input.length) { if (input[i] === '\\') { i += 2; continue; } if (input[i++] === '"') break; }
    const token = input.slice(start, i); out += token;
    let p = i; while (/\s/.test(input[p] || '') && p < input.length) p++;
    if (input[p] !== ':' || !['message_id', 'msg_id', 'svr_id'].includes(JSON.parse(token))) continue;
    p++; while (/\s/.test(input[p] || '') && p < input.length) p++;
    const m = /^\d+/.exec(input.slice(p));
    if (m && /^\s*[,}\]]/.test(input.slice(p + m[0].length))) { out += input.slice(i, p) + JSON.stringify(m[0]); i = p + m[0].length; }
  }
  return JSON.parse(out);
}
export class WeChatApi {
  constructor({ fetchImpl = fetch, base = API_BASE } = {}) { this.fetch = fetchImpl; this.base = trustedBase(base); }
  async call(endpoint, { base = this.base, token, body, timeout = 35000, signal, get = false, query = '' } = {}) {
    base = trustedBase(base);
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x00020408) };
    if (!get) {
      headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(crypto.randomBytes(4).readUInt32BE())).toString('base64');
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let response;
    try {
      response = await this.fetch(`${base}/ilink/bot/${endpoint}${query}`, { method: get ? 'GET' : 'POST', headers,
        body: get ? undefined : JSON.stringify(token ? { ...body, base_info: INFO } : body), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    } catch (e) { throw Object.assign(new Error('WeChat network request did not complete'), { code: e.name === 'TimeoutError' ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR', uncertain: true }); }
    if (!response.ok) throw Object.assign(new Error('WeChat HTTP error'), { code: `HTTP_${response.status}`, status: response.status, deferred: response.status === 429 });
    const raw = await response.text();
    if (raw.length > 4194304) throw Object.assign(new Error('Oversized WeChat response'), { code: 'RESPONSE_TOO_LARGE', uncertain: true });
    let result;
    try { result = parseWireJson(raw); } catch { throw Object.assign(new Error('Invalid WeChat response'), { code: 'INVALID_JSON', uncertain: true }); }
    const failure = [result.ret, result.errcode].find(x => x !== undefined && x !== null && Number(x) !== 0);
    if (failure !== undefined) {
      // A generic rejection or rate limit does not prove the context is expired.
      // Keep server text out of diagnostics; retain only this narrow classification.
      const contextInvalid = /context[_\s-]?token|上下文(?:令牌|凭证)/i.test(String(result.errmsg || ''))
        && /expired|invalid|expire|过期|失效|无效/i.test(String(result.errmsg || ''));
      throw Object.assign(new Error('WeChat rejected request'), { code: `ILINK_${failure}`, deferred: true, expired: Number(failure) === -14, contextInvalid });
    }
    return result;
  }
  startLogin(localTokens = []) { return this.call('get_bot_qrcode', { body: { local_token_list: localTokens.slice(0, 10) }, query: '?bot_type=3' }); }
  pollLogin(qrcode, base = this.base, verifyCode, signal) {
    return this.call('get_qrcode_status', { base, get: true, query: `?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`, signal });
  }
  updates(creds, cursor = '', signal) { return this.call('getupdates', { base: creds.base, token: creds.token, body: { get_updates_buf: cursor }, timeout: 45000, signal }); }
  send(creds, text, clientId, signal) {
    if (!creds.contextToken) throw Object.assign(new Error('Ask the bound user to activate the channel'), { code: 'ACTIVATION_REQUIRED', deferred: true });
    return this.call('sendmessage', { base: creds.base, token: creds.token, signal, body: { msg: { from_user_id: '', to_user_id: creds.peer, client_id: clientId,
      message_type: 2, message_state: 2, context_token: creds.contextToken, item_list: [{ type: 1, text_item: { text } }] } } });
  }
}
