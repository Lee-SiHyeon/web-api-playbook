[CmdletBinding()]
param()

chcp 65001 > $null
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host '네이버 자동 로그인 → 블로그 글쓰기 실증' -ForegroundColor Cyan
Write-Host '비밀번호는 이 창에서만 입력되며 파일·명령행에 저장하지 않습니다.'
Write-Host ''

$secure = Read-Host '네이버 비밀번호' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = ''
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $plain | & node '.\scripts\naver-post-pilot.mjs'
    exit $LASTEXITCODE
}
finally {
    $plain = $null
    $secure = $null
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}
