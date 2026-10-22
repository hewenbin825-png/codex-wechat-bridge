param([string]$CodexHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'))
$ErrorActionPreference = 'Stop'
$taskTarget = Join-Path $CodexHome 'codex-wechat-bridge'
$taskManifest = Get-Content -LiteralPath (Join-Path $taskTarget 'installation.json') -Raw | ConvertFrom-Json
if ($taskManifest.owner -ne 'codex-wechat-bridge') { throw 'Managed installation was not found.' }
[IO.File]::WriteAllText((Join-Path $taskTarget 'state\integration-disabled'),'Explicit uninstall',[Text.UTF8Encoding]::new($false))
try { & $taskManifest.node (Join-Path $taskTarget 'src\cli.mjs') shutdown } catch { Write-Output 'The local service is already stopped or unavailable.' }
& (Join-Path $taskTarget 'scripts\service-task.ps1') -Action Remove
$taskPython = (Get-Command python.exe -ErrorAction Stop).Source
& $taskPython (Join-Path $taskTarget 'scripts\manage.py') uninstall --codex-home $CodexHome
if ($LASTEXITCODE -ne 0) { throw 'Uninstall failed. Review the backup before making further changes.' }
Write-Output 'Integration and login startup removed. Encrypted credentials and local evidence were retained.'
