"""Surgical, reversible installation. No credentials or chat history are exported."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import tomllib

NAME = 'codex-wechat-bridge'
START = '# BEGIN CODEX_WECHAT_BRIDGE'
END = '# END CODEX_WECHAT_BRIDGE'
SOURCE = Path(__file__).resolve().parents[1]

def read_text(path):
    return path.read_text('utf-8-sig') if path.exists() else ''

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.wechat-tmp')
    temp.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))
    os.replace(temp, path)

def block_replace(text, block):
    pattern = re.compile(r'(?m)^' + re.escape(START) + r'\r?$[\s\S]*?^' + re.escape(END) + r'\r?$\n?')
    if text.count(START) > 1 or text.count(END) > 1 or text.count(START) != text.count(END):
        raise RuntimeError('Ambiguous bridge markers; refusing to overwrite')
    text = pattern.sub('', text).rstrip()
    return text + ('\n\n' if text else '') + block + ('\n' if block else '')

def fingerprint(data):
    return hashlib.sha256(data).hexdigest()

def make_hook(node, target):
    # No command substitution, no shell expansion, no untrusted text in commands.
    command = f'"{node}" "{target / "src" / "hook.mjs"}"'
    windows_command = f'& \'{str(node).replace(chr(39), chr(39)*2)}\' \'{str(target / "src" / "hook.mjs").replace(chr(39), chr(39)*2)}\''
    def group(matcher=None, timeout=3):
        result = {'hooks': [{'type': 'command', 'command': command, 'commandWindows': windows_command, 'timeout': timeout, 'statusMessage': 'Codex 微信桥接'}]}
        if matcher is not None: result['matcher'] = matcher
        return result
    return {'SessionStart': [group('startup|resume|clear|compact|fork')],
            'PreToolUse': [group(r'^(?:request_user_input|request_user_input_async|mcp__wechat_bridge__ask_user)$')],
            'Stop': [group()], 'Interrupt': [group(timeout=2)], 'SessionEnd': [group(timeout=2)]}

def own_handler(handler, target):
    command = str(handler.get('command', ''))
    return str(target / 'src' / 'hook.mjs') in command

def merge_hooks(original, additions, target):
    result = json.loads(json.dumps(original or {}))
    all_hooks = result.setdefault('hooks', {})
    for event, groups in list(all_hooks.items()):
        cleaned = []
        for group in groups:
            keep = [h for h in group.get('hooks', []) if not own_handler(h, target)]
            if keep: cleaned.append({**group, 'hooks': keep})
        if cleaned: all_hooks[event] = cleaned
        else: del all_hooks[event]
    for event, groups in additions.items(): all_hooks.setdefault(event, []).extend(groups)
    return result

def desired_config(node, target):
    # JSON quoted strings are valid TOML basic strings (no shell invocation).
    q = lambda value: json.dumps(str(value), ensure_ascii=False)
    return '\n'.join([START, '[mcp_servers.wechat_bridge]', f'command = {q(node)}',
        f'args = [{q(target / "src" / "mcp.mjs")}]', 'startup_timeout_sec = 10', 'tool_timeout_sec = 86400',
        'env_vars = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_APP_TOOLS_CALLER_HOST_ID"]',
        'enabled = true', 'required = false', '[mcp_servers.wechat_bridge.env]',
        f'CODEX_WECHAT_STATE = {q(target / "state")}',
        'CODEX_WECHAT_LOCAL_UI = "chat-opt-in-v3"',
        '[mcp_servers.wechat_bridge.tools.ask_user]', 'approval_mode = "approve"', END])

def desired_instructions():
    return '\n'.join([START,
        '# 按聊天选择微信提醒或原生问题卡',
        '- 默认 native：使用 Codex 原始问题选择卡，不发微信问询或完成通知。全局 skill、服务启动、其他聊天开启、分叉或 Dot 新建工作均不自动启用。',
        '- 用户在本聊天明确要求微信通知时，应用 wechat-task-qa，用 set_chat_mode(mode=wechat) 只开启当前聊天；要求关闭或恢复原始卡时设 native。按聊天 ID 保存并跨重启保持，其他聊天不受影响。',
        '- 微信模式：ask_user 每次一题、立即返回 pending；在当前对话醒目显示 local_question_markdown，不调用原生问题卡或 computer-use 回填。问题提醒和完成摘要通过艾莉丝已连接的微信桥接直接发送，不等待 Dot 推理；真正与艾莉丝聊天仍走 Dot。',
        '- 微信真实答案投递同一原聊天；电脑提示词中的真实答案用 answer_from_chat 记录。先收到的有效答案生效，不能代答。待答不是完成，取消和错误不是答案。手机单题可回 1/2/自由文字，多题用 题号.答案，已答题可用 题号.补充。',
        '- /clear 清空题号和任务号（包括艾莉丝），取消待答与未投递编号提示词，下一个问题及新任务从 1 开始；保留聊天、模式设置、历史、去重和已执行工作。',
        '- /任务 查看任务，/任务号 下一步要求 续办原聊天；只有一个可续办任务可省略号，多个不能默认最新。题号补充不新建任务。',
        '- /艾莉丝 对话 和 /艾莉丝 文字 默认直接交谈；普通文字仅在无待答时续聊。只有 /艾莉丝 创建任务 或 /新任务 才创建独立工作；/艾莉丝 继续任务 任务号 要求 只续办指定聊天。conversation 不调用工作创建工具。',
        '- 只有开启微信的本机主聊天完成时，由 Stop 与桌面检测去重通知；子智能体静默，不额外重复发送。微信故障时该聊天仍在电脑用醒目文字提问；默认 native 聊天照常用原始卡。',
        '- 执行权限审批、登录与安全设置始终走 Codex 原审批；微信模式和普通答案不是执行授权。旧 MCP 需重载新工具，不能调用旧版卡片流程。',
        END])

def write_launcher(target, node):
    launcher = f'''$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskNode = '{str(node).replace("'", "''")}'
$taskState = Join-Path $taskRoot 'state'
try {{
  $taskCfg = Get-Content -LiteralPath (Join-Path $taskState 'connection.json') -Raw | ConvertFrom-Json
  $taskToken = (Get-Content -LiteralPath (Join-Path $taskState 'control.token') -Raw).Trim()
  $null = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $taskCfg.port + "/api/status") -Headers @{{Authorization=("Bearer " + $taskToken)}} -TimeoutSec 2
  return
}} catch {{}}
& (Join-Path $taskRoot 'scripts\\run-service.ps1')
'''
    atomic(target / 'start.ps1', launcher)
    # The fragment never becomes an HTTP request or a server log entry.
    admin = '''$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
& (Join-Path $taskRoot 'start.ps1')
$taskState = Join-Path $taskRoot 'state'
for ($taskAttempt=0; $taskAttempt -lt 20; $taskAttempt++) {
  if (Test-Path -LiteralPath (Join-Path $taskState 'connection.json')) { break }
  Start-Sleep -Milliseconds 250
}
$taskCfg = Get-Content -LiteralPath (Join-Path $taskState 'connection.json') -Raw | ConvertFrom-Json
$taskToken = (Get-Content -LiteralPath (Join-Path $taskState 'control.token') -Raw).Trim()
$taskUrl = 'http://127.0.0.1:' + $taskCfg.port + '/#' + $taskToken
$taskEdge = Get-Command msedge.exe -ErrorAction SilentlyContinue
$taskCandidates = @('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
if ($taskEdge) { $taskEdgePath = $taskEdge.Source } else { $taskEdgePath = $taskCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1 }
if (-not $taskEdgePath) { throw 'Microsoft Edge was not found. No replacement browser was started.' }
Start-Process -FilePath $taskEdgePath -ArgumentList $taskUrl -WindowStyle Normal
'''
    atomic(target / 'open-manager.ps1', admin)

def install(args):
    home = Path(args.codex_home).resolve(); target = home / NAME
    config_path = home / 'config.toml'; agents_path = home / 'AGENTS.md'; hooks_path = home / 'hooks.json'
    original_config = read_text(config_path); original = tomllib.loads(original_config)
    if 'wechat_bridge' in original.get('mcp_servers', {}) and START not in original_config:
        raise RuntimeError('An unrelated wechat_bridge MCP entry already exists')
    if target.exists() and not (target / 'installation.json').exists():
        raise RuntimeError('Unmanaged installation directory exists; refusing to overwrite')
    old_manifest = json.loads(read_text(target / 'installation.json') or '{}')
    original_agents = read_text(agents_path); original_hooks = json.loads(read_text(hooks_path) or '{}')
    updated_config = block_replace(original_config, desired_config(args.node, target))
    parsed = tomllib.loads(updated_config)
    if parsed.get('notify') != original.get('notify'): raise RuntimeError('Existing notification route changed')
    # Only the new server may differ; preserve existing sandbox, auth, model, hooks and servers.
    compare = json.loads(json.dumps(parsed)); compare.get('mcp_servers', {}).pop('wechat_bridge', None)
    previous = json.loads(json.dumps(original)); previous.get('mcp_servers', {}).pop('wechat_bridge', None)
    if not compare.get('mcp_servers'): compare.pop('mcp_servers', None)
    if not previous.get('mcp_servers'): previous.pop('mcp_servers', None)
    if compare != previous: raise RuntimeError('Unrelated Codex configuration would change')
    additions = make_hook(args.node, target)
    updated_hooks = merge_hooks(original_hooks, additions, target)
    target.mkdir(parents=True, exist_ok=True)
    backup = target / 'backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + str(time.time_ns() % 1_000_000_000)); backup.mkdir(parents=True)
    for p in [config_path, agents_path, hooks_path]:
        if p.exists(): shutil.copy2(p, backup / p.name)
    for dirname in ['src', 'scripts', 'vendor', 'ui']:
        shutil.copytree(SOURCE / dirname, target / dirname, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for filename in ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'DOT_SETUP.md']:
        if (SOURCE / filename).exists(): shutil.copy2(SOURCE / filename, target / filename)
    (target / 'state').mkdir(exist_ok=True)
    (target / 'state' / 'integration-disabled').unlink(missing_ok=True)
    skill_source = next((p for p in [SOURCE / 'skills' / 'wechat-task-qa' / 'SKILL.md', SOURCE.parent / 'wechat-task-qa' / 'SKILL.md'] if p.is_file()), None)
    if skill_source:
        skill_target = home / 'skills' / 'wechat-task-qa' / 'SKILL.md'
        if skill_target.exists(): shutil.copy2(skill_target, backup / 'wechat-task-qa-SKILL.md')
        atomic(skill_target, skill_source.read_bytes())
    write_launcher(target, args.node)
    manifest = {'owner': NAME, 'version': json.loads((SOURCE / 'package.json').read_text('utf-8'))['version'], 'source': str(SOURCE), 'target': str(target), 'node': str(args.node),
        'python': sys.executable, 'installed_at': int(time.time()), 'backup': str(backup), 'notify_preserved': True, 'startup': 'codex_mcp_only',
        'previous_run_value': old_manifest.get('previous_run_value'), 'installed_run_value': old_manifest.get('installed_run_value')}
    atomic(target / 'installation.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    if read_text(config_path) != original_config or read_text(agents_path) != original_agents or json.loads(read_text(hooks_path) or '{}') != original_hooks:
        raise RuntimeError('Codex configuration changed during installation; retry after reviewing the new state')
    atomic(config_path, updated_config)
    atomic(agents_path, block_replace(original_agents, desired_instructions()))
    atomic(hooks_path, json.dumps(updated_hooks, ensure_ascii=False, indent=2) + '\n')
    if os.name == 'nt' and manifest.get('installed_run_value'):
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run', 0, winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE) as key:
            try: previous_run, _ = winreg.QueryValueEx(key, 'CodexWeChatBridge')
            except FileNotFoundError: previous_run = None
            if previous_run == manifest['installed_run_value']: winreg.DeleteValue(key, 'CodexWeChatBridge')
            elif previous_run is not None: raise RuntimeError('Startup value was modified by another owner; review before removing it')
        manifest['installed_run_value'] = None
        atomic(target / 'installation.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'installed': str(target), 'notify_preserved': True, 'hook_review': 'check Codex hooks/list or /hooks', 'autostart': False, 'startup':'codex_mcp_only'}, ensure_ascii=False))

def uninstall(args):
    home = Path(args.codex_home).resolve(); target = home / NAME
    manifest = json.loads(read_text(target / 'installation.json') or '{}')
    if manifest.get('owner') != NAME: raise RuntimeError('No matching managed installation')
    atomic(target / 'state' / 'integration-disabled', 'Explicitly uninstalled\n')
    config = home / 'config.toml'; agents = home / 'AGENTS.md'; hooks = home / 'hooks.json'
    updated = block_replace(read_text(config), '')
    tomllib.loads(updated)
    atomic(config, updated); atomic(agents, block_replace(read_text(agents), ''))
    atomic(hooks, json.dumps(merge_hooks(json.loads(read_text(hooks) or '{}'), {}, target), ensure_ascii=False, indent=2) + '\n')
    if os.name == 'nt' and manifest.get('installed_run_value'):
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run', 0, winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE) as key:
            try: value, _ = winreg.QueryValueEx(key, 'CodexWeChatBridge')
            except FileNotFoundError: value = None
            if value == manifest['installed_run_value']:
                if manifest.get('previous_run_value') is None: winreg.DeleteValue(key, 'CodexWeChatBridge')
                else: winreg.SetValueEx(key, 'CodexWeChatBridge', 0, winreg.REG_SZ, manifest['previous_run_value'])
    print(json.dumps({'integration_removed': True, 'state_preserved': str(target / 'state'), 'existing_notify_untouched': True}))

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['install','uninstall'])
    parser.add_argument('--codex-home', required=True); parser.add_argument('--node'); parser.add_argument('--autostart', action='store_true')
    args = parser.parse_args()
    if args.action == 'install':
        if args.autostart: parser.error('Windows startup is no longer used; start Codex to connect in the background')
        if not args.node or not Path(args.node).is_file(): parser.error('--node must point to an installed Node executable')
        install(args)
    else: uninstall(args)

if __name__ == '__main__': main()
