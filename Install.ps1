param(
  [string]$CodexHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'),
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$PythonPath = (Get-Command python.exe -ErrorAction Stop).Source,
  [switch]$NoAutostart,
  [switch]$NoStart,
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
$taskArgs = @((Join-Path $PSScriptRoot 'scripts\manage.py'), 'install', '--codex-home', $CodexHome, '--node', $NodePath)
& $PythonPath @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Installation failed. The existing notification route was not replaced.' }
$taskTarget = Join-Path $CodexHome 'codex-wechat-bridge'
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$taskAcl = Get-Acl -LiteralPath $taskTarget
$taskRules = @($taskAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$taskExpected = @($taskIdentity.Value, 'S-1-5-18')
$taskAclCorrect = $taskAcl.AreAccessRulesProtected -and $taskRules.Count -eq 2
foreach ($taskRule in $taskRules) {
  if ($taskRule.IdentityReference.Value -notin $taskExpected -or $taskRule.AccessControlType -ne 'Allow' -or $taskRule.FileSystemRights -ne 'FullControl' -or $taskRule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit') { $taskAclCorrect = $false }
}
if (-not $taskAclCorrect) {
  $taskAcl.SetAccessRuleProtection($true, $false)
  foreach ($taskRule in @($taskAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $taskAcl.RemoveAccessRuleAll($taskRule) }
  foreach ($taskSid in @($taskIdentity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $taskRule = [Security.AccessControl.FileSystemAccessRule]::new($taskSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $taskAcl.AddAccessRule($taskRule)
  }
  Set-Acl -LiteralPath $taskTarget -AclObject $taskAcl
}
& (Join-Path $taskTarget 'scripts\remove-logon-startup.ps1')
if ($StartNow -and -not $NoStart) { & (Join-Path $taskTarget 'start.ps1') }
Write-Output 'Installed without Windows startup tasks. Start Codex to connect in the background. New chats use original Codex questions until explicitly opted in.'
