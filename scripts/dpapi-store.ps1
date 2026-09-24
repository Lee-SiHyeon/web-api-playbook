[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('read', 'write', 'status')]
    [string]$Operation,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9.-]{0,63}$')]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Directory
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$stage = 'initialize'
$plainBytes = $null
$protectedBytes = $null
$temporary = $null
$plain = $null

function Set-CurrentUserAcl([string]$Target, [bool]$IsDirectory) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($IsDirectory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
    }
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($IsDirectory) {
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Target -AclObject $acl
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'UNSUPPORTED_PLATFORM' }
    Add-Type -AssemblyName System.Security | Out-Null
    $stage = 'directory'
    $directory = [IO.Path]::GetFullPath($Directory)
    $directoryExisted = [IO.Directory]::Exists($directory)
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $directoryInfo = [IO.DirectoryInfo]::new($directory)
    if (($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'INVALID_DIRECTORY' }
    if (-not $directoryExisted) { Set-CurrentUserAcl $directory $true }
    $target = Join-Path $directory ($Name + '.dpapi')

    if ($Operation -eq 'status') {
        $available = [IO.File]::Exists($target)
        if ($available) {
            $targetInfo = [IO.FileInfo]::new($target)
            if (($targetInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'INVALID_TARGET' }
        }
        [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ available = $available; provider = 'Windows DPAPI CurrentUser'; persistent = $true }))
        exit 0
    }

    if ($Operation -eq 'read') {
        $stage = 'read'
        if (-not [IO.File]::Exists($target)) { exit 0 }
        $targetInfo = [IO.FileInfo]::new($target)
        if (($targetInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $targetInfo.Length -gt 2097152) { throw 'INVALID_TARGET' }
        $protectedText = [IO.File]::ReadAllText($target, [Text.Encoding]::ASCII)
        $protectedBytes = [Convert]::FromBase64String($protectedText)
        $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
            $protectedBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        if ($plainBytes.Length -gt 1048576) { throw 'INVALID_VALUE' }
        $plain = [Text.Encoding]::UTF8.GetString($plainBytes)
        [Console]::Out.Write($plain)
        exit 0
    }

    $stage = 'write'
    $encoded = [Console]::In.ReadToEnd()
    if ($encoded.Length -gt 1400000 -or $encoded -notmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'INVALID_INPUT' }
    $plainBytes = [Convert]::FromBase64String($encoded)
    if ($plainBytes.Length -lt 1 -or $plainBytes.Length -gt 1048576) { throw 'INVALID_INPUT' }
    $plain = [Text.Encoding]::UTF8.GetString($plainBytes)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $protectedText = [Convert]::ToBase64String($protectedBytes)
    $temporary = Join-Path $directory ([Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, $protectedText, [Text.Encoding]::ASCII)
    Set-CurrentUserAcl $temporary $false
    if ([IO.Directory]::Exists($target)) { throw 'INVALID_TARGET' }
    if ([IO.File]::Exists($target)) {
        $targetInfo = [IO.FileInfo]::new($target)
        if (($targetInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'INVALID_TARGET' }
    }
    Move-Item -LiteralPath $temporary -Destination $target -Force | Out-Null
    $temporary = $null

    $stage = 'verify'
    $storedText = [IO.File]::ReadAllText($target, [Text.Encoding]::ASCII)
    $storedBytes = [Convert]::FromBase64String($storedText)
    $roundTripBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $storedBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    try {
        if ([Convert]::ToBase64String($plainBytes) -cne [Convert]::ToBase64String($roundTripBytes)) { throw 'READBACK_FAILED' }
    } finally {
        [Array]::Clear($storedBytes, 0, $storedBytes.Length)
        [Array]::Clear($roundTripBytes, 0, $roundTripBytes.Length)
    }
    [Console]::Out.WriteLine('{"stored":true,"provider":"Windows DPAPI CurrentUser","persistent":true}')
} catch {
    [Console]::Error.WriteLine('PROTECTED_STORE_FAILED:' + $stage)
    exit 1
} finally {
    if ($temporary -and [IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    $plain = $null
}
