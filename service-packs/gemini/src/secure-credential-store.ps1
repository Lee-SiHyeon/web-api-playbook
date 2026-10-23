[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('read', 'write', 'write-new', 'self-test', 'delete', 'status')]
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
$selfTestOwnedTarget = $false
$stage = 'profile'

function Set-CurrentUserAcl([string]$Target, [bool]$Directory) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($Directory) {
        $acl = [IO.Directory]::GetAccessControl($Target, [Security.AccessControl.AccessControlSections]::Access)
    } else {
        $acl = [IO.File]::GetAccessControl($Target, [Security.AccessControl.AccessControlSections]::Access)
    }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
        $acl.RemoveAccessRuleAll($existingRule)
    }
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
    if ($Directory) {
        [IO.Directory]::SetAccessControl($Target, $acl)
    } else {
        [IO.File]::SetAccessControl($Target, $acl)
    }
}

try {
    $stage = 'directory'
    $userRoot = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrWhiteSpace($userRoot)) { throw 'STORE_UNAVAILABLE' }
    $directory = Join-Path $userRoot '.config\gemini-web-xhr-client\credentials'
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    # Always normalize the DACL. A previous run may have created the directory
    # before failing to apply its ACL. Read/write only Access so owner and audit
    # metadata are left untouched and no SACL privileges are needed.
    Set-CurrentUserAcl $directory $true
    $stage = 'target'
    $target = Join-Path $directory ($Name + '.dpapi')

    if ($Operation -eq 'status') {
        if ([IO.File]::Exists($target)) { Set-CurrentUserAcl $target $false }
        [Console]::Out.WriteLine((ConvertTo-Json -Compress @{
            available = [IO.File]::Exists($target)
            encryption = 'Windows DPAPI CurrentUser'
        }))
        exit 0
    }
    if ($Operation -eq 'delete') {
        if ([IO.File]::Exists($target)) {
            Set-CurrentUserAcl $target $false
            [IO.File]::Delete($target)
        }
        [Console]::Out.WriteLine('{"deleted":true}')
        exit 0
    }
    if ($Operation -eq 'self-test' -and [IO.File]::Exists($target)) {
        [Console]::Out.WriteLine((ConvertTo-Json -Compress @{
            performed = $false
            preexistingEntryPreserved = $true
            directoryDaclApplied = $true
            fileDaclApplied = $false
            dpapiRoundTripVerified = $false
            deletionVerified = $false
        }))
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
    if ($encoded.Length -gt 350000 -or $encoded -notmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'INVALID_INPUT' }
    $plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    if ([string]::IsNullOrEmpty($plain) -or $plain.Length -gt 262144 -or $plain.Contains([char]0)) { throw 'INVALID_INPUT' }
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    $protected = ConvertFrom-SecureString -SecureString $secure
    $temporary = Join-Path $directory ([Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, $protected, [Text.Encoding]::ASCII)
    Set-CurrentUserAcl $temporary $false
    if ($Operation -eq 'write-new' -or $Operation -eq 'self-test') {
        # File.Move without overwrite is atomic and protects the self-test from
        # replacing an entry created by another process after the absent check.
        [IO.File]::Move($temporary, $target)
    } else {
        Move-Item -LiteralPath $temporary -Destination $target -Force
    }
    if ($Operation -eq 'self-test') { $selfTestOwnedTarget = $true }
    $temporary = $null
    if ($Operation -eq 'self-test') { Set-CurrentUserAcl $target $false }

    $roundTrip = ConvertTo-SecureString -String ([IO.File]::ReadAllText($target, [Text.Encoding]::ASCII))
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($roundTrip)
    $check = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($check -cne $plain) { throw 'READBACK_FAILED' }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $pointer = [IntPtr]::Zero
    $check = $null
    if ($Operation -eq 'self-test') {
        [IO.File]::Delete($target)
        if ([IO.File]::Exists($target)) { throw 'DELETE_FAILED' }
        $selfTestOwnedTarget = $false
        [Console]::Out.WriteLine((ConvertTo-Json -Compress @{
            performed = $true
            preexistingEntryPreserved = $true
            directoryDaclApplied = $true
            fileDaclApplied = $true
            dpapiRoundTripVerified = $true
            deletionVerified = $true
        }))
        exit 0
    }
    [Console]::Out.WriteLine('{"stored":true,"encryption":"Windows DPAPI CurrentUser","plaintextPersisted":false}')
} catch {
    [Console]::Error.WriteLine('CREDENTIAL_STORE_FAILED:' + $stage)
    exit 1
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($temporary -and [IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    if ($selfTestOwnedTarget -and [IO.File]::Exists($target)) {
        try { [IO.File]::Delete($target) } catch { }
    }
    $plain = $null
    $secure = $null
    $roundTrip = $null
    $protected = $null
    $check = $null
}
