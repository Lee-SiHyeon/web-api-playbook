[CmdletBinding()]
param([string]$OutputPath, [switch]$RememberIdentity, [switch]$RememberSession)
$ErrorActionPreference = 'Stop'
$pointer = [IntPtr]::Zero
$plain = $null
$identityJson = $null
try {
    Write-Host 'Naver login over HTTP (no browser)' -ForegroundColor Cyan
    Write-Host 'Password goes only to the local login process. It is not printed or written to a plaintext file.'
    $loginName = Read-Host 'Naver login ID (the account ID, not the blog address)'
    if ([string]::IsNullOrWhiteSpace($loginName)) { throw 'LOGIN_ID_REQUIRED' }
    $securePassword = Read-Host 'Naver password' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $identityJson = ConvertTo-Json -Compress @{ username = $loginName; password = $plain }
    $startInfo = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
    $startInfo.ArgumentList.Add((Join-Path $PSScriptRoot 'naver-login-cli.mjs'))
    $startInfo.ArgumentList.Add('--identity-stdin')
    $startInfo.ArgumentList.Add('--challenge-codex')
    if ($RememberIdentity) { $startInfo.ArgumentList.Add('--remember-identity') }
    if ($RememberSession) { $startInfo.ArgumentList.Add('--remember-session') }
    if ($OutputPath) { $startInfo.ArgumentList.Add('--output'); $startInfo.ArgumentList.Add($OutputPath) }
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    $process.StandardInput.Write($identityJson)
    $process.StandardInput.Close()
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $pointer = [IntPtr]::Zero
    $plain = $null; $identityJson = $null; $securePassword = $null
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    Write-Host $stdoutTask.Result
    if ($process.ExitCode -ne 0) { Write-Host 'Login was not verified. See the sanitized result above.' -ForegroundColor Yellow }
    else { Write-Host 'Fresh login and protected account read succeeded.' -ForegroundColor Green }
} catch { Write-Host 'LOCAL_LOGIN_INPUT_FAILED' -ForegroundColor Red }
finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $plain = $null; $identityJson = $null; $securePassword = $null
}
Read-Host 'Press Enter to close' | Out-Null
