param([ValidateSet('Install','Start','Remove','Status')][string]$Action='Start',[switch]$AtLogon)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskManifest=Get-Content -LiteralPath (Join-Path $taskRoot 'installation.json') -Raw | ConvertFrom-Json
if($taskManifest.owner -ne 'codex-wechat-bridge'){throw 'Matching managed bridge installation is required.'}
if($Action -eq 'Install' -or $AtLogon){throw 'Windows startup tasks are no longer used. Start Codex to connect the bridge.'}
if($Action -eq 'Start'){& (Join-Path $PSScriptRoot 'run-service.ps1')}
elseif($Action -eq 'Remove'){& (Join-Path $PSScriptRoot 'remove-logon-startup.ps1')}
else{
  $taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $taskRemaining=@(('CodexWeChatBridge-'+$taskSid),('CodexDotErisTunnel-'+$taskSid)) | ForEach-Object {Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue}
  [pscustomobject]@{startup='codex_mcp_only';registered=(@($taskRemaining).Count -gt 0);password_stored=$false}|ConvertTo-Json -Compress
}
