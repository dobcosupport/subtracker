[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigurationPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Net.Http

function Invoke-SubTrackerWakeup {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    $configuration = Import-Clixml -LiteralPath $Path
    $endpoint = [Uri]$configuration.Endpoint
    if ($endpoint.Scheme -ne 'https' -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment) {
        throw 'Trigger endpoint must be HTTPS without credentials, query parameters or a fragment.'
    }
    $bytes = $null
    $client = $null
    $handler = $null
    $request = $null
    $response = $null
    try {
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [Convert]::FromBase64String($configuration.ProtectedSecret),
            $null,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.AllowAutoRedirect = $false
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(310)
        $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $endpoint)
        $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue(
            'Bearer', [Text.Encoding]::UTF8.GetString($bytes))
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw ('Scheduled Email wake-up failed with HTTP {0}.' -f [int]$response.StatusCode)
        }
        $result = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        foreach ($name in @('claimed', 'sent', 'blocked', 'deferred', 'failed', 'superseded')) {
            if ($null -eq $result.$name -or $result.$name -isnot [ValueType] -or $result.$name -lt 0) {
                throw 'Scheduled Email endpoint returned an invalid wake-up result.'
            }
        }
        if ($null -eq $result.scheduling -or $result.scheduling.automatic_delivery_enabled -isnot [bool] -or
            $result.scheduling.execution_enabled -isnot [bool]) {
            throw 'Scheduled Email endpoint did not report current processing availability.'
        }
        return [ordered]@{
            checked_at = [DateTime]::UtcNow.ToString('o')
            ok = $true
            claimed = $result.claimed
            sent = $result.sent
            blocked = $result.blocked
            deferred = $result.deferred
            failed = $result.failed
            superseded = $result.superseded
            scheduling = $result.scheduling
        }
    }
    finally {
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        if ($response) { $response.Dispose() }
        if ($request) { $request.Dispose() }
        if ($client) { $client.Dispose() }
        if ($handler) { $handler.Dispose() }
    }
}

$resultPath = Join-Path (Split-Path -Parent $ConfigurationPath) 'last-result.json'
$temporaryPath = $resultPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
try {
    $result = Invoke-SubTrackerWakeup -Path $ConfigurationPath
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $resultPath -Force
    exit 0
}
catch {
    # Never log HTTP bodies, headers, decrypted credentials or raw exception details.
    [ordered]@{ checked_at = [DateTime]::UtcNow.ToString('o'); ok = $false
        error = 'Scheduled Email wake-up failed. Check endpoint availability, authentication and server logs.' } |
        ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $resultPath -Force
    Write-Error 'Scheduled Email wake-up failed; see the protected last-result.json and server logs.'
    exit 1
}
