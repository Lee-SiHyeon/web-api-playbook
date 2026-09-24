[CmdletBinding()]
param(
    [string]$Query = '도킹형 보조배터리',
    [ValidateRange(2, 30)]
    [int]$WaitSeconds = 6,
    [switch]$UseCurrentResults
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
if (-not ('CoupangSearchWindow' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CoupangSearchWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
}

$chrome = Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*Coupang Partners*' } |
    Sort-Object StartTime |
    Select-Object -First 1
if (-not $chrome) {
    throw 'A logged-in Coupang Partners Chrome window was not found.'
}

[CoupangSearchWindow]::ShowWindow($chrome.MainWindowHandle, 9) | Out-Null
[CoupangSearchWindow]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500

function Get-RootElement {
    return [System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)
}

if (-not $UseCurrentResults) {
    $root = Get-RootElement
    $all = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $search = $null
    for ($index = 0; $index -lt $all.Count; $index++) {
        $element = $all.Item($index)
        if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { continue }
        $name = [string]$element.Current.Name
        if ($name -eq '찾고 싶은 상품을 검색해보세요!' -or $element.Current.ClassName -eq 'ant-input ant-input-lg') {
            $search = $element
            break
        }
    }
    if (-not $search) { throw 'The Coupang Partners product search input was not found.' }
    $valuePattern = $null
    if (-not $search.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw 'The product search input does not expose a value pattern.'
    }
    $valuePattern.SetValue($Query)
    $search.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Seconds $WaitSeconds
}

$root = Get-RootElement
$groupCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    'product-meta'
)
$textCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text
)
$imageCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Image
)
$groups = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $groupCondition)
if ($groups.Count -eq 0) { throw 'No Coupang product cards were found on the current page.' }
$allImages = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $imageCondition)

$treeWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$products = New-Object System.Collections.Generic.List[object]
for ($cardIndex = 0; $cardIndex -lt $groups.Count; $cardIndex++) {
    $group = $groups.Item($cardIndex)
    $texts = $group.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCondition)
    $values = New-Object System.Collections.Generic.List[string]
    for ($textIndex = 0; $textIndex -lt $texts.Count; $textIndex++) {
        $value = ([string]$texts.Item($textIndex).Current.Name).Trim()
        if ($value) { $values.Add($value) }
    }
    if ($values.Count -eq 0) { continue }

    $title = $values | Where-Object {
        $_ -ne '…' -and $_ -ne '원' -and $_ -notmatch '^\d+(?:,\d{3})*$' -and $_ -notmatch '^\d+%$'
    } | Select-Object -First 1
    if (-not $title) { continue }

    $priceValues = @($values | Where-Object { $_ -match '^\d{1,3}(?:,\d{3})+$' })
    $discountText = $values | Where-Object { $_ -match '^\d+%$' } | Select-Object -First 1
    $listPrice = $null
    $salePrice = $null
    if ($priceValues.Count -ge 2) {
        $listPrice = [int]($priceValues[0] -replace ',', '')
        $salePrice = [int]($priceValues[-1] -replace ',', '')
    } elseif ($priceValues.Count -eq 1) {
        $salePrice = [int]($priceValues[0] -replace ',', '')
    }

    $badgeCount = 0
    $rectangle = $group.Current.BoundingRectangle
    for ($imageIndex = 0; $imageIndex -lt $allImages.Count; $imageIndex++) {
        $image = $allImages.Item($imageIndex)
        if ([string]$image.Current.Name -ne 'badge') { continue }
        $imageRectangle = $image.Current.BoundingRectangle
        $sameCardColumn = $imageRectangle.Left -ge ($rectangle.Left - 5) -and $imageRectangle.Right -le ($rectangle.Right + 10)
        $nearMetadata = $imageRectangle.Top -ge $rectangle.Top -and $imageRectangle.Top -le ($rectangle.Bottom + 50)
        if ($sameCardColumn -and $nearMetadata) { $badgeCount++ }
    }
    $products.Add([pscustomobject]@{
        cardIndex = $cardIndex
        title = [string]$title
        discountPercent = if ($discountText) { [int]($discountText -replace '%', '') } else { $null }
        listPriceKrw = $listPrice
        salePriceKrw = $salePrice
        badgeCount = $badgeCount
        viewport = [ordered]@{
            left = [int]$rectangle.Left
            top = [int]$rectangle.Top
        }
    })
}

$deduped = $products |
    Group-Object { "{0}|{1}" -f $_.title, $_.salePriceKrw } |
    ForEach-Object { $_.Group | Select-Object -First 1 } |
    Sort-Object @{ Expression = 'salePriceKrw'; Ascending = $true }, title

$now = Get-Date
$stamp = $now.ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$project = Split-Path -Parent $PSScriptRoot
$evidenceDirectory = Join-Path $project 'evidence'
$referenceDirectory = Join-Path $project 'references'
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $referenceDirectory -Force | Out-Null
$evidencePath = Join-Path $evidenceDirectory "coupang-product-search-$stamp.json"
$referencePath = Join-Path $referenceDirectory 'coupang-product-search-latest.json'

$record = [ordered]@{
    schemaVersion = 1
    checkedAt = $now.ToUniversalTime().ToString('o')
    query = $Query
    source = 'authenticated_coupang_partners_visible_search_results'
    browserProfile = 'Google Chrome Stable Default'
    productCount = @($deduped).Count
    credentialsPersisted = $false
    cookieValuesCaptured = $false
    sessionTokenValuesCaptured = $false
    products = @($deduped)
}
$json = $record | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($evidencePath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($referencePath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

[pscustomobject]@{
    Completed = $true
    Query = $Query
    ProductCount = @($deduped).Count
    EvidenceFile = Split-Path -Leaf $evidencePath
    ReferenceFile = Split-Path -Leaf $referencePath
    CredentialsPersisted = $false
} | Format-List
