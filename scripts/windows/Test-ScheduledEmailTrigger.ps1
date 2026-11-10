$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Net.Http
Add-Type -ReferencedAssemblies System.Net.Http -TypeDefinition @'
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
public class SubTrackerSyntheticHandler : HttpMessageHandler {
    public static int Calls;
    public static string Bearer;
    public static int Status = 200;
    public static string Body = "{\"claimed\":0,\"sent\":0,\"blocked\":0,\"deferred\":0,\"failed\":0,\"superseded\":0,\"scheduling\":{\"execution_enabled\":false,\"automatic_delivery_enabled\":true,\"notice\":\"Synthetic disabled worker\"}}";
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        Calls++;
        if (request.RequestUri.Host != "synthetic.invalid" || request.Method != HttpMethod.Get)
            throw new Exception("Unexpected synthetic request");
        Bearer = request.Headers.Authorization.Parameter;
        return Task.FromResult(new HttpResponseMessage((HttpStatusCode)Status) { Content = new StringContent(Body) });
    }
}
'@

$scriptPath = Join-Path $PSScriptRoot 'Invoke-ScheduledEmailTrigger.ps1'
$parseErrors = @()
$tokens = @()
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Launcher parse failed.' }
$function = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-SubTrackerWakeup'
}, $true)
Invoke-Expression $function.Extent.Text
$installer = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'Install-ScheduledEmailTrigger.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer parse failed.' }
$installerText = $installer.Extent.Text
if ($installerText -notmatch '\$task.Settings.Enabled = \$false' -or
    $installerText -notmatch "New-TimeSpan -Minutes 1" -or
    $installerText -notmatch "MultipleInstances IgnoreNew" -or
    $installerText -notmatch "LogonType ServiceAccount" -or
    $installerText -notmatch 'SetAccessRuleProtection\(\$true, \$false\)') {
    throw 'Task must install disabled with a one-minute trigger, no overlapping launcher and protected storage.'
}
$actionAssignment = $installer.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$arguments'
}, $true)
if ($actionAssignment.Count -ne 1 -or $actionAssignment[0].Extent.Text -match 'Secret|Bearer|Token') {
    throw 'Task arguments must not contain a secret.'
}

function New-Object {
    param([string]$TypeName, [object[]]$ArgumentList)
    if ($TypeName -eq 'System.Net.Http.HttpClientHandler') {
        $handler = [SubTrackerSyntheticHandler]::new()
        $handler | Add-Member -NotePropertyName AllowAutoRedirect -NotePropertyValue $false
        return $handler
    }
    return Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
}

$directory = Join-Path ([IO.Path]::GetTempPath()) ('SubTrackerTriggerTest-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $directory)
$configurationPath = Join-Path $directory 'synthetic.xml'
$secret = 'synthetic-only-no-real-endpoint-or-provider'
$bytes = [Text.Encoding]::UTF8.GetBytes($secret)
try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
        $bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    [pscustomobject]@{ Endpoint = 'https://synthetic.invalid/api/cron/scheduled-email'
        ProtectedSecret = [Convert]::ToBase64String($protected) } | Export-Clixml -LiteralPath $configurationPath
    $result = Invoke-SubTrackerWakeup -Path $configurationPath
    if (-not $result.ok -or $result.claimed -ne 0 -or $result.scheduling.execution_enabled -ne $false -or
        [SubTrackerSyntheticHandler]::Calls -ne 1 -or [SubTrackerSyntheticHandler]::Bearer -cne $secret) {
        throw 'Authenticated one-shot wakeup failed.'
    }
    if (($result | ConvertTo-Json -Depth 5) -match $secret) { throw 'Result exposed a credential.' }
    [SubTrackerSyntheticHandler]::Status = 302
    $rejected = $false
    try { Invoke-SubTrackerWakeup -Path $configurationPath | Out-Null }
    catch { $rejected = $_.Exception.Message -match 'HTTP 302' }
    if (-not $rejected -or [SubTrackerSyntheticHandler]::Calls -ne 2) { throw 'Redirect must fail with no retry.' }
    [SubTrackerSyntheticHandler]::Status = 401
    $rejected = $false
    try { Invoke-SubTrackerWakeup -Path $configurationPath | Out-Null }
    catch { $rejected = $_.Exception.Message -match 'HTTP 401' }
    if (-not $rejected -or [SubTrackerSyntheticHandler]::Calls -ne 3) { throw 'Authentication failure must not retry.' }
    [SubTrackerSyntheticHandler]::Status = 200
    [SubTrackerSyntheticHandler]::Body = '{}'
    $rejected = $false
    try { Invoke-SubTrackerWakeup -Path $configurationPath | Out-Null }
    catch { $rejected = $_.Exception.Message -match 'invalid wake-up result' }
    if (-not $rejected) { throw 'Invalid result must fail.' }
    [pscustomobject]@{ Endpoint = 'http://synthetic.invalid'; ProtectedSecret = [Convert]::ToBase64String($protected) } |
        Export-Clixml -LiteralPath $configurationPath
    $before = [SubTrackerSyntheticHandler]::Calls
    $rejected = $false
    try { Invoke-SubTrackerWakeup -Path $configurationPath | Out-Null }
    catch { $rejected = $_.Exception.Message -match 'must be HTTPS' }
    if (-not $rejected -or [SubTrackerSyntheticHandler]::Calls -ne $before) { throw 'Insecure endpoint must fail before HTTP.' }
    Write-Output 'PASS: DPAPI roundtrip, single authenticated HTTPS invocation, sanitized aggregate/status output, no redirect/retry, invalid response rejection, disabled task defaults and credential-free arguments. All HTTP mocked; no task registered or email sent.'
}
finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    Remove-Item -LiteralPath $configurationPath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $directory
}
