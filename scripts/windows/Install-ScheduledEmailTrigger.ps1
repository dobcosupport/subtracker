[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Uri]$Endpoint,
    [Parameter(Mandatory = $true)]
    [Security.SecureString]$Secret,
    [string]$InstallDirectory = (Join-Path $env:ProgramData 'SubTracker\ScheduledEmailTrigger'),
    [string]$TaskName = 'SubTracker Scheduled Email Wakeup'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Install the trigger from an elevated administrator PowerShell.'
}
if ($Endpoint.Scheme -ne 'https' -or $Endpoint.UserInfo -or $Endpoint.Query -or $Endpoint.Fragment) {
    throw 'Use an HTTPS worker endpoint without credentials, query parameters or a fragment.'
}
if ($Secret.Length -lt 32) { throw 'Use a trigger secret of at least 32 characters.' }
if (Test-Path -LiteralPath $InstallDirectory) {
    throw 'Trigger installation directory already exists. Review the existing installation before replacing it.'
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    throw 'The scheduled task already exists. Review it before replacing it.'
}

$directory = New-Item -ItemType Directory -Path $InstallDirectory
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$administrators = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.SetOwner($administrators)
foreach ($sid in @($administrators, $system)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $directory.FullName -AclObject $acl

$pointer = [IntPtr]::Zero
$bytes = $null
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    $bytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
    $protected = [Security.Cryptography.ProtectedData]::Protect(
        $bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    $configurationPath = Join-Path $directory.FullName 'trigger.xml'
    [pscustomobject]@{ Endpoint = $Endpoint.AbsoluteUri; ProtectedSecret = [Convert]::ToBase64String($protected) } |
        Export-Clixml -LiteralPath $configurationPath
}
finally {
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
$launcher = Join-Path $directory.FullName 'Invoke-ScheduledEmailTrigger.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-ScheduledEmailTrigger.ps1') -Destination $launcher
$arguments = '-NoProfile -NonInteractive -File "{0}" -ConfigurationPath "{1}"' -f $launcher, $configurationPath
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 6) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal `
    -Description 'Wakes the protected SubTracker Scheduled Email service. All email policy and delivery state remain in Supabase.'
$task.Settings.Enabled = $false
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Select-Object TaskName, State
Write-Output 'Installed disabled. Verify the server worker gate is OFF before enabling or starting this task.'
