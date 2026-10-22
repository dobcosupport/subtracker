[CmdletBinding()]
param(
    [ValidateRange(30, 600)]
    [int]$HostReadinessTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$hostUrl = "http://localhost:3000/"
$hostWindowTitle = "SubTracker Host"
$workerReadinessTimeoutSeconds = 15
$pollIntervalSeconds = 2
$mutex = New-Object System.Threading.Mutex($false, "Local\SubTrackerStartup")
$ownsMutex = $false

function Write-ComponentStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$Message
    )

    $line = "{0,-22} {1}" -f $Name, $Status
    if ($Message) {
        $line += " - $Message"
    }
    Write-Host $line
}

function Test-SubTrackerResponse {
    param([Parameter(Mandatory = $true)][System.Net.HttpWebResponse]$Response)

    try {
        $statusCode = [int]$Response.StatusCode
        if ($statusCode -lt 200 -or $statusCode -ge 500) {
            return $false
        }

        $stream = $Response.GetResponseStream()
        if (-not $stream) {
            return $false
        }

        $buffer = New-Object byte[] 8192
        $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
        $pageStart = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $bytesRead)
        return ($pageStart -match '<title>\s*SubTracker\s*</title>')
    }
    catch [System.Net.WebException] {
        return $false
    }
    finally {
        $Response.Dispose()
    }
}

function Test-HostResponse {
    $request = [System.Net.HttpWebRequest]::Create($hostUrl)
    $request.Method = "GET"
    $request.Timeout = 3000
    $request.ReadWriteTimeout = 3000

    try {
        $response = $request.GetResponse()
    }
    catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if (-not $response) {
            return $false
        }
    }

    return (Test-SubTrackerResponse -Response $response)
}

function Wait-ForHostResponse {
    param([int]$TimeoutSeconds)

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        if (Test-HostResponse) {
            return $true
        }
        Start-Sleep -Seconds $pollIntervalSeconds
    } while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds)

    return $false
}

function Test-HostPortInUse {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return (@($listeners | Where-Object { $_.Port -eq 3000 }).Count -gt 0)
}

function Assert-HostOutputWritable {
    $outputPath = Join-Path $repositoryRoot ".next"
    if (-not (Test-Path -LiteralPath $outputPath -PathType Container)) {
        return
    }

    foreach ($relativePath in @("", "dev", "dev\logs", "dev\cache\turbopack")) {
        $directory = $outputPath
        if ($relativePath) {
            $directory = Join-Path $outputPath $relativePath
        }
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            continue
        }

        $probePath = Join-Path $directory (".startup-access-" + [guid]::NewGuid().ToString("N"))
        try {
            $probe = [System.IO.File]::Open($probePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
            $probe.Dispose()
            [System.IO.File]::Delete($probePath)
        }
        catch {
            throw "Cannot create/delete generated Next.js files in $directory. Repair .next permissions for the current Windows account before starting; do not mix elevated and normal-user hosts."
        }
    }

    $logPath = Join-Path $outputPath "dev\logs\next-development.log"
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        try {
            $log = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
            $log.Dispose()
        }
        catch {
            throw "Cannot write the existing Next.js log at $logPath. Check for another host and repair .next permissions before starting."
        }
    }
}

function ConvertFrom-ProcessCommandLine {
    param([string]$CommandLine)

    if (-not $CommandLine) {
        return ""
    }

    if ($CommandLine -match '(?i)-(?:encodedcommand|e|ec)\s+([A-Za-z0-9+/=]+)') {
        try {
            return [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
        }
        catch [System.FormatException] {
            return $CommandLine
        }
    }

    return $CommandLine
}

function Get-WorkerProcesses {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" |
        Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    if (@($processes | Where-Object { $_.Name -ieq "node.exe" -and -not $_.CommandLine }).Count -gt 0) {
        throw "A Node.js process has an unreadable command line. Duplicate-worker checks are unsafe; check existing elevated processes before starting normal-user workers."
    }
    return $processes
}

function Get-LiveBrcWorkerProcessId {
    param([object[]]$Processes)

    $lockPath = Join-Path $repositoryRoot "worker\nj-brc\worker.lock"
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        return $null
    }

    try {
        $text = Get-Content -LiteralPath $lockPath -Raw
    }
    catch {
        throw "Cannot read the NJ BRC lock for duplicate-worker checks. Verify lock access before starting workers."
    }

    $lockProcessId = ConvertTo-BrcLockProcessId -Text $text
    if ($null -eq $lockProcessId) {
        return $null
    }

    $process = $Processes | Where-Object {
        $_.Name -ieq "node.exe" -and
        [long]$_.ProcessId -eq $lockProcessId -and
        $_.CommandLine -match '(?i)worker\.js(?:\s|["'']|$)'
    } | Select-Object -First 1

    if ($process) {
        return [long]$process.ProcessId
    }

    return $null
}

function ConvertTo-BrcLockProcessId {
    param([string]$Text)

    if (-not $Text.TrimStart().StartsWith("{")) { return $null }
    try {
        $lock = ConvertFrom-Json -InputObject $Text -ErrorAction Stop
    }
    catch [System.ArgumentException] {
        return $null
    }
    $value = $lock.pid
    $number = [uint32]0
    if (
        $lock -isnot [pscustomobject] -or
        $value -is [System.Array] -or
        "$value" -notmatch '^[0-9]+$' -or
        -not [uint32]::TryParse("$value", [ref]$number) -or
        $number -eq 0
    ) {
        return $null
    }
    return [long]$number
}

function Get-BrcProcessIdentity {
    param([object]$Process, [object[]]$Processes)

    if (-not $Process.Name) { return "Unknown" }
    if ($Process.Name -ine "node.exe") { return "Unrelated" }
    if (-not $Process.CommandLine) { return "Unknown" }

    $arguments = @([regex]::Matches($Process.CommandLine, '"[^"]*"|[^\s"]+') |
        ForEach-Object { $_.Value.Trim('"') })
    if ($arguments.Count -lt 2 -or $arguments[1].StartsWith("-")) {
        return "Unknown"
    }

    $entryPoint = $arguments[1].Replace("/", "\")
    $brcScript = Join-Path $repositoryRoot "worker\nj-brc\worker.js"
    if ([System.IO.Path]::IsPathRooted($entryPoint)) {
        if ([System.IO.Path]::GetFullPath($entryPoint) -ieq $brcScript) { return "Brc" }
        return "Unrelated"
    }
    if ($entryPoint -notin @("worker.js", ".\worker.js")) {
        if ([System.IO.Path]::GetFileName($entryPoint) -ieq "worker.js") { return "Unknown" }
        return "Unrelated"
    }

    $parent = $Processes | Where-Object { $_.ProcessId -eq $Process.ParentProcessId } | Select-Object -First 1
    if ($parent.Name -notin @("powershell.exe", "pwsh.exe") -or -not $parent.CommandLine) {
        return "Unknown"
    }
    $parentCommand = (ConvertFrom-ProcessCommandLine $parent.CommandLine).Replace("/", "\")
    foreach ($workerKey in @("nj-brc", "nj-pwc")) {
        $startupScript = Join-Path $repositoryRoot "worker\$workerKey\start-worker.ps1"
        $startupPattern = '(?i)(?:-File\s+|&\s*)["'']?' + [regex]::Escape($startupScript) + '(?:["'']|\s|$)'
        if ($parentCommand -match $startupPattern) {
            if ($workerKey -eq "nj-brc") { return "Brc" }
            return "Unrelated"
        }
    }
    return "Unknown"
}

function Open-BrcLockFile {
    param([string]$Path)

    if (-not ("SubTrackerStartup.BrcLockFile" -as [type])) {
        # Keep the verified file protected from writes/replacement until deletion is committed.
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace SubTrackerStartup {
    public static class BrcLockFile {
        private const uint GenericRead = 0x80000000, DeleteAccess = 0x10000;
        private const uint ShareRead = 1, OpenExisting = 3, NormalAttributes = 0x80;
        private const int FileDispositionInfo = 4;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string name, uint access, uint share, IntPtr security,
            uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle handle, int infoClass, ref byte info, uint size);

        public static FileStream Open(string path) {
            var handle = CreateFile(path, GenericRead | DeleteAccess, ShareRead,
                IntPtr.Zero, OpenExisting, NormalAttributes, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                if (error == 2 || error == 3) return null;
                throw new Win32Exception(error);
            }
            return new FileStream(handle, FileAccess.Read);
        }

        public static void Remove(FileStream stream) {
            byte delete = 1;
            if (!SetFileInformationByHandle(stream.SafeFileHandle, FileDispositionInfo, ref delete, 1))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
'@
    }
    return [SubTrackerStartup.BrcLockFile]::Open($Path)
}

function Resolve-BrcWorkerLock {
    $lockPath = Join-Path $repositoryRoot "worker\nj-brc\worker.lock"
    $lockStream = $null
    $reader = $null
    try {
        $lockStream = Open-BrcLockFile -Path $lockPath
        $lockProcessId = $null
        $reason = "invalid lock"
        if ($lockStream) {
            $reader = New-Object System.IO.StreamReader($lockStream)
            $text = $reader.ReadToEnd()
            $lockProcessId = ConvertTo-BrcLockProcessId -Text $text
        }

        # Query all process types: a reused PID may belong to something other than Node.
        $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
            Select-Object ProcessId, ParentProcessId, Name, CommandLine)
        $owner = @($processes | Where-Object { $null -ne $lockProcessId -and $_.ProcessId -eq $lockProcessId })
        if ($owner.Count -eq 1 -and (Get-BrcProcessIdentity -Process $owner[0] -Processes $processes) -eq "Brc") {
            return $true
        }
        $liveBrc = @()
        foreach ($process in $processes) {
            if (-not $process.Name) {
                throw "Duplicate safety could not be established: Windows returned an incomplete process record. Lock retained; no BRC worker started."
            }
            if ($process.Name -ieq "node.exe" -or ($null -ne $lockProcessId -and $process.ProcessId -eq $lockProcessId)) {
                $identity = Get-BrcProcessIdentity -Process $process -Processes $processes
                if ($identity -eq "Unknown") {
                    throw "Duplicate safety could not be established: Windows process information is insufficient to identify a possible NJ BRC worker. Lock retained; no BRC worker started."
                }
                if ($identity -eq "Brc") { $liveBrc += $process }
            }
        }

        if ($liveBrc.Count -gt 0) {
            if ($lockStream -and ($null -eq $lockProcessId -or $lockProcessId -notin $liveBrc.ProcessId)) {
                throw "A live NJ BRC worker exists but lock ownership is inconsistent. Lock retained; no BRC worker started."
            }
            return $true
        }

        if ($lockStream) {
            if ($null -ne $lockProcessId) {
                if ($owner.Count) { $reason = "PID belongs to an unrelated process" }
                else { $reason = "PID no longer exists" }
            }
            Write-ComponentStatus -Name "NJ BRC Worker" -Status "STALE LOCK" -Message "$reason; removing only worker.lock"
            [SubTrackerStartup.BrcLockFile]::Remove($lockStream)
        }
        return $false
    }
    catch {
        throw "NJ BRC lock recovery failed; duplicate safety could not be established. No BRC worker started. $($_.Exception.Message)"
    }
    finally {
        if ($reader) { $reader.Dispose() }
        elseif ($lockStream) { $lockStream.Dispose() }
    }
}

function Test-WorkerRunning {
    param(
        [Parameter(Mandatory = $true)][object]$Worker,
        [object[]]$Processes
    )

    $brcProcessId = Get-LiveBrcWorkerProcessId -Processes $Processes
    $workerScript = Join-Path $Worker.Directory "worker.js"
    $startupScript = Join-Path $Worker.Directory "start-worker.ps1"

    foreach ($process in $Processes) {
        if ($process.Name -ine "node.exe" -or $process.CommandLine -notmatch '(?i)worker\.js(?:\s|["'']|$)') {
            continue
        }

        if ($process.CommandLine.IndexOf($workerScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }

        $parent = $Processes | Where-Object { [int]$_.ProcessId -eq [int]$process.ParentProcessId } | Select-Object -First 1
        if (-not $parent -or $parent.Name -notin @("powershell.exe", "pwsh.exe")) {
            continue
        }

        $parentCommandLine = ConvertFrom-ProcessCommandLine -CommandLine $parent.CommandLine
        if ($parentCommandLine.IndexOf($startupScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }

        # BRC's lock identifies its Node PID; a relative PWC start script is the remaining worker process.
        if (
            $Worker.Name -eq "NJ PWC Worker" -and
            [int]$process.ProcessId -ne $brcProcessId -and
            $parentCommandLine -match '(?i)-File\s+["'']?(?:\.\\)?start-worker\.ps1(?:["'']|\s|$)'
        ) {
            return $true
        }

        if ($Worker.Name -eq "NJ BRC Worker" -and [int]$process.ProcessId -eq $brcProcessId) {
            return $true
        }
    }

    return $false
}

function New-EncodedPowerShellCommand {
    param([Parameter(Mandatory = $true)][string]$Command)

    return [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
}

function Start-VisiblePowerShellCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    $encodedCommand = New-EncodedPowerShellCommand -Command $Command
    return Start-Process -FilePath $powerShellPath `
        -ArgumentList "-NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand $encodedCommand" `
        -WorkingDirectory $WorkingDirectory `
        -PassThru
}

function Wait-ForWorkerProcess {
    param(
        [Parameter(Mandatory = $true)][int]$PowerShellProcessId
    )

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $processes = @(Get-WorkerProcesses)
        $nodeProcess = $processes | Where-Object {
            $_.Name -ieq "node.exe" -and
            [int]$_.ParentProcessId -eq $PowerShellProcessId -and
            $_.CommandLine -match '(?i)worker\.js(?:\s|["'']|$)'
        } | Select-Object -First 1

        if ($nodeProcess) {
            return $true
        }
        Start-Sleep -Seconds 1
    } while ($timer.Elapsed.TotalSeconds -lt $workerReadinessTimeoutSeconds)

    return $false
}

function Start-OrCheckWorker {
    param([Parameter(Mandatory = $true)][object]$Worker)

    try {
        if ($Worker.Name -eq "NJ BRC Worker") {
            $running = Resolve-BrcWorkerLock
        }
        else {
            $processes = @(Get-WorkerProcesses)
            $running = Test-WorkerRunning -Worker $Worker -Processes $processes
        }
        if ($running) {
            Write-ComponentStatus -Name $Worker.Name -Status "RUNNING" -Message "already running"
            return $true
        }

        if (-not (Test-Path -LiteralPath $Worker.Directory -PathType Container)) {
            throw "Worker directory not found: $($Worker.Directory)"
        }
        if (-not (Test-Path -LiteralPath $Worker.StartupScript -PathType Leaf)) {
            throw "Worker startup script not found: $($Worker.StartupScript)"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $Worker.Directory "worker.js") -PathType Leaf)) {
            throw "Worker entry point not found in: $($Worker.Directory)"
        }
        $escapedScript = $Worker.StartupScript.Replace("'", "''")
        $escapedTitle = $Worker.Name.Replace("'", "''")
        $command = "`$Host.UI.RawUI.WindowTitle = '$escapedTitle'; & '$escapedScript'"
        $window = Start-VisiblePowerShellCommand -Command $command -WorkingDirectory $Worker.Directory

        if (-not (Wait-ForWorkerProcess -PowerShellProcessId $window.Id)) {
            Write-ComponentStatus -Name $Worker.Name -Status "FAILED" -Message "worker process did not start; its PowerShell window remains open"
            return $false
        }

        Write-ComponentStatus -Name $Worker.Name -Status "STARTED"
        return $true
    }
    catch {
        Write-ComponentStatus -Name $Worker.Name -Status "FAILED" -Message $_.Exception.Message
        return $false
    }
}

try {
    try {
        $ownsMutex = $mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }

    if (-not $ownsMutex) {
        Write-Host "SubTracker startup is already in progress; no duplicate windows will be opened."
        exit 0
    }

    if (Test-HostResponse) {
        Write-ComponentStatus -Name $hostWindowTitle -Status "ONLINE" -Message "already responding at $hostUrl"
    }
    elseif (Test-HostPortInUse) {
        Write-ComponentStatus -Name $hostWindowTitle -Status "WAITING" -Message "port 3000 is already occupied; no additional host will be started"
        if (-not (Wait-ForHostResponse -TimeoutSeconds $HostReadinessTimeoutSeconds)) {
            Write-ComponentStatus -Name $hostWindowTitle -Status "FAILED" -Message "the existing listener did not serve SubTracker; neither worker will be started"
            exit 1
        }
        Write-ComponentStatus -Name $hostWindowTitle -Status "ONLINE" -Message "existing host is responding at $hostUrl"
    }
    else {
        $packagePath = Join-Path $repositoryRoot "package.json"
        if (-not (Test-Path -LiteralPath $repositoryRoot -PathType Container)) {
            Write-ComponentStatus -Name $hostWindowTitle -Status "FAILED" -Message "host directory not found: $repositoryRoot"
            exit 1
        }
        if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
            Write-ComponentStatus -Name $hostWindowTitle -Status "FAILED" -Message "host package.json not found: $packagePath"
            exit 1
        }

        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        if (-not $package.scripts.dev) {
            Write-ComponentStatus -Name $hostWindowTitle -Status "FAILED" -Message "package.json does not define the verified npm run dev command"
            exit 1
        }
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            Write-ComponentStatus -Name $hostWindowTitle -Status "FAILED" -Message "npm is not installed or not available on PATH"
            exit 1
        }

        Assert-HostOutputWritable
        $escapedRoot = $repositoryRoot.Replace("'", "''")
        $escapedTitle = $hostWindowTitle.Replace("'", "''")
        $hostCommand = "`$Host.UI.RawUI.WindowTitle = '$escapedTitle'; Set-Location -LiteralPath '$escapedRoot'; npm run dev"
        $null = Start-VisiblePowerShellCommand -Command $hostCommand -WorkingDirectory $repositoryRoot

        if (-not (Wait-ForHostResponse -TimeoutSeconds $HostReadinessTimeoutSeconds)) {
            Write-ComponentStatus -Name $hostWindowTitle -Status "FAILED" -Message "localhost:3000 did not become ready within $HostReadinessTimeoutSeconds seconds; its PowerShell window remains open"
            exit 1
        }

        Write-ComponentStatus -Name $hostWindowTitle -Status "STARTED" -Message "responding at $hostUrl"
    }

    $pwc = [pscustomobject]@{
        Name = "NJ PWC Worker"
        Directory = Join-Path $repositoryRoot "worker\nj-pwc"
        StartupScript = Join-Path $repositoryRoot "worker\nj-pwc\start-worker.ps1"
    }
    $brc = [pscustomobject]@{
        Name = "NJ BRC Worker"
        Directory = Join-Path $repositoryRoot "worker\nj-brc"
        StartupScript = Join-Path $repositoryRoot "worker\nj-brc\start-worker.ps1"
    }

    $pwcStarted = Start-OrCheckWorker -Worker $pwc
    $brcStarted = Start-OrCheckWorker -Worker $brc
    if (-not $pwcStarted -or -not $brcStarted) {
        exit 1
    }

    exit 0
}
catch {
    Write-ComponentStatus -Name "SubTracker startup" -Status "FAILED" -Message $_.Exception.Message
    exit 1
}
finally {
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
