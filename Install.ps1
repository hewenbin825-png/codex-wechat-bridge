param(
  [string]$CodexHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'),
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$PythonPath = (Get-Command python.exe -ErrorAction Stop).Source,
  [switch]$NoAutostart,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$taskArgs = @((Join-Path $PSScriptRoot 'scripts\manage.py'), 'install', '--codex-home', $CodexHome, '--node', $NodePath)
if (-not $NoAutostart) { $taskArgs += '--autostart' }
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
& (Join-Path $taskTarget 'scripts\service-task.ps1') -Action Install -AtLogon:(!$NoAutostart)
if (-not $NoStart) { & (Join-Path $taskTarget 'start.ps1') }
Write-Output 'Local files installed. Pair WeChat and check hook trust; use Codex /hooks only if review is requested.'
