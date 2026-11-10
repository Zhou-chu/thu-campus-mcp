param([ValidateSet('start','stop','status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCli = Join-Path $taskRoot 'bin\thu-campus.mjs'
$taskStateDir = Join-Path $taskRoot '.local\madmodel-service'
$taskStateFile = Join-Path $taskStateDir 'process.json'
$taskNode = Join-Path $taskRoot '.runtime\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node.exe).Source }
$taskRecord = $null
$taskProcess = $null
if (Test-Path -LiteralPath $taskStateFile) {
    $taskRecord = [IO.File]::ReadAllText($taskStateFile) | ConvertFrom-Json
    $taskProcess = Get-Process -Id $taskRecord.processId -ErrorAction SilentlyContinue
    if ($taskProcess) {
        $taskDetails = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $taskRecord.processId)
        if ($taskProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $taskRecord.startedTicks -or
            $taskDetails.ExecutablePath -ne $taskNode -or
            -not $taskDetails.CommandLine.Contains($taskCli) -or
            -not $taskDetails.CommandLine.Contains('madmodel serve')) {
            throw 'PID ownership check failed; no process was stopped or started.'
        }
    }
}
if ($Action -eq 'stop') {
    if ($taskProcess) { Stop-Process -Id $taskProcess.Id; $taskProcess.WaitForExit() }
    if (Test-Path -LiteralPath $taskStateFile) { Remove-Item -LiteralPath $taskStateFile }
    @{ running = $false; stopped = $true } | ConvertTo-Json -Compress
    exit 0
}
if ($Action -eq 'start' -and -not $taskProcess) {
    [IO.Directory]::CreateDirectory($taskStateDir) | Out-Null
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskCli + '"'), 'madmodel', 'serve') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskStateDir 'stdout.log') -RedirectStandardError (Join-Path $taskStateDir 'stderr.log')
    Start-Sleep -Milliseconds 1500
    if ($taskProcess.HasExited) { throw 'MadModel service exited; inspect .local\madmodel-service\stderr.log.' }
    $taskRecord = @{ processId = $taskProcess.Id; startedTicks = $taskProcess.StartTime.ToUniversalTime().Ticks.ToString() }
    [IO.File]::WriteAllText($taskStateFile, ($taskRecord | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
}
@{ running = [bool]$taskProcess; processId = $(if ($taskProcess) { $taskProcess.Id } else { $null }); logs = $taskStateDir } | ConvertTo-Json -Compress
