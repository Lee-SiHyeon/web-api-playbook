param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$taskName = 'Affiliate-Toss-Web-Daily-Archive'
$taskDescription = 'Observed Toss Sharelink web XHR only; daily price/stock observations and blocked receipts to the private Drive archive.'
$collectorPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'daily-collect.mjs')).Path
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$timeZone = (Get-TimeZone).Id
if ($timeZone -ne 'Korea Standard Time') { throw 'TOSS_DAILY_TASK_TIMEZONE_UNSUPPORTED' }
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$collectorArgument = '"' + $collectorPath + '"'
if ($existingTask) {
    $actions = @($existingTask.Actions)
    $existingUserId = $existingTask.Principal.UserId
    $existingUserSid = if ($existingUserId -match '^S-1-') { $existingUserId } else {
        ([System.Security.Principal.NTAccount]::new($existingUserId)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    if ($existingTask.Description -ne $taskDescription -or $actions.Count -ne 1 -or
        $actions[0].Execute -ne $nodePath -or $actions[0].Arguments -ne $collectorArgument -or
        $existingUserSid -ne $taskUserSid) { throw 'TOSS_DAILY_TASK_EXISTING_SCOPE_MISMATCH' }
}
if ($Apply -and -not $existingTask) {
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument $collectorArgument -WorkingDirectory $PSScriptRoot
    $triggers = @(
        (New-ScheduledTaskTrigger -Daily -At '08:00'),
        (New-ScheduledTaskTrigger -Daily -At '20:00')
    )
    $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $taskName -Description $taskDescription -Action $action -Trigger $triggers -Principal $principal -Settings $settings | Out-Null
    $existingTask = Get-ScheduledTask -TaskName $taskName
}
$taskInfo = if ($existingTask) { Get-ScheduledTaskInfo -TaskName $taskName } else { $null }
[pscustomobject]@{
    taskName = $taskName
    operation = $(if ($Apply) { 'apply' } else { 'plan' })
    registered = ($null -ne $existingTask)
    state = $(if ($existingTask) { [string]$existingTask.State } else { $null })
    timeZone = $timeZone
    dailyTimes = @('08:00', '20:00')
    interactiveSessionRequired = $true
    officialApiUsed = $false
    nextRunTime = $(if ($taskInfo) { $taskInfo.NextRunTime.ToString('o') } else { $null })
    lastTaskResult = $(if ($taskInfo) { $taskInfo.LastTaskResult } else { $null })
} | ConvertTo-Json -Depth 4
