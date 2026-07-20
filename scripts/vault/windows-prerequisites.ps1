[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet("Check", "Install")]
  [string]$Action = "Check",

  [ValidateSet("All", "WSL2", "DockerDesktop", "SupabaseCLI", "Deno", "Psql")]
  [string[]]$Components = @("All"),

  [switch]$AcceptInstall,
  [switch]$NoNetworkProbe,
  [switch]$Strict,

  [ValidatePattern("^\d+\.\d+\.\d+$")]
  [string]$SupabaseVersion = "2.109.1",

  [ValidatePattern("^postgres:[A-Za-z0-9._-]+$")]
  [string]$PostgresImage = "postgres:17-alpine"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ToolRoot = Join-Path $env:LOCALAPPDATA "ExcalidrawVaultTools"
$script:SupabaseRoot = Join-Path $script:ToolRoot "supabase-cli"
$script:ToolBin = Join-Path $script:ToolRoot "bin"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

function Get-PendingRebootReasons {
  $reasons = New-Object System.Collections.Generic.List[string]

  $markerPaths = @(
    @{
      Path = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"
      Reason = "Component Based Servicing"
    },
    @{
      Path = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"
      Reason = "Windows Update"
    },
    @{
      Path = "HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName"
      Reason = "Computer rename"
    }
  )

  foreach ($marker in $markerPaths[0..1]) {
    if (Test-Path -LiteralPath $marker.Path) {
      $reasons.Add($marker.Reason)
    }
  }

  $sessionManager =
    "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager"
  try {
    $pendingRenames = (Get-ItemProperty `
        -LiteralPath $sessionManager `
        -Name "PendingFileRenameOperations" `
        -ErrorAction Stop).PendingFileRenameOperations
    if ($null -ne $pendingRenames -and $pendingRenames.Count -gt 0) {
      $reasons.Add("Pending file rename operations")
    }
  } catch {
    # The value normally does not exist. Access failures are reported by the
    # administrator check instead of being treated as a reboot requirement.
  }

  try {
    $activeName = (Get-ItemProperty `
        -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName" `
        -Name "ComputerName" `
        -ErrorAction Stop).ComputerName
    $configuredName = (Get-ItemProperty `
        -LiteralPath $markerPaths[2].Path `
        -Name "ComputerName" `
        -ErrorAction Stop).ComputerName
    if ($activeName -ne $configuredName) {
      $reasons.Add($markerPaths[2].Reason)
    }
  } catch {
    # A name comparison is an additional signal only.
  }

  return @($reasons | Select-Object -Unique)
}

function Get-RequestedComponents {
  if ($Components -contains "All") {
    return @("WSL2", "DockerDesktop", "SupabaseCLI", "Deno", "Psql")
  }
  return @($Components | Select-Object -Unique)
}

function Invoke-CapturedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  try {
    $output = & $Name @Arguments 2>&1
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = (($output | Out-String).Trim())
    }
  } catch {
    return [pscustomobject]@{
      ExitCode = 1
      Output = $_.Exception.Message
    }
  }
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $Name @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

function New-CheckResult {
  param(
    [Parameter(Mandatory = $true)][string]$Component,
    [Parameter(Mandatory = $true)]
    [ValidateSet("Ready", "Missing", "Warning", "Blocked")]
    [string]$Status,
    [Parameter(Mandatory = $true)][string]$Details,
    [string]$NextStep = ""
  )

  return [pscustomobject]@{
    Component = $Component
    Status = $Status
    Details = $Details
    NextStep = $NextStep
  }
}

function Test-NetworkEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url
  )

  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(5)
  try {
    $request = New-Object System.Net.Http.HttpRequestMessage(
      [System.Net.Http.HttpMethod]::Head,
      $Url
    )
    try {
      $response = $client.SendAsync($request).GetAwaiter().GetResult()
      return New-CheckResult `
        "Network:$Name" `
        "Ready" `
        "TLS endpoint responded with HTTP $([int]$response.StatusCode)."
    } finally {
      $request.Dispose()
    }
  } catch {
    return New-CheckResult `
      "Network:$Name" `
      "Warning" `
      "TLS endpoint was not reachable: $($_.Exception.GetBaseException().Message)" `
      "Restore the system proxy/DNS path; the installer never disables TLS validation."
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Test-WSL2 {
  $wsl = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
  if (-not $wsl) {
    return New-CheckResult `
      "WSL2" `
      "Missing" `
      "wsl.exe is unavailable." `
      "Run this script as Administrator with -Action Install -Components WSL2 -AcceptInstall."
  }

  $status = Invoke-CapturedCommand $wsl.Source @("--status")
  if ($status.ExitCode -ne 0) {
    return New-CheckResult `
      "WSL2" `
      "Missing" `
      "WSL is present but not initialized for WSL2." `
      "Install WSL2 explicitly, then reboot if Windows requests it."
  }

  return New-CheckResult "WSL2" "Ready" "wsl.exe --status succeeded."
}

function Test-DockerDesktop {
  $docker = Get-Command "docker.exe" -ErrorAction SilentlyContinue
  $desktopPath = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (-not $docker) {
    if (Test-Path -LiteralPath $desktopPath -PathType Leaf) {
      return New-CheckResult `
        "DockerDesktop" `
        "Warning" `
        "Docker Desktop is installed, but docker.exe is not on PATH." `
        "Restart the terminal after Docker Desktop setup."
    }
    return New-CheckResult `
      "DockerDesktop" `
      "Missing" `
      "Docker Desktop was not detected." `
      "Run this script as Administrator with -Action Install -Components DockerDesktop -AcceptInstall."
  }

  $server = Invoke-CapturedCommand $docker.Source @(
    "version",
    "--format",
    "{{.Server.Version}}"
  )
  if ($server.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($server.Output)) {
    return New-CheckResult `
      "DockerDesktop" `
      "Warning" `
      "Docker CLI is installed, but the Linux container engine is not ready." `
      "Start Docker Desktop and complete its first-run UI."
  }

  return New-CheckResult `
    "DockerDesktop" `
    "Ready" `
    "Docker Linux engine version $($server.Output) is available."
}

function Test-SupabaseCLI {
  $supabase = Get-Command "supabase" -ErrorAction SilentlyContinue
  if (-not $supabase) {
    $npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    $detail = "Supabase CLI was not detected."
    if ($npm) {
      $detail += " npm is available for the supported pinned local installation."
    } else {
      $detail += " Node.js/npm is also missing."
    }
    return New-CheckResult `
      "SupabaseCLI" `
      "Missing" `
      $detail `
      "Use -Action Install -Components SupabaseCLI -AcceptInstall; npm global installation is intentionally unsupported."
  }

  $version = Invoke-CapturedCommand $supabase.Source @("--version")
  if ($version.ExitCode -ne 0) {
    return New-CheckResult `
      "SupabaseCLI" `
      "Warning" `
      "The Supabase command exists but --version failed." `
      "Repair or reinstall the pinned user-local CLI."
  }
  $reportedVersion = [regex]::Match($version.Output, "\d+\.\d+\.\d+").Value
  if (
    -not [string]::IsNullOrWhiteSpace($reportedVersion) -and
    $reportedVersion -ne $SupabaseVersion
  ) {
    return New-CheckResult `
      "SupabaseCLI" `
      "Warning" `
      "Supabase CLI $reportedVersion is available, but this helper pins $SupabaseVersion." `
      "Run the explicit SupabaseCLI install action to restore the pinned user-local version."
  }
  return New-CheckResult `
    "SupabaseCLI" `
    "Ready" `
    "Supabase CLI version $($version.Output) is available."
}

function Test-Deno {
  $deno = Get-Command "deno.exe" -ErrorAction SilentlyContinue
  if (-not $deno) {
    return New-CheckResult `
      "Deno" `
      "Missing" `
      "Deno was not detected." `
      "Run this script as Administrator with -Action Install -Components Deno -AcceptInstall."
  }
  $version = Invoke-CapturedCommand $deno.Source @("--version")
  if ($version.ExitCode -ne 0) {
    return New-CheckResult `
      "Deno" `
      "Warning" `
      "The Deno command exists but --version failed." `
      "Repair Deno before running Edge Function tooling."
  }
  $firstLine = ($version.Output -split "`r?`n")[0]
  return New-CheckResult "Deno" "Ready" $firstLine
}

function Test-Psql {
  $psql = Get-Command "psql" -ErrorAction SilentlyContinue
  if (-not $psql) {
    return New-CheckResult `
      "Psql" `
      "Missing" `
      "psql was not detected." `
      "Use -Action Install -Components Psql -AcceptInstall after Docker Desktop is running."
  }
  $version = Invoke-CapturedCommand $psql.Source @("--version")
  if ($version.ExitCode -ne 0) {
    return New-CheckResult `
      "Psql" `
      "Warning" `
      "The psql command exists but --version failed." `
      "Start Docker Desktop if this is the Vault Docker-backed psql shim."
  }
  return New-CheckResult "Psql" "Ready" $version.Output
}

function Add-UserPathEntry {
  param([Parameter(Mandatory = $true)][string]$Path)

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if (-not [string]::IsNullOrWhiteSpace($userPath)) {
    $entries = @($userPath -split ";" | Where-Object { $_ })
  }
  if ($entries -notcontains $Path) {
    $newPath = (@($Path) + $entries) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  }

  $processEntries = @($env:Path -split ";")
  if ($processEntries -notcontains $Path) {
    $env:Path = "$Path;$env:Path"
  }
}

function Assert-Administrator {
  param([Parameter(Mandatory = $true)][string]$Component)
  if (-not (Test-IsAdministrator)) {
    throw "$Component installation requires an Administrator PowerShell window."
  }
}

function Assert-CommandAvailable {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required installer command is unavailable: $Name"
  }
}

function Install-WSL2 {
  if ((Test-WSL2).Status -eq "Ready") {
    Write-Output "WSL2 is already ready; skipping."
    return
  }
  Assert-Administrator "WSL2"
  if ($PSCmdlet.ShouldProcess("Windows optional features", "Install WSL2 without a distribution")) {
    Invoke-CheckedCommand "wsl.exe" @("--install", "--no-distribution")
    Write-Warning "WSL2 setup may require a reboot. This script will never reboot Windows."
  }
}

function Install-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Component,
    [Parameter(Mandatory = $true)][string]$Id
  )
  Assert-Administrator $Component
  Assert-CommandAvailable "winget.exe"
  if ($PSCmdlet.ShouldProcess($Id, "Install with winget")) {
    Invoke-CheckedCommand "winget.exe" @(
      "install",
      "--exact",
      "--id", $Id,
      "--source", "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity"
    )
  }
}

function Install-SupabaseCLI {
  $npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
  if (-not $npm) {
    throw "Supabase CLI installation requires Node.js and npm on PATH."
  }

  $packageSpec = "supabase@$SupabaseVersion"
  if ($PSCmdlet.ShouldProcess($script:SupabaseRoot, "Install pinned $packageSpec locally")) {
    New-Item -ItemType Directory -Force -Path $script:SupabaseRoot | Out-Null
    Invoke-CheckedCommand $npm.Source @(
      "install",
      "--prefix", $script:SupabaseRoot,
      "--no-audit",
      "--no-fund",
      "--save-exact",
      $packageSpec
    )
    $binPath = Join-Path $script:SupabaseRoot "node_modules\.bin"
    Add-UserPathEntry $binPath
    Write-Output "Installed pinned Supabase CLI $SupabaseVersion in $script:SupabaseRoot."
    Write-Output "A new terminal will inherit the updated user PATH."
  }
}

function Install-DockerPsqlShim {
  $docker = Get-Command "docker.exe" -ErrorAction SilentlyContinue
  if (-not $docker) {
    throw "The Docker-backed psql shim requires Docker Desktop."
  }
  $dockerStatus = Test-DockerDesktop
  if ($dockerStatus.Status -ne "Ready") {
    throw "Start the Docker Desktop Linux engine before installing the psql shim."
  }

  if ($PSCmdlet.ShouldProcess($PostgresImage, "Pull the pinned PostgreSQL client image")) {
    Invoke-CheckedCommand $docker.Source @("pull", $PostgresImage)
  }
  if (-not $PSCmdlet.ShouldProcess($script:ToolBin, "Install the Docker-backed psql user shim")) {
    return
  }

  New-Item -ItemType Directory -Force -Path $script:ToolBin | Out-Null
  $wrapperPath = Join-Path $script:ToolBin "vault-psql.ps1"
  $cmdPath = Join-Path $script:ToolBin "psql.cmd"
  $escapedImage = $PostgresImage.Replace("'", "''")
  $wrapper = @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PsqlArguments)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$image = '__POSTGRES_IMAGE__'

if (-not [string]::IsNullOrWhiteSpace($env:PGHOST)) {
  $isLoopback = $env:PGHOST.Equals(
    "localhost",
    [StringComparison]::OrdinalIgnoreCase
  )
  if (-not $isLoopback) {
    $candidate = $env:PGHOST.Trim("[", "]")
    $address = $null
    if ([Net.IPAddress]::TryParse($candidate, [ref]$address)) {
      $isLoopback = [Net.IPAddress]::IsLoopback($address)
    }
  }
  if ($isLoopback) {
    $env:PGHOST = "host.docker.internal"
  }
}

$dockerArguments = [System.Collections.Generic.List[string]]::new()
@(
  "run", "--rm", "-i",
  "-e", "PGHOST",
  "-e", "PGPORT",
  "-e", "PGUSER",
  "-e", "PGPASSWORD",
  "-e", "PGDATABASE",
  "-e", "PGCONNECT_TIMEOUT",
  "-e", "PGSSLMODE",
  "-e", "PGSSLROOTCERT"
) | ForEach-Object { $dockerArguments.Add($_) }

$rootCertHostPath = $env:PGSSLROOTCERT
if (
  -not [string]::IsNullOrWhiteSpace($rootCertHostPath) -and
  $rootCertHostPath -ne "system"
) {
  if (-not (Test-Path -LiteralPath $rootCertHostPath -PathType Leaf)) {
    throw "PGSSLROOTCERT certificate file does not exist"
  }
  $rootCertHostPath = (Resolve-Path -LiteralPath $rootCertHostPath).Path
  $env:PGSSLROOTCERT = "/vault-ca/root.crt"
  $dockerArguments.Add("--mount")
  $dockerArguments.Add(
    "type=bind,source=$rootCertHostPath,target=/vault-ca/root.crt,readonly"
  )
}

$translatedArguments = [System.Collections.Generic.List[string]]::new()
$fileIndex = 0
foreach ($argument in $PsqlArguments) {
  if ($argument.StartsWith("--file=", [StringComparison]::Ordinal)) {
    $hostFile = $argument.Substring("--file=".Length)
    if (-not (Test-Path -LiteralPath $hostFile -PathType Leaf)) {
      throw "psql SQL file does not exist"
    }
    $resolvedFile = (Resolve-Path -LiteralPath $hostFile).Path
    $containerFile = "/vault-sql/$fileIndex.sql"
    $dockerArguments.Add("--mount")
    $dockerArguments.Add(
      "type=bind,source=$resolvedFile,target=$containerFile,readonly"
    )
    $translatedArguments.Add("--file=$containerFile")
    $fileIndex += 1
  } else {
    $translatedArguments.Add($argument)
  }
}

$dockerArguments.Add($image)
$dockerArguments.Add("psql")
$translatedArguments | ForEach-Object { $dockerArguments.Add($_) }
& docker.exe @($dockerArguments.ToArray())
exit $LASTEXITCODE
'@.Replace("__POSTGRES_IMAGE__", $escapedImage)

  [IO.File]::WriteAllText($wrapperPath, $wrapper, (New-Object Text.UTF8Encoding($false)))
  $cmd = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0vault-psql.ps1`" %*`r`n"
  [IO.File]::WriteAllText($cmdPath, $cmd, (New-Object Text.ASCIIEncoding))
  Add-UserPathEntry $script:ToolBin
  Write-Output "Installed Docker-backed psql shim in $script:ToolBin."
  Write-Output "The shim passes libpq connection fields by environment variable and does not print secrets."
}

function Get-PrerequisiteChecks {
  $requested = Get-RequestedComponents
  $checks = New-Object System.Collections.Generic.List[object]

  $adminStatus = if (Test-IsAdministrator) { "Ready" } else { "Warning" }
  $adminDetail = if ($adminStatus -eq "Ready") {
    "The current PowerShell process is elevated."
  } else {
    "The current PowerShell process is not elevated; system installs will be refused."
  }
  $checks.Add((New-CheckResult "Administrator" $adminStatus $adminDetail))

  $rebootReasons = @(Get-PendingRebootReasons)
  if ($rebootReasons.Count -gt 0) {
    $checks.Add((New-CheckResult `
        "PendingReboot" `
        "Blocked" `
        ($rebootReasons -join ", ") `
        "Save work and reboot Windows manually before installing WSL2 or Docker Desktop."))
  } else {
    $checks.Add((New-CheckResult "PendingReboot" "Ready" "No standard pending reboot marker was found."))
  }

  foreach ($component in $requested) {
    switch ($component) {
      "WSL2" { $checks.Add((Test-WSL2)) }
      "DockerDesktop" { $checks.Add((Test-DockerDesktop)) }
      "SupabaseCLI" { $checks.Add((Test-SupabaseCLI)) }
      "Deno" { $checks.Add((Test-Deno)) }
      "Psql" { $checks.Add((Test-Psql)) }
    }
  }

  if (-not $NoNetworkProbe) {
    if ($requested -contains "WSL2") {
      $checks.Add((Test-NetworkEndpoint "Microsoft" "https://aka.ms/wsl2kernel"))
    }
    if (@($requested | Where-Object { $_ -in @("DockerDesktop", "Deno") }).Count -gt 0) {
      $checks.Add((Test-NetworkEndpoint "Winget" "https://cdn.winget.microsoft.com/cache"))
    }
    if ($requested -contains "SupabaseCLI") {
      $checks.Add((Test-NetworkEndpoint "Npm" "https://registry.npmjs.org/supabase"))
    }
  }

  return $checks.ToArray()
}

function Invoke-PrerequisiteInstall {
  if (-not $AcceptInstall) {
    throw "Installation is disabled by default. Add -AcceptInstall together with -Action Install."
  }
  if ($NoNetworkProbe) {
    throw "-NoNetworkProbe is available only for check-only diagnostics."
  }

  $requested = Get-RequestedComponents
  $pendingReboot = @(Get-PendingRebootReasons)
  $systemComponents = @(
    $requested | Where-Object { $_ -in @("WSL2", "DockerDesktop", "Deno") }
  )
  if ($pendingReboot.Count -gt 0 -and $systemComponents.Count -gt 0) {
    throw "Installation refused while Windows reports a pending reboot: $($pendingReboot -join ', '). This script never reboots automatically."
  }

  $networkChecks = New-Object System.Collections.Generic.List[object]
  if ($requested -contains "WSL2") {
    $networkChecks.Add((Test-NetworkEndpoint "Microsoft" "https://aka.ms/wsl2kernel"))
  }
  if (@($requested | Where-Object { $_ -in @("DockerDesktop", "Deno") }).Count -gt 0) {
    $networkChecks.Add((Test-NetworkEndpoint "Winget" "https://cdn.winget.microsoft.com/cache"))
  }
  if ($requested -contains "SupabaseCLI") {
    $networkChecks.Add((Test-NetworkEndpoint "Npm" "https://registry.npmjs.org/supabase"))
  }
  # The Docker-backed psql shim must use Docker Desktop's configured proxy,
  # which can differ from the host HttpClient/system proxy. The authoritative
  # connectivity check is the pinned `docker pull` inside
  # Install-DockerPsqlShim; probing Docker Hub directly from Windows would
  # incorrectly reject a working Docker Desktop SOCKS/HTTP proxy setup.
  $networkFailures = @($networkChecks | Where-Object { $_.Status -ne "Ready" })
  if ($networkFailures.Count -gt 0) {
    throw "Installation refused because one or more required TLS endpoints are unreachable. Run -Action Check for details."
  }

  foreach ($component in $requested) {
    switch ($component) {
      "WSL2" { Install-WSL2 }
      "DockerDesktop" {
        if ((Test-DockerDesktop).Status -eq "Missing") {
          Install-WingetPackage "Docker Desktop" "Docker.DockerDesktop"
        } else {
          Write-Output "Docker Desktop is already installed; skipping package installation."
        }
      }
      "SupabaseCLI" { Install-SupabaseCLI }
      "Deno" {
        if ((Test-Deno).Status -eq "Missing") {
          Install-WingetPackage "Deno" "DenoLand.Deno"
        } else {
          Write-Output "Deno is already installed; skipping."
        }
      }
      "Psql" { Install-DockerPsqlShim }
    }
  }

  Write-Warning "Installation never starts Docker Desktop, accepts first-run terms, or reboots Windows."
  Write-Output "Open a new terminal and rerun this script with -Action Check."
}

if ($Action -eq "Install") {
  Invoke-PrerequisiteInstall
  exit 0
}

$results = Get-PrerequisiteChecks
$results | Format-Table Component, Status, Details -AutoSize -Wrap

Write-Output ""
Write-Output "Check-only mode completed. No package, feature, PATH, container image, or secret was changed."
if ($NoNetworkProbe) {
  Write-Output "Network probes were explicitly skipped."
}

if ($Strict) {
  $notReady = @($results | Where-Object {
      $_.Component -notlike "Network:*" -and
      $_.Component -ne "Administrator" -and
      $_.Status -ne "Ready"
    })
  if ($notReady.Count -gt 0) {
    exit 2
  }
}
