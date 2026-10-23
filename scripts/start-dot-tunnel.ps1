param([string]$TunnelId,[switch]$StoreRuntimeKey,[switch]$StoreRuntimeKeyFromStdin,[switch]$RegisterLogon,[switch]$Watch)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskState=Join-Path $taskRoot 'state\dot'
$taskClient=Join-Path $taskRoot 'tools\tunnel-client.exe'
$taskConfigFile=Join-Path $taskState 'tunnel-connection.json'
$taskKeyFile=Join-Path $taskState 'runtime-key.dpapi'
$null=New-Item -ItemType Directory -Path $taskState -Force
if($StoreRuntimeKey -and $StoreRuntimeKeyFromStdin){throw 'Choose only one private key input method.'}
if($StoreRuntimeKey -or $StoreRuntimeKeyFromStdin){
  if($StoreRuntimeKeyFromStdin){
    $taskPrivateInput=[Console]::In.ReadToEnd().Trim()
    if($taskPrivateInput.Length -lt 20 -or $taskPrivateInput.Length -gt 1024){throw 'No valid runtime key was supplied.'}
    $taskSecureKey=ConvertTo-SecureString $taskPrivateInput -AsPlainText -Force
    $taskPrivateInput=$null
  }else{
    $taskSecureKey=Read-Host 'Paste the restricted Tunnels Read + Use runtime key (hidden)' -AsSecureString
  }
  if($taskSecureKey.Length -lt 20){throw 'No runtime key was stored.'}
  $taskSecureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $taskKeyFile -Encoding UTF8
  $taskSecureKey.Dispose()
  Write-Host 'Runtime key stored with current-user Windows DPAPI. The key is not displayed.'
}
if($TunnelId){
  if($TunnelId -notmatch '^[A-Za-z0-9_:/.-]{5,512}$'){throw 'Use the complete actual tunnel ID from Platform.'}
  @{tunnel_id=$TunnelId;alias='dot-eris-wechat';profile='dot-eris-wechat'} | ConvertTo-Json | Set-Content -LiteralPath $taskConfigFile -Encoding UTF8
}
if(!(Test-Path -LiteralPath $taskConfigFile) -or !(Test-Path -LiteralPath $taskKeyFile)){
  Write-Host 'Dot tunnel awaits its actual tunnel ID and private runtime-key input. No connection was started.'
  exit 0
}
if(!(Test-Path -LiteralPath $taskClient)){throw 'The verified official tunnel-client executable is missing.'}
$taskConfig=Get-Content -LiteralPath $taskConfigFile -Raw | ConvertFrom-Json
$taskNodeConfig=Get-Content -LiteralPath (Join-Path $taskRoot 'installation.json') -Raw | ConvertFrom-Json
$taskNode=$taskNodeConfig.node
if(!$taskNode){throw 'Owned installation.json must contain the installed Node path.'}
function Get-TaskDotRuntime{
  $taskStatusOutput=& $taskClient runtimes status $taskConfig.alias --json
  if($LASTEXITCODE -ne 0){throw 'Managed Dot tunnel status failed.'}
  return ($taskStatusOutput | ConvertFrom-Json)
}
function Connect-TaskDotRuntime{
  $taskSecureKey=ConvertTo-SecureString (Get-Content -LiteralPath $taskKeyFile -Raw).Trim()
  $taskKeyPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureKey)
  $taskPreviousKey=$env:CONTROL_PLANE_API_KEY
  $taskPreviousState=$env:CODEX_WECHAT_STATE
  try{
    $env:CONTROL_PLANE_API_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskKeyPointer)
    $env:CODEX_WECHAT_STATE=Join-Path $taskRoot 'state'
    # The client's command parser treats backslashes as escapes, including on Windows.
    $taskMcpCommand='"'+$taskNode.Replace('\','/')+'" "'+(Join-Path $taskRoot 'src\dot-mcp.mjs').Replace('\','/')+'"'
    $taskConnectOutput=& $taskClient runtimes connect --alias $taskConfig.alias --profile $taskConfig.profile --profile-dir (Join-Path $taskState 'profiles') --tunnel-id $taskConfig.tunnel_id --mcp-command $taskMcpCommand --runtime-api-key 'env:CONTROL_PLANE_API_KEY' --json
    if($LASTEXITCODE -ne 0){throw 'Managed Dot tunnel failed to connect.'}
    $taskStatus=Get-TaskDotRuntime
    if(!$taskStatus.process_running -or !$taskStatus.healthy -or !$taskStatus.ready){throw 'Managed Dot tunnel is not running, healthy, and ready.'}
    return $taskStatus
  }finally{
    $env:CONTROL_PLANE_API_KEY=$taskPreviousKey
    $env:CODEX_WECHAT_STATE=$taskPreviousState
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskKeyPointer)
    $taskSecureKey.Dispose()
  }
}
function Write-TaskDotStatus($taskStatus){
  [ordered]@{alias=$taskConfig.alias;process_running=$taskStatus.process_running;healthy=$taskStatus.healthy;ready=$taskStatus.ready;runtime_state=$taskStatus.runtime_state;tunnel_id=$taskConfig.tunnel_id} | ConvertTo-Json -Compress
}
if(!$Watch){$taskConnected=Connect-TaskDotRuntime;Write-TaskDotStatus $taskConnected}
if($RegisterLogon){
  $taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $taskName='CodexDotErisTunnel-'+$taskIdentity.User.Value
  $taskAction=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Watch') -WorkingDirectory $taskRoot
  $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskIdentity.Name
  $taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskIdentity.User.Value -LogonType Interactive -RunLevel Limited
  $taskSettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Reconnect the owner-only Dot Eris MCP tunnel after interactive logon; no Windows password stored.' -Force | Out-Null
  Write-Host 'Current-user logon startup registered for the Dot tunnel.'
}
if($Watch){
  # Keep the scheduled owner process alive, including after its launcher exits.
  # The official managed alias remains the only tunnel process owner.
  $taskMutex=[Threading.Mutex]::new($false,('Local\CodexDotTunnelWatch-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
  $taskOwnsMutex=$false
  try{
    try{$taskOwnsMutex=$taskMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$taskOwnsMutex=$true}
    if(!$taskOwnsMutex){exit 0}
    $taskLastReady=$false
    for(;;){
      try{
        $taskStatus=Get-TaskDotRuntime
        if(!$taskStatus.process_running -or !$taskStatus.healthy -or !$taskStatus.ready){$taskStatus=Connect-TaskDotRuntime}
        if(!$taskLastReady){Write-TaskDotStatus $taskStatus}
        $taskLastReady=$true
      }catch{
        if($taskLastReady){Write-Output '{"alias":"dot-eris-wechat","ready":false,"runtime_state":"awaiting_recovery"}'}
        $taskLastReady=$false
      }
      Start-Sleep -Seconds 15
    }
  }finally{if($taskOwnsMutex){$taskMutex.ReleaseMutex()};$taskMutex.Dispose()}
}
