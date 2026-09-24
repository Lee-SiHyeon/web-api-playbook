[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Job,
    [Parameter(Mandatory = $true)]
    [string]$Result,
    [int]$ChromeProcessId = 0,
    [long]$ExtensionWindowHandle = 0,
    [ValidateRange(10, 180)]
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$app = Split-Path -Parent $PSScriptRoot
$jobPath = (Resolve-Path -LiteralPath $Job).Path
$resultPath = [IO.Path]::GetFullPath($Result)
$rejectedPath = [regex]::Replace($resultPath, '\.json$', '.rejected.json', 'IgnoreCase')
$jobGatePath = [regex]::Replace($jobPath, '\.json$', '.replay.server.gate.json', 'IgnoreCase')
$resultGatePath = [regex]::Replace($resultPath, '\.json$', '.gate.json', 'IgnoreCase')
$logBase = [regex]::Replace($resultPath, '\.json$', '', 'IgnoreCase')
$stdoutPath = "$logBase.server.out.log"
$stderrPath = "$logBase.server.err.log"

foreach ($target in @($resultPath, $rejectedPath, $jobGatePath, $resultGatePath, $stdoutPath, $stderrPath)) {
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match 'naver-publisher-server\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$arguments = @(
    '.\scripts\naver-publisher-server.mjs',
    "--job=$jobPath",
    "--result=$resultPath",
    "--rejected-result=$rejectedPath",
    "--job-gate=$jobGatePath",
    "--result-gate=$resultGatePath"
)
$server = Start-Process -FilePath 'node.exe' -ArgumentList $arguments -WorkingDirectory $app `
    -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

if (-not ('PublisherReplayWindows' -as [type])) {
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PublisherReplayWindows {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr data);
}
'@
}

try {
    $healthy = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $health = Invoke-WebRequest -Uri 'http://127.0.0.1:48766/health' -UseBasicParsing -TimeoutSec 2
            if ($health.StatusCode -eq 200) { $healthy = $true; break }
        }
        catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $healthy) { throw 'publisher server health check failed' }

    $extensionWindow = if ($ExtensionWindowHandle -gt 0) {
        [IntPtr]$ExtensionWindowHandle
    }
    else {
        $matches = New-Object System.Collections.Generic.List[object]
        $callback = [PublisherReplayWindows+EnumProc]{
            param($handle, $data)
            if (-not [PublisherReplayWindows]::IsWindowVisible($handle)) { return $true }
            [uint32]$processId = 0
            [void][PublisherReplayWindows]::GetWindowThreadProcessId($handle, [ref]$processId)
            if ($ChromeProcessId -gt 0 -and $processId -ne $ChromeProcessId) { return $true }
            $title = New-Object Text.StringBuilder 512
            [void][PublisherReplayWindows]::GetWindowText($handle, $title, $title.Capacity)
            if ($title.ToString() -like '확장 프로그램 - Naver Blog Structured Publisher*') {
                $matches.Add($handle)
            }
            return $true
        }
        [void][PublisherReplayWindows]::EnumWindows($callback, [IntPtr]::Zero)
        if ($matches.Count -gt 0) { [IntPtr]$matches[0] } else { [IntPtr]::Zero }
    }
    if ($extensionWindow -eq [IntPtr]::Zero) { throw 'publisher extension window not found' }

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($extensionWindow)
    $all = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $label = $null
    $reloads = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt $all.Count; $index++) {
        $element = $all.Item($index)
        if ([string]$element.Current.Name -eq 'Naver Blog Structured Publisher') { $label = $element }
        if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
            $element.Current.AutomationId -eq 'dev-reload-button') {
            $reloads.Add($element)
        }
    }
    if (-not $label -or $reloads.Count -eq 0) {
        $extensionTab = $null
        for ($index = 0; $index -lt $all.Count; $index++) {
            $element = $all.Item($index)
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
                [string]$element.Current.Name -like '확장 프로그램 - Naver Blog Structured Publisher*') {
                $extensionTab = $element
                break
            }
        }
        if ($extensionTab) {
            $selection = $null
            if ($extensionTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
                $selection.Select()
                Start-Sleep -Milliseconds 600
                $root = [System.Windows.Automation.AutomationElement]::FromHandle($extensionWindow)
                $all = $root.FindAll(
                    [System.Windows.Automation.TreeScope]::Descendants,
                    [System.Windows.Automation.Condition]::TrueCondition
                )
                $label = $null
                $reloads = New-Object System.Collections.Generic.List[object]
                for ($index = 0; $index -lt $all.Count; $index++) {
                    $element = $all.Item($index)
                    if ([string]$element.Current.Name -eq 'Naver Blog Structured Publisher') { $label = $element }
                    if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                        $element.Current.AutomationId -eq 'dev-reload-button') {
                        $reloads.Add($element)
                    }
                }
            }
        }
    }
    if (-not $label -or $reloads.Count -eq 0) { throw 'publisher extension reload control not found' }
    $labelRect = $label.Current.BoundingRectangle
    $reload = $reloads |
        Sort-Object { [Math]::Abs($_.Current.BoundingRectangle.Left - $labelRect.Left) + [Math]::Abs($_.Current.BoundingRectangle.Top - $labelRect.Top) } |
        Select-Object -First 1
    $invoke = $null
    if (-not $reload.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        throw 'publisher extension reload control not invokable'
    }
    $invoke.Invoke()

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $resultPath) {
            Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8
            exit 0
        }
        if (Test-Path -LiteralPath $rejectedPath) {
            Get-Content -LiteralPath $rejectedPath -Raw -Encoding UTF8
            exit 2
        }
        Start-Sleep -Milliseconds 500
    }

    Write-Host 'REPLAY_TIMEOUT'
    if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8 }
    if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8 }
    exit 3
}
finally {
    if (Get-Process -Id $server.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
}
