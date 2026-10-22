$ErrorActionPreference = "Stop"

$startupPath = Join-Path $PSScriptRoot "start-subtracker.ps1"
$tokens = $null
$parseErrors = $null
$startupAst = [System.Management.Automation.Language.Parser]::ParseFile($startupPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) {
    throw "Startup script syntax failed: $($parseErrors[0].Message)"
}

foreach ($definition in $startupAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)) {
    Invoke-Expression $definition.Extent.Text
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$MessagePattern)

    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -notmatch $MessagePattern) {
            throw
        }
        return
    }
    throw "Expected failure matching: $MessagePattern"
}

function Get-CimInstance {
    if ($script:processQueryFails) {
        throw "Synthetic process query unavailable"
    }
    return $script:fixtureProcesses
}

function Start-VisiblePowerShellCommand {
    param([string]$Command, [string]$WorkingDirectory)

    if (-not $script:allowSyntheticLaunch) {
        throw "Tests must never start a host or worker."
    }
    $script:launches += [pscustomobject]@{ Command = $Command; WorkingDirectory = $WorkingDirectory }
    return [pscustomobject]@{ Id = 999 }
}

function Wait-ForWorkerProcess {
    param([int]$PowerShellProcessId)
    return ($PowerShellProcessId -eq 999)
}

function Assert-BrcScenario {
    param([string]$Label, [string]$LockText, [object[]]$Processes, [bool]$ExpectLaunch, [bool]$ExpectSuccess = $true)

    [System.IO.File]::WriteAllText($brcLockPath, $LockText)
    $script:fixtureProcesses = $Processes
    $script:launches = @()
    $actualSuccess = Start-OrCheckWorker -Worker $brcWorker
    if ($actualSuccess -ne $ExpectSuccess) {
        throw "$Label returned unexpected success state."
    }
    if ($script:launches.Count -ne [int]$ExpectLaunch) {
        throw "$Label launched an unexpected number of windows."
    }
    if ($ExpectLaunch) {
        if (Test-Path -LiteralPath $brcLockPath) { throw "$Label did not remove the stale lock." }
        if (
            $script:launches[0].WorkingDirectory -ne $brcWorker.Directory -or
            -not $script:launches[0].Command.Contains($brcWorker.StartupScript)
        ) {
            throw "$Label did not use the existing BRC startup script."
        }
    }
    elseif ([System.IO.File]::ReadAllText($brcLockPath) -cne $LockText) {
        throw "$Label changed a protected lock."
    }
    if ([System.IO.File]::ReadAllText($brcSentinelPath) -cne "Keep this file") {
        throw "$Label changed a file other than worker.lock."
    }
    Write-Host "PASS: $Label"
}

$repositoryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("subtracker-startup-tests-" + [guid]::NewGuid().ToString("N"))
$logPath = Join-Path $repositoryRoot ".next\dev\logs\next-development.log"
$lockedLog = $null
try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
    [System.IO.File]::WriteAllText($logPath, "Existing log content")
    Assert-HostOutputWritable
    if ([System.IO.File]::ReadAllText($logPath) -ne "Existing log content") {
        throw "The permission probe changed existing log data."
    }
    if (@(Get-ChildItem -LiteralPath $repositoryRoot -Recurse -Filter ".startup-access-*").Count) {
        throw "The permission probe left temporary files behind."
    }
    Write-Host "PASS: writable generated output; existing log preserved; probes cleaned up"

    [System.IO.File]::SetAttributes($logPath, [System.IO.FileAttributes]::ReadOnly)
    Assert-Throws -Action { Assert-HostOutputWritable } -MessagePattern "Cannot write the existing Next.js log"
    [System.IO.File]::SetAttributes($logPath, [System.IO.FileAttributes]::Normal)
    Write-Host "PASS: unwritable existing log blocks host startup"

    $lockedLog = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    Assert-Throws -Action { Assert-HostOutputWritable } -MessagePattern "Cannot write the existing Next.js log"
    $lockedLog.Dispose()
    $lockedLog = $null
    Write-Host "PASS: exclusively locked log blocks host startup"

    $script:fixtureProcesses = @([pscustomobject]@{
        Name = "node.exe"; ProcessId = 100; ParentProcessId = 90; CommandLine = $null
    })
    Assert-Throws -Action { Get-WorkerProcesses } -MessagePattern "Duplicate-worker checks are unsafe"
    $worker = [pscustomobject]@{
        Name = "NJ PWC Worker"
        Directory = Join-Path $repositoryRoot "worker\nj-pwc"
        StartupScript = Join-Path $repositoryRoot "worker\nj-pwc\start-worker.ps1"
    }
    if (Start-OrCheckWorker -Worker $worker) {
        throw "Unreadable Node process identity must not report successful worker startup."
    }
    Write-Host "PASS: unreadable elevated Node identity fails closed before worker launch"

    $script:fixtureProcesses[0].CommandLine = "node.exe worker.js"
    if (@(Get-WorkerProcesses).Count -ne 1) {
        throw "Readable Node processes were not returned."
    }
    Write-Host "PASS: readable Node identity remains available for duplicate checks"

    $mainTry = @($startupAst.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.TryStatementAst]
    })[-1]
    $hostGuard = @($mainTry.Body.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        $_.Clauses[0].Item1.Extent.Text -eq "Test-HostResponse"
    })[0]
    if (
        -not $hostGuard -or
        $hostGuard.Clauses[1].Item1.Extent.Text -ne "Test-HostPortInUse" -or
        $hostGuard.Clauses[1].Item2.Extent.Text -match "Start-VisiblePowerShellCommand" -or
        $hostGuard.Clauses[1].Item2.Extent.Text -notmatch "Wait-ForHostResponse"
    ) {
        throw "An occupied port must wait for the existing host without launching another."
    }
    Write-Host "PASS: occupied-port branch waits without spawning a duplicate host"

    $brcWorker = [pscustomobject]@{
        Name = "NJ BRC Worker"
        Directory = Join-Path $repositoryRoot "worker\nj-brc"
        StartupScript = Join-Path $repositoryRoot "worker\nj-brc\start-worker.ps1"
    }
    New-Item -ItemType Directory -Path $brcWorker.Directory -Force | Out-Null
    [System.IO.File]::WriteAllText($brcWorker.StartupScript, 'throw "Fixture must not be executed"')
    [System.IO.File]::WriteAllText((Join-Path $brcWorker.Directory "worker.js"), 'throw new Error("Fixture must not be executed");')
    $brcLockPath = Join-Path $brcWorker.Directory "worker.lock"
    $brcSentinelPath = Join-Path $brcWorker.Directory "keep.txt"
    [System.IO.File]::WriteAllText($brcSentinelPath, "Keep this file")
    $script:allowSyntheticLaunch = $true
    $liveLock = '{"pid":4242,"instance_id":"synthetic-instance","started_at":"2026-10-22T12:00:00Z"}'
    $liveProcesses = @([pscustomobject]@{
        Name = "node.exe"; ProcessId = 4242; ParentProcessId = 99
        CommandLine = 'node.exe "' + (Join-Path $brcWorker.Directory "worker.js") + '"'
    })
    Assert-BrcScenario -Label "live verified BRC preserves lock and starts no duplicate" -LockText $liveLock -Processes $liveProcesses -ExpectLaunch $false
    $script:launches = @()
    if (-not (Start-OrCheckWorker -Worker $brcWorker) -or $script:launches.Count -ne 0 -or
        [System.IO.File]::ReadAllText($brcLockPath) -cne $liveLock) {
        throw "Second launch did not preserve the live worker and lock."
    }
    Write-Host "PASS: second launch leaves live BRC and lock untouched"

    $unidentifiedOtherNode = [pscustomobject]@{ Name = "node.exe"; ProcessId = 7777; ParentProcessId = 1; CommandLine = $null }
    Assert-BrcScenario -Label "verified live lock owner remains RUNNING despite unrelated unreadable Node" -LockText $liveLock -Processes @($liveProcesses[0], $unidentifiedOtherNode) -ExpectLaunch $false
    Assert-BrcScenario -Label "dead PID removes only lock and enables BRC startup" -LockText $liveLock -Processes @() -ExpectLaunch $true
    $unrelated = [pscustomobject]@{ Name = "notepad.exe"; ProcessId = 4242; ParentProcessId = 1; CommandLine = "notepad.exe" }
    Assert-BrcScenario -Label "PID reused by unrelated executable enables recovery" -LockText $liveLock -Processes @($unrelated) -ExpectLaunch $true
    $unrelatedNode = [pscustomobject]@{
        Name = "node.exe"; ProcessId = 4242; ParentProcessId = 1
        CommandLine = 'node.exe "' + (Join-Path $repositoryRoot "unrelated\worker.js") + '"'
    }
    Assert-BrcScenario -Label "PID reused by unrelated Node worker is not BRC" -LockText $liveLock -Processes @($unrelatedNode) -ExpectLaunch $true

    foreach ($invalid in @('{invalid', '{}', '{"pid":0}', '{"pid":-1}', '{"pid":"wrong"}',
        '{"pid":1.5}', '{"pid":4294967296}', '{"pid":[4242]}', 'null', '[{"pid":4242}]', '')) {
        if ($null -ne (ConvertTo-BrcLockProcessId -Text $invalid)) {
            throw "An invalid lock was accepted as a usable PID: $invalid"
        }
        Assert-BrcScenario -Label "invalid lock recovery: $invalid" -LockText $invalid -Processes @() -ExpectLaunch $true
    }

    $unreadable = [pscustomobject]@{ Name = "node.exe"; ProcessId = 4242; ParentProcessId = 1; CommandLine = $null }
    Assert-BrcScenario -Label "unreadable live PID preserves lock and blocks startup" -LockText $liveLock -Processes @($unreadable) -ExpectLaunch $false -ExpectSuccess $false
    $ambiguous = [pscustomobject]@{ Name = "node.exe"; ProcessId = 4242; ParentProcessId = 1; CommandLine = "node.exe worker.js" }
    Assert-BrcScenario -Label "ambiguous relative worker path preserves lock" -LockText $liveLock -Processes @($ambiguous) -ExpectLaunch $false -ExpectSuccess $false
    Assert-BrcScenario -Label "malformed lock with possible live owner stays untouched" -LockText '{invalid' -Processes @($ambiguous) -ExpectLaunch $false -ExpectSuccess $false
    Assert-BrcScenario -Label "invalid lock with verified live BRC stays untouched" -LockText '{}' -Processes $liveProcesses -ExpectLaunch $false -ExpectSuccess $false

    $script:processQueryFails = $true
    Assert-BrcScenario -Label "unavailable process query retains lock and blocks startup" -LockText $liveLock -Processes @() -ExpectLaunch $false -ExpectSuccess $false
    $script:processQueryFails = $false

    $busyLock = [System.IO.File]::Open($brcLockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        $script:fixtureProcesses = @()
        $script:launches = @()
        if ((Start-OrCheckWorker -Worker $brcWorker) -or $script:launches.Count -ne 0) {
            throw "An unreadable lock must block BRC startup."
        }
    }
    finally { $busyLock.Dispose() }
    if ([System.IO.File]::ReadAllText($brcLockPath) -cne $liveLock) {
        throw "An unreadable lock was changed."
    }
    Write-Host "PASS: inaccessible/in-progress lock is retained without starting BRC"

    $parentCommand = "& '$($brcWorker.StartupScript)'"
    $wrappedProcesses = @(
        [pscustomobject]@{ Name = "node.exe"; ProcessId = 4242; ParentProcessId = 99; CommandLine = "node.exe worker.js" },
        [pscustomobject]@{
            Name = "powershell.exe"; ProcessId = 99; ParentProcessId = 1
            CommandLine = "powershell.exe -EncodedCommand $(New-EncodedPowerShellCommand $parentCommand)"
        }
    )
    Assert-BrcScenario -Label "launcher parent verifies relative BRC worker.js identity" -LockText $liveLock -Processes $wrappedProcesses -ExpectLaunch $false

    $guard = Open-BrcLockFile -Path $brcLockPath
    try {
        Assert-Throws -Action { [System.IO.File]::WriteAllText($brcLockPath, "{}") } -MessagePattern "another process"
        Assert-Throws -Action { [System.IO.File]::Delete($brcLockPath) } -MessagePattern "another process"
    }
    finally { $guard.Dispose() }
    Write-Host "PASS: verification handle prevents concurrent lock rewrite/replacement"

    $pwcDirectory = Join-Path $repositoryRoot "worker\nj-pwc"
    New-Item -ItemType Directory -Path $pwcDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $pwcDirectory "start-worker.ps1"), 'throw "Fixture must not be executed"')
    [System.IO.File]::WriteAllText((Join-Path $pwcDirectory "worker.js"), 'throw new Error("Fixture must not be executed");')
    [System.IO.File]::WriteAllText($brcLockPath, '{invalid')
    $script:fixtureProcesses = @()
    $script:launches = @()
    if (-not (Start-OrCheckWorker -Worker $worker) -or
        [System.IO.File]::ReadAllText($brcLockPath) -cne '{invalid') {
        throw "The PWC step must leave an invalid BRC lock untouched."
    }
    Write-Host "PASS: PWC step neither recovers nor is blocked by malformed BRC lock"

    $mainText = $mainTry.Body.Extent.Text
    if (
        $mainText.IndexOf('$pwcStarted = Start-OrCheckWorker') -le $hostGuard.Extent.EndOffset - $mainTry.Body.Extent.StartOffset -or
        $mainText.IndexOf('$brcStarted = Start-OrCheckWorker') -le $mainText.IndexOf('$pwcStarted = Start-OrCheckWorker') -or
        $mainText -match 'Resolve-BrcWorkerLock'
    ) {
        throw "BRC recovery must remain inside the BRC step after host readiness and PWC."
    }
    Write-Host "PASS: host readiness -> PWC -> BRC recovery ordering preserved"
}
finally {
    if ($lockedLog) {
        $lockedLog.Dispose()
    }
    if (Test-Path -LiteralPath $logPath) {
        [System.IO.File]::SetAttributes($logPath, [System.IO.FileAttributes]::Normal)
    }
    if (Test-Path -LiteralPath $repositoryRoot) {
        Remove-Item -LiteralPath $repositoryRoot -Recurse -Force
    }
}
