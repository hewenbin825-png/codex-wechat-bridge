let token = location.hash.slice(1) || sessionStorage.getItem('bridgeToken') || '';
if (location.hash) history.replaceState(null, '', location.pathname);
const el = id => document.getElementById(id);
let qrSession = '', qrObject = '', working = false;
const displayTime = n => n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '尚无';
async function api(route, body) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || `HTTP ${response.status}`); }
  return response;
}
async function refresh() {
  if (!token || working) return;
  try {
    const state = await (await api('/api/status')).json();
    sessionStorage.setItem('bridgeToken', token); el('unlock').hidden = true; el('content').hidden = false;
    el('badge').textContent = state.paused ? '已暂停' : state.needs_login ? '需要重新绑定' : state.ready ? '微信通道可用' : state.paired ? '等待微信激活' : '尚未绑定';
    el('explain').textContent = state.needs_login ? '微信登录已失效，请重新扫码。' : state.ready ? '可以发送通知，并接收普通问题的答案。' : state.paired ? '扫码绑定已完成。请在手机微信给 ClawBot 发送“激活”。' : '点击绑定，使用自己的手机微信扫码确认。';
    el('lastIn').textContent = displayTime(state.last_inbound); el('lastOut').textContent = displayTime(state.last_sent);
    el('pause').textContent = state.paused ? '恢复通知' : '暂停通知'; el('pause').dataset.paused = String(state.paused);
    el('test').disabled = !state.ready;
    el('pending').replaceChildren();
    for (const r of state.pending) for (const q of r.questions.filter(q => !q.answered)) {
      const node = document.createElement('div'); node.className = 'question';
      node.textContent = `第${q.number}题｜${r.title || 'Codex'}\n${q.question}\n${q.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n到期：${displayTime(r.expires)}`;
      el('pending').append(node);
    }
    if (!el('pending').childNodes.length) el('pending').textContent = '当前没有待答问题。';
    el('stats').textContent = state.outbox.map(x => `${x.state}: ${x.count}`).join('   ');
    el('error').textContent = state.error ? `最近连接状态：${state.error.code}。未把发送失败算作成功。` : '';
    const login = state.login;
    el('verify').hidden = login?.status !== 'need_verifycode';
    const labels = { wait: '请使用自己的手机微信扫描二维码，并在手机确认。', scaned: '已扫码，正在等待微信确认。', need_verifycode: '微信要求验证，请在下方输入手机显示的数字。', confirmed: '扫码绑定完成，请在微信发送“激活”。', expired: '二维码已过期，点击绑定重新生成。', failed: '绑定未完成，请重试。', verify_code_blocked: '验证次数超限，请稍后重新生成二维码。' };
    el('loginText').textContent = login ? labels[login.status] || '正在连接微信…' : '';
    if (login && ['wait','scaned','need_verifycode','scaned_but_redirect'].includes(login.status) && qrSession !== login.id) {
      const blob = await (await api('/api/login/qr.svg')).blob();
      if (qrObject) URL.revokeObjectURL(qrObject); qrObject = URL.createObjectURL(blob);
      const image = document.createElement('img'); image.src = qrObject; image.alt = '使用手机微信扫描以绑定 Codex 通道';
      el('qr').replaceChildren(image); qrSession = login.id;
    } else if (login && ['confirmed','expired','failed','verify_code_blocked'].includes(login.status)) el('qr').replaceChildren();
  } catch (e) { el('error').textContent = e.message; if (el('content').hidden) { el('unlock').append(el('error')); } }
}
async function action(route, body = {}) {
  working = true;
  try { await api(route, body); el('error').textContent = ''; }
  catch (e) { el('error').textContent = e.message; }
  finally { working = false; await refresh(); }
}
el('unlockButton').onclick = () => { token = el('token').value.trim(); refresh(); };
el('bind').onclick = () => action('/api/login/start');
el('verifyButton').onclick = () => action('/api/login/verify', { code: el('verifyCode').value.trim() });
el('test').onclick = () => action('/api/test-notification');
el('pause').onclick = () => action('/api/settings', { paused: el('pause').dataset.paused !== 'true' });
el('refresh').onclick = refresh;
refresh(); setInterval(refresh, 2500);
