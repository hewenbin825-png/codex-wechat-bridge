$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'installation.json') -Raw | ConvertFrom-Json
if ($taskManifest.owner -ne 'codex-wechat-bridge' -or -not (Test-Path -LiteralPath $taskManifest.node -PathType Leaf)) { throw 'Matching bridge installation is required.' }
$taskState = Join-Path $taskRoot 'state'
function Test-TaskBridgeReady {
  if (!(Test-Path -LiteralPath (Join-Path $taskState 'connection.json')) -or !(Test-Path -LiteralPath (Join-Path $taskState 'control.token'))) { return $false }
  try {
    $taskConnection = Get-Content -LiteralPath (Join-Path $taskState 'connection.json') -Raw | ConvertFrom-Json
    $taskHeaders = @{Authorization=('Bearer '+(Get-Content -LiteralPath (Join-Path $taskState 'control.token') -Raw).Trim())}
    $taskStatusUri = 'http://127.0.0.1:'+ [int]$taskConnection.port + '/api/status'
    $taskStatus = Invoke-RestMethod -Uri $taskStatusUri -Headers $taskHeaders -TimeoutSec 1
    return ($taskStatus.version -eq $taskManifest.version)
  } catch { return $false }
}
if (Test-TaskBridgeReady) { exit 0 }
# The task is a launcher. Return success after the independent service is ready;
# do not leave a console PowerShell waiting for the lifetime of the Node process.
$taskProcess = Start-Process -FilePath $taskManifest.node -ArgumentList @('"' + (Join-Path $taskRoot 'src\service.mjs') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskState 'service.stdout.log') -RedirectStandardError (Join-Path $taskState 'service.stderr.log') -PassThru
for ($taskAttempt=0;$taskAttempt -lt 24;$taskAttempt++) {
  Start-Sleep -Milliseconds 250
  if (Test-TaskBridgeReady) { exit 0 }
  if ($taskProcess.HasExited) { throw 'The bridge service exited before becoming ready.' }
}
throw 'The bridge service did not become ready in time.'
