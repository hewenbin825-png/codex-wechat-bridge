$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskManifest=Get-Content -LiteralPath (Join-Path $taskRoot 'installation.json') -Raw | ConvertFrom-Json
if($taskManifest.owner -ne 'codex-wechat-bridge'){throw 'Matching managed installation is required.'}
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$taskNames=@(('CodexWeChatBridge-'+$taskIdentity.User.Value),('CodexDotErisTunnel-'+$taskIdentity.User.Value))
$taskRemoved=@()
foreach($taskName in $taskNames){
  $item=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if(!$item){continue}
  if($item.Actions.Count -ne 1 -or !$item.Actions[0].Arguments.Contains($taskRoot) -or $item.Principal.UserId -notin @($taskIdentity.User.Value,$taskIdentity.Name,$env:USERNAME) -or $item.Principal.RunLevel.ToString() -ne 'Limited'){throw 'Unexpected startup task ownership or action; no change made to this task.'}
  $backup=Join-Path $taskManifest.backup ($taskName+'-removed.xml')
  Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $backup -Encoding UTF8
  Stop-ScheduledTask -TaskName $taskName
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  $taskRemoved+=$taskName
}
[pscustomobject]@{removed_tasks=$taskRemoved;startup='codex_mcp_only';windows_password_stored=$false}|ConvertTo-Json -Compress
