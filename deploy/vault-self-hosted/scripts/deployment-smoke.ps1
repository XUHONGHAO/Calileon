[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AppOrigin,
  [string]$HttpOrigin,
  [string]$PersistenceCapabilitiesUrl,
  [switch]$AllowUntrustedCertificate
)

$ErrorActionPreference = "Stop"
$curl = Get-Command curl.exe -ErrorAction Stop
$tlsArgs = @()
if ($AllowUntrustedCertificate) {
  $tlsArgs += "--insecure"
}

function Invoke-Curl([string[]]$Arguments) {
  $output = & $curl.Source @tlsArgs --silent --show-error --fail @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "HTTP smoke request failed"
  }
  return $output
}

$nullDevice = if ($env:OS -eq "Windows_NT") { "NUL" } else { "/dev/null" }
$headers = (Invoke-Curl @("--dump-header", "-", "--output", $nullDevice, "$AppOrigin/")) -join "`n"
foreach ($requiredHeader in @(
  "content-security-policy:",
  "x-content-type-options:",
  "permissions-policy:"
)) {
  if (-not ($headers -match [regex]::Escape($requiredHeader))) {
    throw "Missing security response header: $requiredHeader"
  }
}
if (-not $AllowUntrustedCertificate -and -not ($headers -match "strict-transport-security:")) {
  throw "Missing HSTS on production HTTPS response"
}

$html = (Invoke-Curl @("$AppOrigin/")) -join "`n"
foreach ($forbiddenHost in @(
  "simpleanalyticscdn.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "nyc3.cdn.digitaloceanspaces.com",
  "app.excalidraw.com"
)) {
  if ($html.Contains($forbiddenHost)) {
    throw "Self-hosted App contains automatic external egress: $forbiddenHost"
  }
}

$roomDocument = ((Invoke-Curl @("$AppOrigin/vault/capabilities")) -join "`n") | ConvertFrom-Json
if (
  $roomDocument.deploymentVersion -ne "p4a-f4-v1" -or
  $roomDocument.roomServerVersion -ne 1 -or
  1 -notin $roomDocument.protocolVersions
) {
  throw "Room capability document is incompatible"
}

$socketOpen = (Invoke-Curl @("$AppOrigin/socket.io/?EIO=4&transport=polling")) -join "`n"
if (-not ($socketOpen -match '^0\{')) {
  throw "Socket.IO polling handshake failed"
}

$attackerHeaders = (Invoke-Curl @(
  "--header", "Origin: https://attacker.example",
  "--dump-header", "-",
  "--output", $nullDevice,
  "$AppOrigin/vault/capabilities"
)) -join "`n"
if ($attackerHeaders -match "access-control-allow-origin:") {
  throw "Room capability endpoint accepted an origin outside the allowlist"
}

if ($PersistenceCapabilitiesUrl) {
  $persistenceDocument = ((Invoke-Curl @($PersistenceCapabilitiesUrl)) -join "`n") | ConvertFrom-Json
  if (
    $persistenceDocument.deploymentVersion -ne "p4a-f4-v1" -or
    $persistenceDocument.schemaVersion -ne 1 -or
    $persistenceDocument.enabled -ne $true -or
    1 -notin $persistenceDocument.protocolVersions
  ) {
    throw "Persistence capability document is incompatible or unavailable"
  }
}

if ($HttpOrigin) {
  $redirectHeaders = (& $curl.Source --silent --show-error --head --max-redirs 0 "$HttpOrigin/") -join "`n"
  if ($LASTEXITCODE -ne 0 -or $redirectHeaders -notmatch "HTTP/\S+ 30[18]" -or $redirectHeaders -notmatch "location: https://") {
    throw "Plain HTTP did not redirect to HTTPS"
  }
}

Write-Output "HTTPS/security headers, no automatic external egress, origin rejection, capability contracts, and Socket.IO handshake passed."
