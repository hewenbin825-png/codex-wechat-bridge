param([ValidateSet('Protect','Unprotect')][string]$Action)
$ErrorActionPreference = 'Stop'
try {
    if ($PSVersionTable.PSVersion.Major -le 5) {
        $null = [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
    }
    $taskReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
    $taskValue = $taskReader.ReadToEnd().Trim()
    if ($Action -eq 'Protect') {
        $taskPlain = [Text.UTF8Encoding]::new($false).GetBytes($taskValue)
        $taskCipher = [Security.Cryptography.ProtectedData]::Protect($taskPlain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $taskOutput = [Convert]::ToBase64String($taskCipher)
        [Array]::Clear($taskPlain, 0, $taskPlain.Length)
    } else {
        $taskCipher = [Convert]::FromBase64String($taskValue)
        $taskPlain = [Security.Cryptography.ProtectedData]::Unprotect($taskCipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $taskOutput = [Text.UTF8Encoding]::new($false).GetString($taskPlain)
        [Array]::Clear($taskPlain, 0, $taskPlain.Length)
    }
    $taskBytes = [Text.UTF8Encoding]::new($false).GetBytes($taskOutput)
    [Console]::OpenStandardOutput().Write($taskBytes, 0, $taskBytes.Length)
} catch { [Console]::Error.Write(('Credential vault failed; type={0}; hr={1}; line={2}' -f $_.Exception.GetType().Name,$_.Exception.HResult,$_.InvocationInfo.ScriptLineNumber)); exit 1 }
