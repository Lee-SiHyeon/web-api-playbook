param(
  [Parameter(Mandatory=$true)][ValidateSet('set','get')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$Service
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$entropy = [Text.Encoding]::UTF8.GetBytes('affiliate-shopping-session-v1:' + $Service)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Mode -eq 'set') {
  $plain = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($plain)) { throw 'EMPTY_INPUT' }
  $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
  try { $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope) }
  finally { [Array]::Clear($bytes, 0, $bytes.Length); $plain = $null }
  $parent = [IO.Path]::GetDirectoryName($Path)
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
  [IO.File]::WriteAllBytes($temporary, $encrypted)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  [IO.File]::SetAccessControl($temporary, $acl)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
  [Console]::Out.Write('stored')
} else {
  $encrypted = [IO.File]::ReadAllBytes($Path)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $entropy, $scope)
  try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes)) }
  finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}
