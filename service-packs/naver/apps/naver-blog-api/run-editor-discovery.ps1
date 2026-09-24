[CmdletBinding()]
param(
    [switch]$Help,
    [ValidateRange(1, 50)]
    [int]$MaxDocuments = 12
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Set-Location -LiteralPath $PSScriptRoot

try {
    $Host.UI.RawUI.WindowTitle = 'Naver Blog API - Read-only editor discovery'
} catch {
    # Some non-console hosts do not expose a mutable title. The workflow is unchanged.
}

if ($Help) {
    & npm run discover:editor-read -- --help
    exit $LASTEXITCODE
}

& node -e "const fs=require('node:fs'); import('playwright').then(({chromium})=>process.exit(fs.existsSync(chromium.executablePath())?0:2)).catch(()=>process.exit(2))"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Playwright Chromium이 없어 한 번만 설치합니다.' -ForegroundColor Yellow
    & npm run setup:browser
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Playwright Chromium 설치에 실패했습니다.' -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host '네이버 블로그 편집기 읽기 전용 탐색을 시작합니다.' -ForegroundColor Cyan
Write-Host '잠시 후 열리는 임시 브라우저에서 직접 로그인하세요.'
Write-Host '이 PowerShell과 프로그램은 비밀번호를 입력받거나 저장하지 않습니다.'
Write-Host '게시·수정·삭제·업로드·설정 변경 요청은 실행하지 않습니다.'
Write-Host ''

& npm run discover:editor-read -- "--max-documents=$MaxDocuments"
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
    Write-Host '읽기 전용 탐색 프로세스가 종료되었습니다.' -ForegroundColor Green
} else {
    Write-Host "탐색이 안전하게 중단되었습니다. 종료 코드: $code" -ForegroundColor Yellow
}
exit $code
