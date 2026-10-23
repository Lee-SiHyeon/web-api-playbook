[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('read', 'write', 'status')]
    [string]$Operation,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9.-]{0,63}$')]
    [string]$Name
)

$ErrorActionPreference = 'Stop'
$pointer = [IntPtr]::Zero
$plain = $null
$secure = $null
$roundTrip = $null
$protected = $null
$temporary = $null
$stage = 'profile'

function Set-CurrentUserAcl([string]$Target, [bool]$Directory) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($Directory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
    }
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($Directory) {
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
    $stage = 'directory'
    $userRoot = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrWhiteSpace($userRoot)) { throw 'STORE_UNAVAILABLE' }
    $directory = Join-Path $userRoot '.config\google-flow-xhr-client\credentials'
    $directoryExisted = [IO.Directory]::Exists($directory)
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    if (-not $directoryExisted) { Set-CurrentUserAcl $directory $true }
    $stage = 'target'
    $target = Join-Path $directory ($Name + '.dpapi')

    if ($Operation -eq 'status') {
        $stage = 'status'
        [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ available = [IO.File]::Exists($target); encryption = 'Windows DPAPI CurrentUser' }))
        exit 0
    }
    if ($Operation -eq 'read') {
        $stage = 'read'
        if (-not [IO.File]::Exists($target)) { exit 0 }
        $protected = [IO.File]::ReadAllText($target, [Text.Encoding]::ASCII)
        $secure = ConvertTo-SecureString -String $protected
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        [Console]::Out.Write($plain)
        exit 0
    }

    $stage = 'write'
    $encoded = [Console]::In.ReadToEnd()
    if ($encoded.Length -gt 180000 -or $encoded -notmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'INVALID_INPUT' }
    $plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    if ([string]::IsNullOrEmpty($plain) -or $plain.Length -gt 131072 -or $plain.Contains([char]0)) { throw 'INVALID_INPUT' }
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    $protected = ConvertFrom-SecureString -SecureString $secure
    $temporary = Join-Path $directory ([Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, $protected, [Text.Encoding]::ASCII)
    Move-Item -LiteralPath $temporary -Destination $target -Force
    $temporary = $null

    $roundTrip = ConvertTo-SecureString -String ([IO.File]::ReadAllText($target, [Text.Encoding]::ASCII))
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($roundTrip)
    $check = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($check -cne $plain) { throw 'READBACK_FAILED' }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $pointer = [IntPtr]::Zero
    $check = $null
    [Console]::Out.WriteLine('{"stored":true,"encryption":"Windows DPAPI CurrentUser","plaintextPersisted":false}')
} catch {
    [Console]::Error.WriteLine('CREDENTIAL_STORE_FAILED:' + $stage)
    exit 1
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($temporary -and [IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    $plain = $null
    $secure = $null
    $roundTrip = $null
    $protected = $null
    $check = $null
}
