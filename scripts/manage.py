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
        'CODEX_WECHAT_LOCAL_UI = "native-mcp-v2"',
        '[mcp_servers.wechat_bridge.tools.ask_user]', 'approval_mode = "approve"', END])

def desired_instructions():
    return '\n'.join([START, '# 个人微信普通问答与任务续办',
        '- 全局默认：每个主任务启动或恢复时自动应用 wechat-task-qa skill，无需用户再次提及微信。SessionStart 加载技能指引；微信 MCP 启动并维持本机服务，不能只依据 skill 文件存在就声称通道可用。',
        '- 用户要求：只在本机 Codex 主任务完成回复时发送简短微信摘要；子智能体完成不发通知、不分配任务号。普通问题同时允许微信和电脑回答，用户可回复选项编号或自定义文字，先收到的有效答案生效，不拦截电脑原生提问。',
        '- 普通问询使用 mcp__wechat_bridge__ask_user，每次调用只放一道题，给出稳定 id、question 和可选 options（label/description）。需要 1-3 题时独立调用，可并发等待。使用 GPT/Codex 原生问答界面，不用自绘弹窗；手机答后撤销对应原生卡，须实际验收关闭。管理页和原聊天真实用户答复也有效；旧 MCP 连接须重载新代码。',
        '- 用户明确授权原生问题框代填后，微信真实答案到达时按 wechat-task-qa 的原生回填步骤处理选项和自定义文字；核对同一道普通问题，提交后立即结束 computer-use 控制。安装不自动赋予代填权限，执行审批不得代填。',
        '- 微信回复约定：只有一题时直接回复 1、2 或自由文字；多题使用 1.1、2.2 或 2.这样改，点号前为消息中显示的稳定题号，点号后为选项或自定义答案。题号由桥接分配，答完不重排；无需长 Q 编号或“自定义：”前缀。详见技能 wechat-task-qa。',
        '- 微信 /clear 同时清空题号和任务号（包括艾莉丝任务），取消待答及未投递的编号提示词；旧编号入口失效，下一个问题和新分配任务均从 1 开始。保留工作聊天、编号历史和完成去重记录，已执行中的工作继续。只使用清理后新消息的编号；此命令不作为任务提示词，取消不当作答案。',
        '- 任务续办与题号分开：完成通知显示固定任务号；微信 /1 下一步要求 回到任务 1 的原聊天。只有一个可续办主任务时，可用 /继续任务 或 /下一步提示词；多个主任务可续办而未带号时，必须让用户选择，不能默认最新任务。/任务 查看列表。普通文字回答待答问题；已答题可用 5.补充内容 投递第 5 题原聊天，重复纯数字不当补充，不新建聊天或任务号。',
        '- 艾莉丝默认对话：微信 /艾莉丝 对话 进入连续聊天，/艾莉丝 文字 直接交谈；无待答题时的普通文字可续聊，待答题、题号补充和任务号指令优先按原路由处理。/艾莉丝 退出对话 结束连续聊天。只有 /艾莉丝 创建任务 具体要求 或 /新任务 具体要求 才新建独立工作；/艾莉丝 继续任务 任务号 下一步要求 只续办指定已登记聊天。intent=conversation 只直接回复，不调用任何工作创建工具，不分配任务号。',
        '- 不得将微信问答工具用于命令、文件、网络权限或其他执行授权审批；这些仍走 Codex 正常审批。',
        '- 若工具未提供或返回 unavailable、error、expired、cancelled，直接在 Codex 内询问，不能将故障当作用户回答。必要答案未收到前，不执行依赖它的工作。',
        '- 不要额外调用发送工具重复发送完成通知；由本地 Stop 钩子和桌面连接补充检测按原聊天与轮次去重。/ 提示词只用于指定原主任务的下一步工作，不是执行权限许可；桥接未连通时不能声称已经开始续办。', END])

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
& (Join-Path $taskRoot 'scripts\\service-task.ps1') -Action Start
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
        'python': sys.executable, 'installed_at': int(time.time()), 'backup': str(backup), 'notify_preserved': True,
        'previous_run_value': old_manifest.get('previous_run_value'), 'installed_run_value': old_manifest.get('installed_run_value')}
    atomic(target / 'installation.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    if read_text(config_path) != original_config or read_text(agents_path) != original_agents or json.loads(read_text(hooks_path) or '{}') != original_hooks:
        raise RuntimeError('Codex configuration changed during installation; retry after reviewing the new state')
    atomic(config_path, updated_config)
    atomic(agents_path, block_replace(original_agents, desired_instructions()))
    atomic(hooks_path, json.dumps(updated_hooks, ensure_ascii=False, indent=2) + '\n')
    if args.autostart:
        import winreg
        shell = str(Path(os.environ['SystemRoot']) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe')
        run_value = f'"{shell}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{target / "start.ps1"}"'
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            try: previous_run, _ = winreg.QueryValueEx(key, 'CodexWeChatBridge')
            except FileNotFoundError: previous_run = None
            if not manifest['installed_run_value']: manifest['previous_run_value'] = previous_run
            winreg.SetValueEx(key, 'CodexWeChatBridge', 0, winreg.REG_SZ, run_value)
            manifest['installed_run_value'] = run_value
        atomic(target / 'installation.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'installed': str(target), 'notify_preserved': True, 'hook_review': 'check Codex hooks/list or /hooks', 'autostart': args.autostart}, ensure_ascii=False))

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
        if not args.node or not Path(args.node).is_file(): parser.error('--node must point to an installed Node executable')
        install(args)
    else: uninstall(args)

if __name__ == '__main__': main()
