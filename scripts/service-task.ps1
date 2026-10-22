param([ValidateSet('Install','Start','Remove','Status')][string]$Action='Start',[switch]$AtLogon)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'installation.json') -Raw | ConvertFrom-Json
if ($taskManifest.owner -ne 'codex-wechat-bridge') { throw 'Matching managed bridge installation is required.' }
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskName = 'CodexWeChatBridge-' + $taskIdentity.User.Value
$taskShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskRunner = Join-Path $PSScriptRoot 'run-service.ps1'
$taskArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskRunner + '"'
$taskScheduler = New-Object -ComObject 'Schedule.Service'
$taskScheduler.Connect()
$taskFolder = $taskScheduler.GetFolder('\')
$taskExisting = $null
try { $taskExisting = $taskFolder.GetTask($taskName) } catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
if ($null -ne $taskExisting) {
  $taskDefinition = $taskExisting.Definition
  if ($taskDefinition.RegistrationInfo.Description -ne 'Codex personal WeChat bridge service' -or $taskDefinition.Actions.Count -ne 1 -or $taskDefinition.Actions.Item(1).Path -ne $taskShell -or $taskDefinition.Actions.Item(1).Arguments -ne $taskArguments -or $taskDefinition.Principal.LogonType -ne 3 -or $taskDefinition.Principal.RunLevel -ne 0) { throw 'An unrelated or modified task exists; refusing to replace or run it.' }
}
if ($Action -eq 'Install') {
  if ($null -ne $taskExisting) { [IO.File]::WriteAllText((Join-Path $taskManifest.backup 'service-task.xml'), $taskExisting.Xml, [Text.UTF8Encoding]::new($false)) }
  $taskDefinition = $taskScheduler.NewTask(0)
  $taskDefinition.RegistrationInfo.Description = 'Codex personal WeChat bridge service'
  $taskDefinition.Principal.UserId = $taskIdentity.User.Value
  $taskDefinition.Principal.LogonType = 3 # Existing logged-in user token; no password stored.
  $taskDefinition.Principal.RunLevel = 0 # LeastPrivilege; never SYSTEM or elevated.
  $taskDefinition.Settings.Enabled = $true
  $taskDefinition.Settings.AllowDemandStart = $true
  $taskDefinition.Settings.StartWhenAvailable = $true
  $taskDefinition.Settings.MultipleInstances = 2 # IgnoreNew
  $taskDefinition.Settings.DisallowStartIfOnBatteries = $false
  $taskDefinition.Settings.StopIfGoingOnBatteries = $false
  $taskDefinition.Settings.ExecutionTimeLimit = 'PT0S'
  if ($AtLogon) { $taskTrigger=$taskDefinition.Triggers.Create(9);$taskTrigger.UserId=$taskIdentity.User.Value;$taskTrigger.Enabled=$true }
  $taskExec=$taskDefinition.Actions.Create(0);$taskExec.Path=$taskShell;$taskExec.Arguments=$taskArguments;$taskExec.WorkingDirectory=$taskRoot
  $taskExisting = $taskFolder.RegisterTaskDefinition($taskName,$taskDefinition,6,$taskIdentity.User.Value,$null,3,$null)
} elseif ($Action -eq 'Remove') {
  if ($null -ne $taskExisting) { if ($taskExisting.State -eq 4) { $taskExisting.Stop(0) }; $taskFolder.DeleteTask($taskName,0);$taskExisting=$null }
} elseif ($Action -eq 'Start') {
  if ($null -eq $taskExisting) { throw 'Bridge service task is not installed. Run the bridge installer first.' }
  if ($taskExisting.State -ne 4) { $null=$taskExisting.Run($null) }
}
[pscustomobject]@{registered=($null -ne $taskExisting);running=($null -ne $taskExisting -and $taskExisting.State -eq 4);run_level='LeastPrivilege';logon_type='InteractiveToken';password_stored=$false} | ConvertTo-Json -Compress
