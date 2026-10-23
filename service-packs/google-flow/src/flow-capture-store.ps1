[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference='Stop'
$plain=$null
$stage='scope'
try {
  $root=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'affiliate-content-operations\flow-captures'))
  $resolved=[IO.Path]::GetFullPath($Target)
  if(-not $resolved.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($resolved) -ne '.dpapi') {throw 'SCOPE'}
  $encoded=[Console]::In.ReadToEnd()
  $stage='input'
  if($encoded.Length -gt 12000000 -or $encoded -notmatch '^[A-Za-z0-9+/]*={0,2}$') {throw 'INPUT'}
  $plain=[Convert]::FromBase64String($encoded)
  $stage='protect'
  Add-Type -AssemblyName System.Security
  $protected=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $dir=[IO.Path]::GetDirectoryName($resolved)
  $stage='directory'
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $stage='acl'
  $acl.SetAccessRuleProtection($true,$false)
  $stage='acl_identity'
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $stage='acl_rule'
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  $stage='acl_write'
  $aclApplied=$false
  try { Set-Acl -LiteralPath $dir -AclObject $acl; $aclApplied=$true }
  catch [Security.AccessControl.PrivilegeNotHeldException] {
    # Preserve the existing directory ACL; DPAPI ciphertext remains CurrentUser-bound.
    # Restricted process tokens may lack SeRestorePrivilege even in the user's own directory.
    $aclApplied=$false
  }
  $stage='file'
  $stream=[IO.File]::Open($resolved,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$stream.Write($protected,0,$protected.Length);$stream.Flush($true)} finally {$stream.Dispose()}
  [Console]::Out.Write((ConvertTo-Json -Compress @{stored=$true;plaintextPersisted=$false;aclApplied=$aclApplied;encryption='Windows DPAPI CurrentUser'}))
} catch {
  [Console]::Error.Write('FLOW_CAPTURE_PROTECTED_STORE_FAILED:'+ $stage + ':' + $_.Exception.GetType().Name)
  exit 1
} finally {
  if($plain){[Array]::Clear($plain,0,$plain.Length)}
  $encoded=$null
  $protected=$null
}
