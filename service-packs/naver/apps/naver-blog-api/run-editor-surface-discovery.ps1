[CmdletBinding()]
param(
    [switch]$Help,
    [ValidateRange(1, 60)]
    [int]$MaxDocuments = 30
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Set-Location -LiteralPath $PSScriptRoot

if ($Help) {
    & npm run discover:editor-surface -- --help
    exit $LASTEXITCODE
}

& node -e "const fs=require('node:fs'); import('playwright').then(({chromium})=>process.exit(fs.existsSync(chromium.executablePath())?0:2)).catch(()=>process.exit(2))"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Playwright Chromium이 없어 한 번만 설치합니다.' -ForegroundColor Yellow
    & npm run setup:browser
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host '네이버 블로그 글쓰기 편집기 표면을 GET 전용으로 탐색합니다.' -ForegroundColor Cyan
Write-Host '임시 브라우저에서 직접 로그인하세요. 프로그램은 비밀번호를 받거나 저장하지 않습니다.'
Write-Host '게시·수정·삭제·업로드·임시저장·자동저장 요청은 전송하지 않습니다.'
Write-Host ''

& npm run discover:editor-surface -- "--max-documents=$MaxDocuments"
$code = $LASTEXITCODE
Write-Host ''
if ($code -eq 0) {
    Write-Host '편집기 GET 전용 탐색이 완료되었습니다.' -ForegroundColor Green
    Write-Host '공개 스크립트 분석과 계약 후보 정규화를 이어서 실행합니다.' -ForegroundColor Cyan
    & npm run analyze:editor-scripts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & npm run build:editor-contracts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host '편집기 후보 카탈로그 갱신이 완료되었습니다.' -ForegroundColor Green
} else {
    Write-Host "탐색이 안전하게 중단되었습니다. 종료 코드: $code" -ForegroundColor Yellow
}
exit $code
